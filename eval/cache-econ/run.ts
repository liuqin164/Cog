#!/usr/bin/env bun
/**
 * #259 C4 — cache economics of three fold strategies.
 *
 *   bun eval/cache-econ/run.ts
 *
 * The same four sessions run through three arms on one model route:
 *
 *   no_fold    the whole ledger is resent each turn.
 *   per_turn   one more old pair is folded into the digest every turn.
 *   boundary   old pairs are folded in a batch only at turn boundaries.
 *
 * The ledger is fixed (scripted assistant replies), so the arms differ only in
 * the projection. The folded arms expose `read_memory`; the final question is
 * scored by the #254 checker. Cost uses the provider's own prompt/cache fields:
 * cache miss at the prompt price, cache hit at the cache-read price. No product
 * code is touched and no database is opened.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseUsage } from '../../shell/src/plugins/mg-provider.ts';
import { classify } from '../fold-drill/check.ts';
import { PAIR_COUNT, SESSIONS, scoringTask, validateSessions } from './corpus.ts';
import type {
  Arm,
  ArmSummary,
  CallRecord,
  Pair,
  Pricing,
  Session,
  SessionResult,
  TurnRecord,
  Usage,
} from './types.ts';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3425/v1';
const DEFAULT_MODEL = 'auto/deepseek-v4.1-flash';
const MAX_MODEL_CALLS = 3;
const MAX_TOKENS = 96;
const REQUEST_TIMEOUT_MS = 300_000;
const ARMS: Arm[] = ['no_fold', 'per_turn', 'boundary'];

const baseUrl = resolveBaseUrl(process.env.MG_BASE_URL ?? argument('base-url') ?? DEFAULT_BASE_URL);
const model = argument('model') ?? process.env.MG_MODEL ?? DEFAULT_MODEL;
const apiKey = process.env.MG_API_KEY ?? 'magpie';
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const window = Number(argument('window') ?? 6);
const batch = Number(argument('batch') ?? 6);
const limit = Number(argument('sessions') ?? SESSIONS.length);
const dryRun = process.argv.includes('--dry-run');
const reportOnly = process.argv.includes('--report-only');

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatReply {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage?: unknown;
  latencyMs: number;
}

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read_memory',
    description:
      'Read the original ledger text behind one folded digest entry. The key is the entryId shown in the digest, for example digest:c01-number-p02.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The digest entryId of the folded pair.' },
      },
      required: ['key'],
    },
  },
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function resolveBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function systemPrompt(session: Session, arm: Arm): string {
  const base =
    '你是受测助手。你在参加一场多轮工作会话。对每一轮记录，只回复「收到」；如果用户提出明确问题，只依据给出的记录回答，不要使用记录之外的知识，不要猜测，最后只输出一行：答案：<值>。';
  // The session+arm tag keeps one arm's prefix from warming another arm's cache.
  const tag = `[session: ${session.id}; arm: ${arm}]`;
  if (arm === 'no_fold') return `${tag}\n${base}\n记录是完整的，不需要读取任何外部内容。`;
  return `${tag}\n${base}\n较早的细节被折叠成了 digest 存根。每条存根包含 key、原文引文和 sourceRefs；需要原文时调用 read_memory，key 用存根的 entryId。`;
}

function foldedCount(arm: Arm, turn: number, pairCount: number): number {
  const completed = Math.min(turn - 1, pairCount);
  if (arm === 'per_turn') return Math.max(0, completed - window);
  if (arm === 'boundary') {
    const lastBoundary = Math.floor(completed / batch) * batch;
    return Math.max(0, lastBoundary - window);
  }
  return 0;
}

function renderDigest(pairs: Pair[]): string {
  return `[digest]\n${pairs
    .map((pair) => `- ${pair.key} · sourceRefs: ${pair.id} · 原文引文：“${pair.stubQuote}…”`)
    .join('\n')}`;
}

function buildMessages(session: Session, arm: Arm, turn: number, currentUser: string): ChatMessage[] {
  const folded = foldedCount(arm, turn, session.pairs.length);
  const prior = session.pairs.slice(0, Math.min(turn - 1, session.pairs.length));
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(session, arm) }];
  if (folded > 0) messages.push({ role: 'user', content: renderDigest(prior.slice(0, folded)) });
  for (const pair of prior.slice(folded)) {
    messages.push({ role: 'user', content: pair.user });
    messages.push({ role: 'assistant', content: pair.assistant });
  }
  messages.push({ role: 'user', content: currentUser });
  return messages;
}

function contextChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
}

async function chat(messages: ChatMessage[], tools: unknown[]): Promise<ChatReply> {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`gateway ${response.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } }>;
    usage?: unknown;
  };
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error(`gateway returned no message: ${text.slice(0, 500)}`);
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    toolCalls: Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCall[]) : [],
    ...(body.usage === undefined ? {} : { usage: body.usage }),
    latencyMs: Date.now() - started,
  };
}

function readKey(rawArguments: string): string | null {
  if (rawArguments.trim().startsWith('digest:')) return rawArguments.trim();
  try {
    const parsed = JSON.parse(rawArguments) as { key?: unknown };
    return typeof parsed.key === 'string' ? parsed.key.trim() : null;
  } catch {
    return null;
  }
}

function normalizeUsage(raw: unknown, messages: ChatMessage[], content: string): Usage {
  const parsed = parseUsage(raw as Parameters<typeof parseUsage>[0]);
  const estimatedPrompt = Math.ceil(JSON.stringify(messages).length / 4);
  const promptTokens = parsed?.input ?? estimatedPrompt;
  const completionTokens = parsed?.output ?? Math.ceil(content.length / 4);
  const cacheHit = parsed?.cacheHit ?? null;
  const cacheMiss = parsed?.cacheMiss ?? (cacheHit === null ? null : Math.max(0, promptTokens - cacheHit));
  return {
    promptTokens,
    completionTokens,
    cacheHit,
    cacheMiss,
    cacheReported: parsed?.cacheHit !== undefined,
  };
}

function costOf(pricing: Pricing | null, usage: Usage): number | null {
  if (!pricing) return null;
  const miss = usage.cacheMiss ?? usage.promptTokens;
  const hit = usage.cacheHit ?? 0;
  return (
    miss * pricing.promptPerToken +
    hit * pricing.cacheReadPerToken +
    usage.completionTokens * pricing.completionPerToken
  );
}

async function runTurn(
  session: Session,
  arm: Arm,
  turn: number,
  kind: 'replay' | 'final',
  currentUser: string,
  pricing: Pricing | null,
): Promise<TurnRecord> {
  const messages = buildMessages(session, arm, turn, currentUser);
  const tools = arm === 'no_fold' ? [] : [READ_TOOL];
  const calls: CallRecord[] = [];
  let final = '';
  let modelCalls = 0;
  let toolCalls = 0;
  let latencyMs = 0;

  for (let round = 0; round < MAX_MODEL_CALLS; round += 1) {
    const reply = await chat(messages, tools);
    modelCalls += 1;
    latencyMs += reply.latencyMs;
    const usage = normalizeUsage(reply.usage, messages, reply.content || reply.reasoning);
    calls.push({
      sessionId: session.id,
      arm,
      turn,
      kind,
      contextChars: contextChars(messages),
      usage,
      costUsd: costOf(pricing, usage),
      latencyMs: reply.latencyMs,
      modelCalls: 1,
      toolCalls: reply.toolCalls.length,
      content: (reply.content || reply.reasoning).slice(0, 500),
      rawUsage: reply.usage ?? null,
    });
    toolCalls += reply.toolCalls.length;
    if (reply.toolCalls.length === 0) {
      final = reply.content || reply.reasoning;
      break;
    }
    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const key = readKey(call.function.arguments);
      const pair = session.pairs.find((entry) => entry.key === key);
      const content =
        call.function.name === 'read_memory' && pair
          ? `[ledger ${pair.id}]\n负责人：${pair.user}\n助手：${pair.assistant}`
          : `no folded entry for key ${key ?? '(none)'}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const costs = calls.map((call) => call.costUsd).filter((cost): cost is number => cost !== null);
  return {
    sessionId: session.id,
    arm,
    turn,
    kind,
    contextChars: calls[0]?.contextChars ?? 0,
    promptTokens: sum(calls.map((call) => call.usage.promptTokens)),
    completionTokens: sum(calls.map((call) => call.usage.completionTokens)),
    cacheHit: sum(calls.map((call) => call.usage.cacheHit ?? 0)),
    cacheMiss: sum(calls.map((call) => call.usage.cacheMiss ?? call.usage.promptTokens)),
    cacheReported: calls.every((call) => call.usage.cacheReported),
    costUsd: costs.length === calls.length ? sum(costs) : null,
    latencyMs,
    modelCalls,
    toolCalls,
    calls,
    final,
  };
}

async function runSession(session: Session, arm: Arm, pricing: Pricing | null): Promise<SessionResult> {
  const turns: TurnRecord[] = [];
  for (let turn = 1; turn <= session.pairs.length; turn += 1) {
    turns.push(await runTurn(session, arm, turn, 'replay', session.pairs[turn - 1]!.user, pricing));
  }
  const final = await runTurn(session, arm, session.pairs.length + 1, 'final', session.question, pricing);
  turns.push(final);
  const verdict = classify(scoringTask(session), final.final);
  return {
    sessionId: session.id,
    type: session.type,
    arm,
    correct: verdict.correct,
    hallucinated: verdict.hallucinated,
    answerLine: verdict.answerLine,
    reason: verdict.reason,
    turns,
  };
}

function summarize(results: SessionResult[]): ArmSummary[] {
  return ARMS.map((arm) => {
    const subset = results.filter((result) => result.arm === arm);
    const turns = subset.flatMap((result) => result.turns);
    const promptTokens = turns.reduce((sum, turn) => sum + turn.promptTokens, 0);
    const cacheHit = turns.reduce((sum, turn) => sum + turn.cacheHit, 0);
    const cacheMiss = turns.reduce((sum, turn) => sum + turn.cacheMiss, 0);
    const completionTokens = turns.reduce((sum, turn) => sum + turn.completionTokens, 0);
    const contextChars = turns.reduce((sum, turn) => sum + turn.contextChars, 0);
    const costs = turns.map((turn) => turn.costUsd).filter((cost): cost is number => cost !== null);
    const totalCost = costs.length === turns.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
    return {
      arm,
      sessions: subset.length,
      correct: subset.filter((result) => result.correct).length,
      hallucinated: subset.filter((result) => result.hallucinated).length,
      turns: turns.length,
      promptTokens,
      cacheHit,
      cacheMiss,
      completionTokens,
      cacheHitRate: promptTokens === 0 ? 0 : cacheHit / promptTokens,
      avgContextChars: turns.length === 0 ? 0 : contextChars / turns.length,
      avgContextTokens: turns.length === 0 ? 0 : contextChars / turns.length / 4,
      costUsd: totalCost,
      costPerSession: totalCost === null ? null : totalCost / Math.max(1, subset.length),
      costPerTurn: totalCost === null ? null : totalCost / Math.max(1, turns.length),
    };
  });
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(6)}`;
}

function percent(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function conclusion(summary: ArmSummary[], pricing: Pricing | null): string[] {
  const noFold = summary.find((entry) => entry.arm === 'no_fold')!;
  const perTurn = summary.find((entry) => entry.arm === 'per_turn')!;
  const boundary = summary.find((entry) => entry.arm === 'boundary')!;
  const lines: string[] = [];
  if (noFold.costUsd === null || perTurn.costUsd === null || boundary.costUsd === null) {
    return ['Cost is not comparable: the gateway did not report pricing for this route.'];
  }
  const delta = (value: number, base: number) => ((value - base) / base) * 100;
  lines.push(
    `No-fold is the baseline at ${money(noFold.costUsd)}; per-turn fold costs ${money(perTurn.costUsd)} (${delta(perTurn.costUsd, noFold.costUsd).toFixed(1)}%) and boundary fold costs ${money(boundary.costUsd)} (${delta(boundary.costUsd, noFold.costUsd).toFixed(1)}%).`,
  );
  if (boundary.costUsd < noFold.costUsd) {
    lines.push(
      `Boundary folding is cheaper than no-fold by ${money(noFold.costUsd - boundary.costUsd)} (${Math.abs(delta(boundary.costUsd, noFold.costUsd)).toFixed(1)}%). The C1 proposal is supported by this session shape.`,
    );
  } else {
    lines.push(
      `Boundary folding is not cheaper than no-fold: it costs ${money(boundary.costUsd - noFold.costUsd)} more (${delta(boundary.costUsd, noFold.costUsd).toFixed(1)}%). Per the ticket's failure route, C1 should change or raise the fold threshold rather than treat boundary folding as a saving on this session shape.`,
    );
  }
  lines.push(
    `Cache hit rate is ${percent(noFold.cacheHitRate)} (no-fold), ${percent(perTurn.cacheHitRate)} (per-turn) and ${percent(boundary.cacheHitRate)} (boundary). The hit rate is the mechanism: a changed digest invalidates the whole suffix after it, so the arm that changes it least keeps the most of the prompt at the cache-read price.`,
  );
  const priceRatio = pricing && pricing.cacheReadPerToken > 0 ? pricing.promptPerToken / pricing.cacheReadPerToken : null;
  if (priceRatio !== null && pricing) {
    const tokenSaving = noFold.promptTokens === 0 ? 0 : (100 * (noFold.promptTokens - boundary.promptTokens)) / noFold.promptTokens;
    lines.push(
      `A cache miss costs ${priceRatio.toFixed(0)}× a cache read on this route ($${(pricing.promptPerToken * 1_000_000).toFixed(2)}/M vs $${(pricing.cacheReadPerToken * 1_000_000).toFixed(3)}/M). A fold therefore has to save ${priceRatio.toFixed(0)}× the tokens it invalidates before it breaks even; boundary folding saves ${tokenSaving.toFixed(1)}% of prompt tokens but pays the miss price on the changed suffix at every boundary, so it does not. Raising the fold threshold well above 6k, or keeping no-fold, is the cost-supported choice; folding remains a capacity measure, not a saving.`,
    );
  }
  if (perTurn.costUsd > noFold.costUsd) {
    lines.push(
      `Per-turn folding is the most expensive arm at ${money(perTurn.costUsd)}; it saves tokens but pays the miss price on the recent window every turn.`,
    );
  }
  return lines;
}

function markdown(
  results: SessionResult[],
  summary: ArmSummary[],
  pricing: Pricing | null,
  meta: { generatedAt: string; head: string; model: string; baseUrl: string; sessions: number; window: number; batch: number },
): string {
  const lines: string[] = [];
  lines.push('# Cache economics of fold strategies — #259 C4');
  lines.push('');
  lines.push(`- base commit at run: \`${meta.head}\``);
  lines.push(`- run at: ${meta.generatedAt}`);
  lines.push(`- model: \`${meta.model}\` through \`${meta.baseUrl}\``);
  lines.push(`- sessions: ${meta.sessions} × ${PAIR_COUNT} pairs + final question`);
  lines.push(`- fold window: last ${meta.window} pairs kept verbatim; boundary batch: every ${meta.batch} pairs`);
  lines.push('- temperature: 0; fixed ledger; scripted assistant replies; one command: `bun eval/cache-econ/run.ts`');
  lines.push('');
  lines.push('## Corpus');
  lines.push('');
  lines.push('- Four sessions, one per detail type (number, name, constraint, step). The target detail is in pair 2; two same-type distractors are in pairs 12 and 21; the rest are filler paragraphs.');
  lines.push('- The final no-fold projection is about 23.5k characters, the C3 provisional 6,000 shell tokens; the provider counts it as about 14.5k prompt tokens.');
  lines.push('- The assistant replies are scripted and the ledger is identical across arms. The model is called once per pair with the arm-specific projection; its replay reply is discarded, so only the projection differs.');
  lines.push('- Fold stubs use the kernel `SessionDigest` shape: entryId (key), an exact prefix quote of the pair user turn, and sourceRefs. The value is only in the omitted suffix; folded arms can call `read_memory`.');
  lines.push('- Random baseline: the final question has one target among three same-type detail pairs; a blind pick is 33.3%, and a random string matches no answer.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| arm | sessions | correct | hallucinated | turns | avg context chars | avg context tokens (chars/4) | prompt tokens | cache hit | cache miss | cache hit rate | completion tokens | total cost | cost/session | cost/turn |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of summary) {
    lines.push(
      `| ${row.arm} | ${row.sessions} | ${row.correct}/${row.sessions} | ${row.hallucinated} | ${row.turns} | ${row.avgContextChars.toFixed(0)} | ${row.avgContextTokens.toFixed(0)} | ${row.promptTokens} | ${row.cacheHit} | ${row.cacheMiss} | ${percent(row.cacheHitRate)} | ${row.completionTokens} | ${money(row.costUsd)} | ${money(row.costPerSession)} | ${money(row.costPerTurn)} |`,
    );
  }
  lines.push('');
  lines.push(
    `Pricing from the gateway's \`/v1/models\` at run time: ${pricing ? `prompt $${(pricing.promptPerToken * 1_000_000).toFixed(2)}/M, cache read $${(pricing.cacheReadPerToken * 1_000_000).toFixed(3)}/M, completion $${(pricing.completionPerToken * 1_000_000).toFixed(2)}/M` : 'not reported, so cost is `—`'}.`,
  );
  lines.push('');
  lines.push('## Scale at the final question');
  lines.push('');
  lines.push('| arm | final context chars | final context tokens (chars/4) | final prompt tokens (provider) | final model calls | final tool calls | final cache hit rate |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const arm of ARMS) {
    const finals = results.filter((result) => result.arm === arm).map((result) => result.turns.at(-1)!);
    const contextChars = finals.reduce((sum, turn) => sum + turn.contextChars, 0) / Math.max(1, finals.length);
    const promptTokens = finals.reduce((sum, turn) => sum + turn.promptTokens, 0) / Math.max(1, finals.length);
    const modelCalls = finals.reduce((sum, turn) => sum + turn.modelCalls, 0) / Math.max(1, finals.length);
    const toolCalls = finals.reduce((sum, turn) => sum + turn.toolCalls, 0) / Math.max(1, finals.length);
    const cacheHit = finals.reduce((sum, turn) => sum + turn.cacheHit, 0);
    const cacheMiss = finals.reduce((sum, turn) => sum + turn.cacheMiss, 0);
    lines.push(
      `| ${arm} | ${contextChars.toFixed(0)} | ${(contextChars / 4).toFixed(0)} | ${promptTokens.toFixed(0)} | ${modelCalls.toFixed(2)} | ${toolCalls.toFixed(2)} | ${percent(cacheHit + cacheMiss === 0 ? 0 : cacheHit / (cacheHit + cacheMiss))} |`,
    );
  }
  lines.push('');
  lines.push('The final prompt-token column sums every call in the final turn. The folded arms call `read_memory` on the final question, so they resend the context in a follow-up call; the no-fold arm answers in one call. That is a real cost of the fold path, not a counting artifact.');
  lines.push('');
  lines.push('## Per session');
  lines.push('');
  lines.push('| session | arm | correct | prompt tokens | cache hit rate | total cost |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    const promptTokens = result.turns.reduce((sum, turn) => sum + turn.promptTokens, 0);
    const cacheHit = result.turns.reduce((sum, turn) => sum + turn.cacheHit, 0);
    const costs = result.turns.map((turn) => turn.costUsd).filter((cost): cost is number => cost !== null);
    const total = costs.length === result.turns.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
    lines.push(
      `| ${result.sessionId} | ${result.arm} | ${result.correct ? '✓' : '✗'} | ${promptTokens} | ${percent(promptTokens === 0 ? 0 : cacheHit / promptTokens)} | ${money(total)} |`,
    );
  }
  lines.push('');
  lines.push('## Cost by turn');
  lines.push('');
  lines.push('| turn | no_fold | per_turn | boundary |');
  lines.push('| ---: | ---: | ---: | ---: |');
  const maxTurn = Math.max(...results.flatMap((result) => result.turns.map((turn) => turn.turn)));
  for (let turn = 1; turn <= maxTurn; turn += 1) {
    const cells = ARMS.map((arm) => {
      const costs = results
        .filter((result) => result.arm === arm)
        .flatMap((result) => result.turns.filter((entry) => entry.turn === turn).map((entry) => entry.costUsd))
        .filter((cost): cost is number => cost !== null);
      return money(costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0) / costs.length);
    });
    lines.push(`| ${turn}${turn === maxTurn ? ' (final)' : ''} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Net account');
  lines.push('');
  lines.push(...conclusion(summary, pricing).map((line) => `- ${line}`));
  const byArm = (arm: Arm, sessionId: string) =>
    results.find((result) => result.arm === arm && result.sessionId === sessionId)!;
  const deltas = results
    .filter((result) => result.arm === 'no_fold')
    .map((base) => {
      const boundary = byArm('boundary', base.sessionId);
      const baseCost = base.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
      const boundaryCost = boundary.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
      return `${base.sessionId} ${((100 * (boundaryCost - baseCost)) / baseCost).toFixed(1)}%`;
    });
  lines.push(
    `- Per-session boundary vs no-fold: ${deltas.join(', ')}. Boundary is cheaper in the session(s) where the no-fold arm happened to miss more cache; the aggregate is the decision number, not the best session.`,
  );
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  const failures = results.filter((result) => !result.correct || result.hallucinated);
  if (failures.length === 0) {
    lines.push('- none');
  } else {
    for (const failure of failures) {
      lines.push(
        `- \`${failure.sessionId}\` (${failure.type}, ${failure.arm}) — expected: ${SESSIONS.find((session) => session.id === failure.sessionId)?.expected ?? '?'} — answer: ${failure.answerLine || '(none)'} — ${failure.reason}`,
      );
    }
  }
  lines.push('');
  lines.push('## What this measures, and what it does not');
  lines.push('');
  lines.push('- It measures the projection + provider cache, not the product pipeline: the harness supplies the fold, the key and the drill action.');
  lines.push('- The ledger is a replay: assistant replies are scripted so all arms see the same text. A live agent would append its own replies, which changes the prefix and can change cache behaviour.');
  lines.push('- The digest is append-only and deterministic. A fold that rewrites the digest each turn would invalidate more prefix than the per-turn arm does here; this is the cache-friendly end of per-turn folding.');
  lines.push('- Cache hits are the provider\'s report (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens` or `cached_tokens`). A provider that reports no cache field is recorded as all-miss, not as zero cost.');
  lines.push('- One model route and four synthetic sessions; the absolute dollars are small. The result is a direction and a mechanism, not a universal price list.');
  return `${lines.join('\n')}\n`;
}

async function pricingFor(): Promise<Pricing | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: Array<{
        id?: string;
        pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown };
      }>;
    };
    const entry = payload.data?.find((item) => item.id === model);
    const prompt = Number(entry?.pricing?.prompt);
    const completion = Number(entry?.pricing?.completion);
    const cacheRead = Number(entry?.pricing?.input_cache_read);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    return {
      promptPerToken: prompt,
      completionPerToken: completion,
      cacheReadPerToken: Number.isFinite(cacheRead) ? cacheRead : prompt,
    };
  } catch {
    return null;
  }
}

async function gatewayUp(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function headCommit(): string {
  return execSync('git rev-parse --short=12 HEAD', { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const sessions = SESSIONS.slice(0, Math.min(limit, SESSIONS.length));
  const problems = validateSessions(sessions);
  if (problems.length > 0) {
    console.error('cache-econ corpus check failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  if (!Number.isInteger(window) || window < 1 || !Number.isInteger(batch) || batch < 1) {
    throw new Error('--window and --batch must be positive integers');
  }
  console.log(`corpus ok: ${sessions.length} sessions × ${PAIR_COUNT} pairs; window ${window}, batch ${batch}`);
  for (const session of sessions) {
    console.log(
      `${session.id}: target ${session.targetKey} (${session.expected}); final fold counts ` +
        ARMS.map((arm) => `${arm}=${foldedCount(arm, PAIR_COUNT + 1, session.pairs.length)}`).join(', '),
    );
  }
  if (dryRun) return;

  if (reportOnly) {
    const previous = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as {
      results: SessionResult[];
      summary: ArmSummary[];
      pricing: Pricing | null;
      generatedAt: string;
      head: string;
      model: string;
      baseUrl: string;
      sessions: number;
      window: number;
      batch: number;
    };
    writeFileSync(
      join(outDir, 'results.md'),
      markdown(previous.results, previous.summary, previous.pricing, {
        generatedAt: previous.generatedAt,
        head: previous.head,
        model: previous.model,
        baseUrl: previous.baseUrl,
        sessions: previous.sessions,
        window: previous.window,
        batch: previous.batch,
      }),
    );
    console.log(`rewrote ${join(outDir, 'results.md')} from results.json`);
    return;
  }

  if (!(await gatewayUp())) {
    console.error(`mg gateway is not reachable at ${baseUrl} (GET /models). Start it or pass --base-url.`);
    process.exit(2);
  }
  const pricing = await pricingFor();
  if (!pricing) console.warn(`no pricing for ${model}; cost columns will be —`);

  const results: SessionResult[] = [];
  for (const session of sessions) {
    for (const arm of ARMS) {
      console.log(`running ${session.id} / ${arm} …`);
      const result = await runSession(session, arm, pricing);
      results.push(result);
      const total = result.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
      console.log(
        `  ${result.correct ? 'ok' : 'wrong'} · ${result.turns.reduce((sum, turn) => sum + turn.promptTokens, 0)} prompt tokens · $${total.toFixed(6)}`,
      );
    }
  }

  const summary = summarize(results);
  const meta = {
    generatedAt: new Date().toISOString(),
    head: headCommit(),
    model,
    baseUrl,
    sessions: sessions.length,
    window,
    batch,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'results.json'),
    `${JSON.stringify({ experiment: 'cache-econ', issue: 259, ...meta, pairCount: PAIR_COUNT, pricing, summary, results }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, 'results.md'), markdown(results, summary, pricing, meta));
  console.log('');
  console.log(markdown(results, summary, pricing, meta));
  console.log(`wrote ${join(outDir, 'results.md')} and results.json`);
}

await main();

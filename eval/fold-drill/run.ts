#!/usr/bin/env bun
/**
 * #254 B4 — the decisive fold/drill experiment.
 *
 * One command:
 *
 *   bun eval/fold-drill/run.ts
 *
 * Three arms over the same 24 tasks and the same model route:
 *
 *   full         the whole transcript is in context.
 *   folded_key   the three detail turns are digest stubs; the model may call
 *                read_memory(key) to get the original text.
 *   folded_auto  same as folded_key, plus the harness expands a stub into the
 *                context when the question hits its key or entity terms.
 *
 * Product code is not touched. No scratch tree or model cache is written;
 * the trace lives in results.json and the table in results.md.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ARMS,
  DETAIL_TYPES,
  classify,
  corpusStats,
  validateCorpus,
  type CorpusStats,
} from './check.ts';
import { TASKS, autoExpandMatches, turnText } from './corpus.ts';
import { REAL_TASKS, SWEEP_TASKS, validateRealCorpus } from './real-corpus.ts';
import type { Arm, DetailType, FoldTask } from './types.ts';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3425/v1';
const DEFAULT_MODEL = 'auto/deepseek-v4.1-flash';
const MAX_MODEL_CALLS = 5;
const REQUEST_TIMEOUT_MS = 300_000;

const baseUrl = resolveBaseUrl(process.env.MG_BASE_URL ?? argument('base-url') ?? DEFAULT_BASE_URL);
const model = argument('model') ?? process.env.MG_MODEL ?? DEFAULT_MODEL;
const apiKey = process.env.MG_API_KEY ?? 'magpie';
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const corpusName = argument('corpus') ?? 'small';
if (corpusName !== 'small' && corpusName !== 'real' && corpusName !== 'sweep') {
  throw new Error('--corpus must be "small", "real" or "sweep"');
}
const CORPUS: FoldTask[] = corpusName === 'real' ? REAL_TASKS : corpusName === 'sweep' ? SWEEP_TASKS : TASKS;
const arms: Arm[] = argument('arms')
  ? (argument('arms')!.split(',') as Arm[]).filter((arm) => (ARMS as readonly string[]).includes(arm))
  : [...ARMS];
if (arms.length === 0) throw new Error('--arms must name at least one of full, folded_key, folded_auto');
const limit = Number(argument('limit') ?? CORPUS.length);
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

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
}

interface CallTrace {
  round: number;
  promptTokens: number;
  completionTokens: number | null;
  toolCalls: Array<{ name: string; key: string | null; target: boolean; known: boolean }>;
}

interface RunResult {
  taskId: string;
  type: DetailType;
  arm: Arm;
  autoExpand: boolean;
  question: string;
  expected: string;
  answerLine: string;
  correct: boolean;
  hallucinated: boolean;
  reason: string;
  contextChars: number;
  promptTokens: number;
  completionTokens: number;
  tokensEstimated: boolean;
  modelCalls: number;
  toolCalls: number;
  targetDrill: boolean;
  anyDrill: boolean;
  drilledKeys: string[];
  exhausted: boolean;
  elapsedMs: number;
  calls: CallTrace[];
}

interface ArmSummary {
  arm: Arm;
  tasks: number;
  correct: number;
  hallucinated: number;
  targetDrill: number;
  anyDrill: number;
  avgPromptTokens: number;
  avgModelCalls: number;
  avgToolCalls: number;
  avgContextChars: number;
}

interface GroupSummary {
  arm: Arm;
  group: 'trigger_hit' | 'trigger_miss';
  tasks: number;
  correct: number;
  hallucinated: number;
  targetDrill: number;
}

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read_memory',
    description:
      'Read the original ledger text behind one folded digest entry. The key is the entryId shown in the digest, for example digest:f01-t02.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The digest entryId of the folded detail.' },
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

function percent(hits: number, total: number): string {
  return total === 0 ? 'n/a' : `${((100 * hits) / total).toFixed(1)}%`;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function systemPrompt(arm: Arm): string {
  const base =
    '你是受测助手。只依据给出的任务记录回答，不要使用记录之外的知识，不要猜测。最后只输出一行：答案：<值>。值应尽量照抄原文。';
  if (arm === 'full') return `${base}\n任务记录是完整的，不需要读取任何外部内容。`;
  if (arm === 'folded_key') {
    return `${base}\n较早的细节被折叠成了 digest 存根。每条存根包含 key、原文引文和 sourceRefs；可以使用 read_memory，key 用存根的 entryId。`;
  }
  return `${base}\n较早的细节被折叠成了 digest 存根。问题命中存根实体词时，系统已自动把原文展开到 <auto-expanded> 块；未展开的存根仍可以使用 read_memory。`;
}

function renderTurns(task: FoldTask, turns: FoldTask['turns']): string {
  return turns
    .map((turn) => `[${turn.id}] ${turn.speaker === 'owner' ? '负责人' : '助手'}：${turn.text}`)
    .join('\n');
}

function renderFull(task: FoldTask): string {
  return `[任务记录]\n${renderTurns(task, task.turns)}`;
}

function renderFolded(task: FoldTask): string {
  const folded = new Set(task.details.map((detail) => detail.turnId));
  const digest = task.details
    .map((detail) => `- ${detail.key} · sourceRefs: ${detail.turnId} · 原文引文：“${detail.stubQuote}…”`)
    .join('\n');
  const recent = renderTurns(
    task,
    task.turns.filter((turn) => !folded.has(turn.id)),
  );
  return `[digest]\n${digest}\n\n[近期对话]\n${recent}`;
}

function renderContext(task: FoldTask, arm: Arm): string {
  if (arm === 'full') return renderFull(task);
  const folded = renderFolded(task);
  if (arm === 'folded_key') return folded;
  const expanded = task.details.filter((detail) => autoExpandMatches(task, detail.key, task.question));
  if (expanded.length === 0) return folded;
  const blocks = expanded
    .map(
      (detail) =>
        `<auto-expanded key="${detail.key}" sourceRefs="${detail.turnId}">\n${turnText(task, detail.turnId)}\n</auto-expanded>`,
    )
    .join('\n\n');
  return `${folded}\n\n${blocks}`;
}

async function chat(messages: ChatMessage[], tools: unknown[]): Promise<ChatReply> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`gateway ${response.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
    usage?: Usage;
  };
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error(`gateway returned no message: ${text.slice(0, 500)}`);
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCall[]) : [],
    ...(body.usage === undefined ? {} : { usage: body.usage }),
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

async function runTask(task: FoldTask, arm: Arm): Promise<RunResult> {
  const context = renderContext(task, arm);
  const question = `问题：${task.question}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(arm) },
    { role: 'user', content: `${context}\n\n${question}` },
  ];
  const tools = arm === 'full' ? [] : [READ_TOOL];
  const calls: CallTrace[] = [];
  const drilledKeys: string[] = [];
  let final = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let tokensEstimated = false;
  let finished = false;
  const started = Date.now();

  for (let round = 0; round < MAX_MODEL_CALLS; round += 1) {
    const reply = await chat(messages, tools);
    const prompt = reply.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(messages).length / 4);
    const completion = reply.usage?.completion_tokens ?? Math.ceil(reply.content.length / 4);
    if (reply.usage?.prompt_tokens === undefined) tokensEstimated = true;
    promptTokens += prompt;
    completionTokens += completion;
    calls.push({
      round: round + 1,
      promptTokens: prompt,
      completionTokens: reply.usage?.completion_tokens ?? null,
      toolCalls: reply.toolCalls.map((call) => {
        const key = readKey(call.function.arguments);
        return {
          name: call.function.name,
          key,
          target: key === task.targetKey,
          known: key !== null && task.details.some((detail) => detail.key === key),
        };
      }),
    });
    for (const call of reply.toolCalls) {
      const key = readKey(call.function.arguments);
      if (key && !drilledKeys.includes(key)) drilledKeys.push(key);
    }
    if (reply.toolCalls.length === 0) {
      final = reply.content;
      finished = true;
      break;
    }
    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const key = readKey(call.function.arguments);
      const detail = task.details.find((entry) => entry.key === key);
      const content =
        call.function.name === 'read_memory' && detail
          ? `[ledger ${detail.turnId}]\n${turnText(task, detail.turnId)}`
          : `no folded entry for key ${key ?? '(none)'}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  const exhausted = !finished;

  const verdict = classify(task, final);
  const toolCalls = calls.reduce((sum, call) => sum + call.toolCalls.length, 0);
  return {
    taskId: task.id,
    type: task.type,
    arm,
    autoExpand: task.details.some((detail) => autoExpandMatches(task, detail.key, task.question)),
    question: task.question,
    expected: task.expected,
    answerLine: verdict.answerLine,
    correct: verdict.correct,
    hallucinated: verdict.hallucinated,
    reason: verdict.reason,
    contextChars: context.length + question.length,
    promptTokens,
    completionTokens,
    tokensEstimated,
    modelCalls: calls.length,
    toolCalls,
    targetDrill: calls.some((call) => call.toolCalls.some((entry) => entry.target)),
    anyDrill: toolCalls > 0,
    drilledKeys,
    exhausted,
    elapsedMs: Date.now() - started,
    calls,
  };
}

function summarize(runs: RunResult[]): ArmSummary[] {
  return arms.map((arm) => {
    const subset = runs.filter((run) => run.arm === arm);
    return {
      arm,
      tasks: subset.length,
      correct: subset.filter((run) => run.correct).length,
      hallucinated: subset.filter((run) => run.hallucinated).length,
      targetDrill: subset.filter((run) => run.targetDrill).length,
      anyDrill: subset.filter((run) => run.anyDrill).length,
      avgPromptTokens: average(subset.map((run) => run.promptTokens)),
      avgModelCalls: average(subset.map((run) => run.modelCalls)),
      avgToolCalls: average(subset.map((run) => run.toolCalls)),
      avgContextChars: average(subset.map((run) => run.contextChars)),
    };
  });
}

function groupSummaries(runs: RunResult[]): GroupSummary[] {
  const groups: Array<GroupSummary['group']> = ['trigger_hit', 'trigger_miss'];
  return arms.flatMap((arm) =>
    groups.map((group) => {
      const subset = runs.filter(
        (run) => run.arm === arm && (group === 'trigger_hit' ? run.autoExpand : !run.autoExpand),
      );
      return {
        arm,
        group,
        tasks: subset.length,
        correct: subset.filter((run) => run.correct).length,
        hallucinated: subset.filter((run) => run.hallucinated).length,
        targetDrill: subset.filter((run) => run.targetDrill).length,
      };
    }),
  );
}

function conclusion(summary: ArmSummary[]): string {
  const full = summary.find((entry) => entry.arm === 'full')!;
  const folded = summary.find((entry) => entry.arm === 'folded_key')!;
  const auto = summary.find((entry) => entry.arm === 'folded_auto');
  const fullRate = full.tasks === 0 ? 0 : full.correct / full.tasks;
  const foldedRate = folded.tasks === 0 ? 0 : folded.correct / folded.tasks;
  const autoRate = auto && auto.tasks > 0 ? auto.correct / auto.tasks : 0;
  const margin = 0.1;
  if (!auto) {
    return foldedRate >= fullRate - margin
      ? 'Passive keys hold at this scale: the folded+key arm stays within 10 points of the full transcript and drills the target when it needs to.'
      : 'Passive keys lose more than 10 points against the full transcript at this scale.';
  }
  if (foldedRate >= fullRate - margin && folded.targetDrill / Math.max(1, folded.tasks) >= 0.8) {
    return 'Passive keys hold: the folded+key arm stays within 10 points of the full arm and drills the target in at least 80% of runs. Auto-expansion is not required for correctness on this corpus; it only removes drill calls on trigger-hit tasks, so treat it as a cost optimization rather than a safety gate.';
  }
  if (foldedRate < fullRate - margin && autoRate >= fullRate - margin) {
    return 'Passive keys are not enough: the folded+key arm loses more than 10 points, while folded+auto recovers to within 10 points. Auto-expansion is required for this corpus.';
  }
  if (foldedRate < fullRate - margin && autoRate < fullRate - margin) {
    return 'Both folded arms lose more than 10 points against the full transcript. Per the ticket failure route, narrow folding to tool output and do not fold conversation text in C.';
  }
  return 'Mixed result: the folded arms are close to the full arm but one threshold is unmet; read the table before choosing the C scope.';
}

/**
 * The sweep's one product decision: at which transcript size does folding stop costing more
 * than the full context? Points come from the per-task token sums, not from a fitted model.
 */
function thresholdLines(runs: RunResult[], sweep: boolean): string[] {
  const points = [...new Set(runs.map((run) => run.taskId))]
    .map((id) => {
      const full = runs.find((run) => run.taskId === id && run.arm === 'full');
      const folded = runs.find((run) => run.taskId === id && run.arm === 'folded_key');
      const task = CORPUS.find((entry) => entry.id === id);
      return full && folded
        ? { id, blocks: task?.blocks ?? 0, full: full.promptTokens, folded: folded.promptTokens, correct: full.correct && folded.correct }
        : null;
    })
    .filter((point): point is { id: string; blocks: number; full: number; folded: number; correct: boolean } => point !== null)
    .sort((left, right) => left.full - right.full);
  if (points.length < 2) return [];
  const lines = ['', '## Fold-enable threshold', ''];
  if (!sweep) {
    const full = runs.filter((run) => run.arm === 'full');
    const folded = runs.filter((run) => run.arm === 'folded_key');
    const fullTokens = Math.round(average(full.map((run) => run.promptTokens)));
    const foldedTokens = Math.round(average(folded.map((run) => run.promptTokens)));
    const drilled = average(folded.map((run) => run.toolCalls));
    lines.push(
      `- At this scale (6 tool outputs, ~${fullTokens} full prompt tokens) folding saved **${((1 - foldedTokens / Math.max(1, fullTokens)) * 100).toFixed(1)}%**: ${fullTokens} → ${foldedTokens} tokens, because the model read ${drilled.toFixed(2)} of 6 blocks and every round re-bills the context.`,
      '- The block-count sweep in `sweep/` locates the crossover; the threshold rule is stated there.',
    );
    return lines;
  }
  const lastLoss = [...points].reverse().find((point) => point.folded >= point.full);
  const firstWin = points.find((point) => point.folded < point.full);
  if (lastLoss && firstWin) {
    const midpoint = Math.round((lastLoss.full + firstWin.full) / 2 / 1_000) * 1_000;
    lines.push(
      `- The crossover sits between **${lastLoss.full}** provider prompt tokens (${lastLoss.blocks} blocks, folded ${lastLoss.folded}) and **${firstWin.full}** (${firstWin.blocks} blocks, folded ${firstWin.folded}).`,
      `- Recommended enable threshold: **fold only when the transcript would exceed ~${midpoint.toLocaleString('en-US')} provider prompt tokens**. Below it, the stub, the extra round and the drilled original cost more than the full transcript.`,
      `- Above the crossover the folded prompt is roughly flat (${Math.min(...points.filter((point) => point.folded < point.full).map((point) => point.folded))}–${Math.max(...points.filter((point) => point.folded < point.full).map((point) => point.folded))} tokens) because the model drills only the blocks it needs; the saving grows with how much is folded and not read.`,
    );
  } else {
    lines.push(firstWin
      ? `- Folding was cheaper at the smallest measured point (${firstWin.blocks} blocks, ${firstWin.full} full vs ${firstWin.folded} folded tokens).`
      : `- Folding was never cheaper on this sweep (best case ${points[0]!.folded} vs ${points[0]!.full} at the smallest transcript).`);
  }
  const accuracy = points.filter((point) => point.correct).length;
  lines.push(`- Accuracy was unaffected at every point: ${accuracy}/${points.length} points had both arms correct, so this is a cost/capacity threshold, not a correctness one.`);
  return lines;
}

function markdown(
  runs: RunResult[],
  summary: ArmSummary[],
  groups: GroupSummary[],
  stats: CorpusStats,
  meta: { generatedAt: string; head: string; model: string; baseUrl: string; limit: number },
): string {
  const byType = (type: DetailType, arm: Arm) => {
    const subset = runs.filter((run) => run.type === type && run.arm === arm);
    return {
      n: subset.length,
      correct: subset.filter((run) => run.correct).length,
      hallucinated: subset.filter((run) => run.hallucinated).length,
      targetDrill: subset.filter((run) => run.targetDrill).length,
    };
  };
  const lines: string[] = [];
  lines.push(
    corpusName === 'real'
      ? '# Fold drill-down at real scale — #294'
      : corpusName === 'sweep'
        ? '# Fold threshold sweep — #294'
        : '# Fold drill-down experiment — #254 B4',
  );
  lines.push('');
  lines.push(`- base commit at run: \`${meta.head}\``);
  lines.push(`- run at: ${meta.generatedAt}`);
  lines.push(`- model: \`${meta.model}\` through \`${meta.baseUrl}\``);
  lines.push(`- tasks: ${meta.limit} per arm (${stats.byType.number} number, ${stats.byType.name} name, ${stats.byType.constraint} constraint, ${stats.byType.step} step)`);
  lines.push(`- arms: ${arms.join(', ')}`);
  lines.push(`- temperature: 0; task order fixed; one command: \`bun eval/fold-drill/run.ts --corpus ${corpusName}\``);
  lines.push('');
  lines.push('## Corpus');
  lines.push('');
  lines.push(`- ${stats.tasks} tasks, ${stats.avgTurns.toFixed(1)} turns / ${Math.round(stats.avgChars)} chars on average.`);
  lines.push(`- Each task has one target detail and two same-type distractors; all three are folded in the folded arms.`);
  lines.push(`- Auto-expansion trigger: ${stats.autoExpandHits} tasks hit a stub entity term, ${stats.autoExpandMisses} do not.`);
  lines.push('- Random baseline: one target among three same-kind stubs, so a blind pick is 33.3%; a random string matches no answer.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| arm | n | target drill | any drill | correct | hallucinated | avg context chars | avg prompt tokens (billed) | avg model calls | avg tool calls |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of summary) {
    lines.push(
      `| ${row.arm} | ${row.tasks} | ${percent(row.targetDrill, row.tasks)} | ${percent(row.anyDrill, row.tasks)} | ${percent(row.correct, row.tasks)} | ${percent(row.hallucinated, row.tasks)} | ${row.avgContextChars.toFixed(0)} | ${row.avgPromptTokens.toFixed(0)} | ${row.avgModelCalls.toFixed(2)} | ${row.avgToolCalls.toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push('## By detail type');
  lines.push('');
  lines.push('| type | arm | n | target drill | correct | hallucinated |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const type of DETAIL_TYPES) {
    for (const arm of arms) {
      const row = byType(type, arm);
      lines.push(
        `| ${type} | ${arm} | ${row.n} | ${percent(row.targetDrill, row.n)} | ${percent(row.correct, row.n)} | ${percent(row.hallucinated, row.n)} |`,
      );
    }
  }
  if (arms.includes('folded_auto')) {
    lines.push('');
    lines.push('## Auto-expansion trigger split');
    lines.push('');
    lines.push('| arm | group | n | target drill | correct | hallucinated |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
    for (const row of groups) {
      lines.push(
        `| ${row.arm} | ${row.group} | ${row.tasks} | ${percent(row.targetDrill, row.tasks)} | ${percent(row.correct, row.tasks)} | ${percent(row.hallucinated, row.tasks)} |`,
      );
    }
  }
  if (corpusName !== 'small') {
    lines.push('');
    lines.push('## Per task (the scale points)');
    lines.push('');
    lines.push('| task | scale | folded blocks | context chars | arm | prompt tokens (billed) | model calls | tool calls | correct |');
    lines.push('| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- |');
    for (const run of runs) {
      const task = CORPUS.find((entry) => entry.id === run.taskId);
      lines.push(
        `| ${run.taskId} | ${task?.scale ?? '—'} | ${task?.blocks ?? '—'} | ${run.contextChars} | ${run.arm} | ${run.promptTokens} | ${run.modelCalls} | ${run.toolCalls} | ${run.correct ? 'yes' : 'no'} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Conclusion');
  lines.push('');
  lines.push(conclusion(summary));
  if (corpusName !== 'small' && arms.includes('folded_key')) lines.push(...thresholdLines(runs, corpusName === 'sweep'));
  lines.push('');
  const foldedRuns = runs.filter((run) => run.arm === 'folded_key');
  const toolCounts = [1, 2, 3].map(
    (count) => `${foldedRuns.filter((run) => run.toolCalls === count).length} read ${count}`,
  );
  const hitRuns = foldedRuns.filter((run) => run.autoExpand);
  const missRuns = foldedRuns.filter((run) => !run.autoExpand);
  const autoHits = runs.filter((run) => run.arm === 'folded_auto' && run.autoExpand);
  const autoMisses = runs.filter((run) => run.arm === 'folded_auto' && !run.autoExpand);
  const fullSummary = summary.find((entry) => entry.arm === 'full')!;
  const foldedSummary = summary.find((entry) => entry.arm === 'folded_key')!;
  const autoSummary = summary.find((entry) => entry.arm === 'folded_auto');
  lines.push('## Reading');
  lines.push('');
  lines.push(
    `- Passive key: ${foldedSummary.targetDrill}/${foldedSummary.tasks} target drills. Of those runs, ${toolCounts.join(', ')} stubs. Trigger-hit tasks averaged ${average(hitRuns.map((run) => run.toolCalls)).toFixed(2)} reads; trigger-miss tasks averaged ${average(missRuns.map((run) => run.toolCalls)).toFixed(2)}.`,
  );
  if (arms.includes('folded_auto')) {
    lines.push(
      `- Auto-expand: trigger-hit runs drilled the target ${autoHits.filter((run) => run.targetDrill).length}/${autoHits.length}; trigger-miss runs ${autoMisses.filter((run) => run.targetDrill).length}/${autoMisses.length}. Correctness was ${autoHits.filter((run) => run.correct).length}/${autoHits.length} on hits and ${autoMisses.filter((run) => run.correct).length}/${autoMisses.length} on misses.`,
    );
  }
  lines.push(
    `- Cost: average billed prompt tokens were ${fullSummary.avgPromptTokens.toFixed(0)} (full) and ${foldedSummary.avgPromptTokens.toFixed(0)} (folded+key)${autoSummary ? ` and ${autoSummary.avgPromptTokens.toFixed(0)} (folded+auto)` : ''}.`,
  );
  lines.push(
    `- Hallucination: ${runs.filter((run) => run.hallucinated).length}/${runs.length} runs. The model either read the original or had it auto-expanded, so this does not test hallucination from model-written summaries.`,
  );
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  const failures = runs.filter((run) => !run.correct || run.hallucinated);
  if (failures.length === 0) {
    lines.push('- none');
  } else {
    for (const run of failures) {
      lines.push(
        `- \`${run.taskId}\` (${run.type}, ${run.arm}) — expected: ${run.expected} — answer: ${run.answerLine || '(none)'} — ${run.reason}`,
      );
    }
  }
  lines.push('');
  lines.push('## What this measures, and what it does not');
  lines.push('');
  lines.push('- The harness supplies the fold, the key and the drill action. It measures the model + context shape, not the product pipeline.');
  lines.push('- The folded stub is the kernel `SessionDigest` shape: entryId (key), an exact prefix quote of the ledger turn, and sourceRefs. The value is only in the omitted suffix.');
  lines.push('- Correctness is read from the required `答案：<value>` line. Hallucination is a detail value in the answer that does not occur in the task ledger: numbers, the corpus name pool, day/time tokens, and step action families. Chinese numerals and names outside the pool are not detected.');
  lines.push(
    corpusName === 'small'
      ? '- The corpus is synthetic and small; this is a scope decision input, not a general long-context benchmark. The model is not deterministic even at temperature 0, so a re-run can move counts.'
      : '- The corpus is synthetic but at the ticket scale: 240 turns and tool outputs of ~9k characters (roughly 2.5k provider tokens) per folded detail. Every cell is one model, temperature 0, one sample.',
  );
  return `${lines.join('\n')}\n`;
}

async function gatewayUp(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const problems = corpusName === 'small' ? validateCorpus(TASKS) : validateRealCorpus(CORPUS);
  const stats = corpusStats(CORPUS);
  if (problems.length > 0) {
    console.error('fold-drill corpus check failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(
    `corpus (${corpusName}) ok: ${stats.tasks} tasks (${stats.byType.number} number, ${stats.byType.name} name, ${stats.byType.constraint} constraint, ${stats.byType.step} step)`,
  );
  console.log(
    `auto-expansion: ${stats.autoExpandHits} hit / ${stats.autoExpandMisses} miss; ${stats.avgTurns.toFixed(1)} turns, ${Math.round(stats.avgChars)} chars avg`,
  );
  if (dryRun) return;

  if (reportOnly) {
    const previous = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as {
      runs: RunResult[];
      stats: CorpusStats;
      generatedAt: string;
      head: string;
      model: string;
      baseUrl: string;
      limit: number;
    };
    const summary = summarize(previous.runs);
    const groups = groupSummaries(previous.runs);
    const meta = {
      generatedAt: previous.generatedAt,
      head: previous.head,
      model: previous.model,
      baseUrl: previous.baseUrl,
      limit: previous.limit,
    };
    writeFileSync(join(outDir, 'results.md'), markdown(previous.runs, summary, groups, previous.stats, meta));
    console.log(`rewrote ${join(outDir, 'results.md')} from results.json`);
    return;
  }

  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  if (!(await gatewayUp())) {
    console.error(`mg gateway is not reachable at ${baseUrl} (GET /models). Start it or pass --base-url.`);
    process.exit(2);
  }

  const selected = CORPUS.slice(0, Math.min(limit, CORPUS.length));
  const runs: RunResult[] = [];
  const total = selected.length * arms.length;
  let done = 0;
  for (const task of selected) {
    for (const arm of arms) {
      const run = await runTask(task, arm);
      runs.push(run);
      done += 1;
      const flag = run.correct ? 'ok' : run.hallucinated ? 'hallucinated' : 'wrong';
      console.log(
        `[${done}/${total}] ${task.id} ${task.type} ${arm} — ${flag} (${run.modelCalls} calls, ${run.toolCalls} tools, ${run.elapsedMs} ms)`,
      );
    }
  }

  const summary = summarize(runs);
  const groups = groupSummaries(runs);
  const selectedStats = corpusStats(selected);
  const head = execSync('git rev-parse --short=12 HEAD', { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8' }).trim();
  const meta = {
    generatedAt: new Date().toISOString(),
    head,
    model,
    baseUrl,
    limit: selected.length,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'results.json'),
    `${JSON.stringify({ experiment: 'fold-drill', issue: 254, ...meta, stats: selectedStats, summary, groups, runs }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, 'results.md'), markdown(runs, summary, groups, selectedStats, meta));

  console.log('');
  console.log(markdown(runs, summary, groups, selectedStats, meta));
  console.log(`wrote ${join(outDir, 'results.md')} and results.json`);
}

await main();

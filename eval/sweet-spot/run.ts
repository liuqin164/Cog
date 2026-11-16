#!/usr/bin/env bun
/**
 * #258 C3 — the context sweet spot: success, latency and cost at four fill bands.
 *
 *   bun eval/sweet-spot/run.ts
 *
 * The bands are the shell's `targetTokens` values (6k/12k/24k/48k), measured in the assembler's
 * own `ceil(chars / 4)` unit. The provider's `usage.prompt_tokens` is reported beside them because
 * Chinese text costs more than one provider token per shell token. No product code is changed and
 * no live database is opened; the only outputs are `results.md` / `results.json`.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BANDS, FACTS_PER_TASK, TASKS, buildContext } from './corpus.ts';
import type { BandSummary, ModelPricing, RunResult, Task } from './types.ts';

const SYSTEM_PROMPT = '你是 Cog 的记忆助手。只根据提供的记忆上下文回答；不要使用上下文之外的知识。';
const MAX_TOKENS = 1_024;
const TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;

interface Options {
  tasks: number;
  bands: number[];
  model: string;
  baseUrl: string;
  apiKey: string;
  seed: number;
  outDir: string;
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function parse(argv: string[]): Options {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: bun eval/sweet-spot/run.ts [--tasks N] [--bands 6000,12000,24000,48000] [--model ID] [--base-url URL] [--seed N] [--out-dir DIR]');
    process.exit(0);
  }
  const tasks = Number(argument(argv, 'tasks') ?? TASKS.length);
  const bands = (argument(argv, 'bands') ?? BANDS.join(','))
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (!Number.isInteger(tasks) || tasks <= 0 || tasks > TASKS.length) throw new Error(`--tasks must be 1..${TASKS.length}`);
  if (bands.length === 0) throw new Error('--bands must be a comma-separated list of positive integers');
  return {
    tasks,
    bands,
    model: argument(argv, 'model') ?? process.env.MG_MODEL ?? 'auto/deepseek-v4.1-flash',
    baseUrl: (argument(argv, 'base-url') ?? process.env.MG_BASE_URL ?? 'http://127.0.0.1:3425/v1').replace(/\/+$/, ''),
    apiKey: argument(argv, 'api-key') ?? process.env.MG_API_KEY ?? 'magpie',
    seed: Number(argument(argv, 'seed') ?? 258),
    outDir: resolve(argument(argv, 'out-dir') ?? import.meta.dir),
  };
}

function headCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.HEAD_COMMIT ?? 'unknown';
  }
}

function headers(options: Options): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` };
}

async function pricingFor(options: Options): Promise<ModelPricing | null> {
  try {
    const response = await fetch(`${options.baseUrl}/models`, { headers: headers(options), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { data?: Array<{ id?: string; pricing?: { prompt?: unknown; completion?: unknown } }> };
    const entry = payload.data?.find((model) => model.id === options.model);
    const promptPerToken = Number(entry?.pricing?.prompt);
    const completionPerToken = Number(entry?.pricing?.completion);
    return Number.isFinite(promptPerToken) && Number.isFinite(completionPerToken) ? { promptPerToken, completionPerToken } : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

interface CallOutcome {
  content: string;
  reasoning: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  estimatedUsage: boolean;
  latencyMs: number;
  attempts: number;
  error?: string;
}

async function callModel(options: Options, context: string, question: string): Promise<CallOutcome> {
  const body = {
    model: options.model,
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\n<recall-context>\n${context}\n</recall-context>` },
      { role: 'user', content: question },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
  };
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const started = performance.now();
    try {
      const response = await fetch(`${options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(options),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Math.round(performance.now() - started);
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
        if (response.status !== 429 && response.status < 500) {
          return { content: '', reasoning: '', promptTokens: 0, completionTokens: 0, estimatedUsage: false, latencyMs, attempts: attempt, error: lastError };
        }
        if (attempt < ATTEMPTS) await sleep(1_000 * attempt);
        continue;
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
      };
      const message = payload.choices?.[0]?.message;
      const content = message?.content?.trim() ?? '';
      const reasoning = message?.reasoning_content ?? '';
      const promptTokens = Number(payload.usage?.prompt_tokens);
      const completionTokens = Number(payload.usage?.completion_tokens);
      const reasoningTokens = Number(payload.usage?.completion_tokens_details?.reasoning_tokens);
      const hasUsage = Number.isFinite(promptTokens) && Number.isFinite(completionTokens);
      return {
        content,
        reasoning,
        promptTokens: hasUsage ? promptTokens : Math.ceil((SYSTEM_PROMPT.length + context.length + question.length) / 4),
        completionTokens: hasUsage ? completionTokens : Math.ceil((content.length + reasoning.length) / 4),
        reasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : undefined,
        estimatedUsage: !hasUsage,
        latencyMs,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (attempt < ATTEMPTS) await sleep(1_000 * attempt);
    }
  }
  return { content: '', reasoning: '', promptTokens: 0, completionTokens: 0, estimatedUsage: false, latencyMs: 0, attempts: ATTEMPTS, error: lastError };
}

function extractCodes(text: string): string[] {
  return [...text.toUpperCase().matchAll(/[A-Z]{2}-\d{1,3}/g)].map((match) => match[0].replace('-', ''));
}

function expectedCodes(task: Task): string[] {
  return task.facts.map((fact) => fact.code.replace('-', ''));
}

function costOf(pricing: ModelPricing | null, promptTokens: number, completionTokens: number): number | null {
  if (!pricing) return null;
  return promptTokens * pricing.promptPerToken + completionTokens * pricing.completionPerToken;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(runs: RunResult[], bands: number[]): BandSummary[] {
  return bands.map((band) => {
    const selected = runs.filter((run) => run.band === band);
    const successes = selected.filter((run) => run.success).length;
    const found = selected.reduce((sum, run) => sum + run.found, 0);
    const costs = selected.map((run) => run.costUsd).filter((cost): cost is number => cost !== null);
    const latencies = selected.map((run) => run.latencyMs);
    const promptTokens = selected.map((run) => run.promptTokens);
    return {
      band,
      tasks: selected.length,
      successes,
      successRate: selected.length === 0 ? 0 : successes / selected.length,
      factRecall: selected.length === 0 ? 0 : found / (selected.length * FACTS_PER_TASK),
      contextChars: Math.round(mean(selected.map((run) => run.contextChars))),
      contextTokens: Math.round(mean(selected.map((run) => run.contextTokens))),
      promptTokens: { mean: Math.round(mean(promptTokens)), min: Math.min(...promptTokens), max: Math.max(...promptTokens) },
      latencyMs: { mean: Math.round(mean(latencies)), median: Math.round(percentile(latencies, 0.5)), p95: Math.round(percentile(latencies, 0.95)) },
      costUsd: costs.length === 0 ? null : { total: costs.reduce((sum, cost) => sum + cost, 0), perCall: mean(costs) },
      errors: selected.filter((run) => run.error !== undefined).length,
    };
  });
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(4)}`;
}

function reading(summary: BandSummary[]): string[] {
  const rates = summary.map((entry) => entry.successRate);
  const low = Math.min(...rates);
  const high = Math.max(...rates);
  const lines: string[] = [];
  if (high - low < 0.05) {
    lines.push(`Task success is flat at ${Math.round(high * 100)}% across all ${summary.length} bands; no knee appears between ${summary[0]!.band} and ${summary[summary.length - 1]!.band}.`);
  } else {
    const firstDrop = summary.find((entry) => entry.successRate < high - 0.05);
    lines.push(`Task success is ${Math.round(high * 100)}% at its best and ${Math.round(low * 100)}% at its worst; the first band below the best rate is ${firstDrop?.band ?? 'none'}.`);
  }
  const first = summary[0]!;
  const last = summary[summary.length - 1]!;
  const tokenRatio = first.promptTokens.mean === 0 ? 0 : last.promptTokens.mean / first.promptTokens.mean;
  lines.push(`Mean provider prompt tokens grow from ${first.promptTokens.mean} to ${last.promptTokens.mean} (${tokenRatio.toFixed(1)}×); total cost grows from ${money(first.costUsd?.total ?? null)} to ${money(last.costUsd?.total ?? null)} for ${first.tasks} tasks.`);
  lines.push(`Mean latency moves from ${first.latencyMs.mean} ms to ${last.latencyMs.mean} ms; at n=${first.tasks} per band this is a point estimate, not a significance test.`);
  return lines;
}

function conclusion(summary: BandSummary[], model: string): string[] {
  const first = summary[0]!;
  const last = summary[summary.length - 1]!;
  const flat = Math.max(...summary.map((entry) => entry.successRate)) - Math.min(...summary.map((entry) => entry.successRate)) < 0.05;
  const ratio = first.contextTokens === 0 ? 0 : first.promptTokens.mean / first.contextTokens;
  const costRatio = first.costUsd && last.costUsd && first.costUsd.total > 0 ? last.costUsd.total / first.costUsd.total : 0;
  const latencyRatio = first.latencyMs.mean === 0 ? 0 : last.latencyMs.mean / first.latencyMs.mean;
  return [
    flat
      ? `No attention knee in ${first.band}–${last.band}: ${first.successes}/${first.tasks} tasks and ${Math.round(first.factRecall * 100)}% of facts at every band.`
      : `Success is not flat: ${Math.round(first.successRate * 100)}% at ${first.band} versus ${Math.round(last.successRate * 100)}% at ${last.band}.`,
    `From ${first.band} to ${last.band}, provider prompt tokens grow ${(last.promptTokens.mean / Math.max(1, first.promptTokens.mean)).toFixed(1)}×, total cost ${costRatio.toFixed(1)}×, and mean latency ${latencyRatio.toFixed(1)}×.`,
    `The shell's chars/4 unit undercounts this Chinese corpus by ${ratio.toFixed(1)}×: ${first.band} shell tokens are ${first.promptTokens.mean} provider prompt tokens.`,
    flat
      ? `On this evidence, raising \`targetTokens\` above ${first.band} buys no accuracy. Keep ${first.band} as the provisional route value for \`${model}\`; the open question is coverage (does ${first.band} keep the useful lane?), not attention.`
      : `The first band below the best rate is the knee; the route value should be set at or above it, after a second model repeats the curve.`,
    'E6 still needs a second model before the per-model value is final, and this experiment always includes the target, so it cannot show that a small budget keeps the useful lane.',
  ];
}

function report(options: Options, startedAt: string, head: string, pricing: ModelPricing | null, summary: BandSummary[], runs: RunResult[]): string {
  const lines: string[] = [
    '# Context sweet spot — #258 C3',
    '',
    `- base commit at run: \`${head}\``,
    `- run at: ${startedAt}`,
    `- model: \`${options.model}\``,
    `- endpoint: \`${options.baseUrl}\``,
    `- seed: ${options.seed}`,
    `- tasks: ${options.tasks} × ${FACTS_PER_TASK} facts`,
    '',
    '## What a band means',
    '',
    '`targetTokens` is the shell assembler\'s own unit: it fits a lane to `ceil(chars / 4)`. Each context here is one `<recall-context>` block built to `targetTokens * 4` characters, so the table shows both that shell estimate and the provider\'s `usage.prompt_tokens`. The five target lines sit at 10/30/50/70/90% depth; the rest are distractors.',
    '',
    'A distractor shares at most one cue with a target: the target entity with another attribute, another entity with a target attribute, or neither. No distractor is the target entity+attribute pair, so every question has exactly one correct answer. No dates are attached, so recency cannot be used as a shortcut.',
    '',
    '## Results',
    '',
    '| targetTokens | context chars | context tokens (chars/4) | prompt tokens (provider) | task success | fact recall | latency mean | latency p95 | cost total | cost/call | errors |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const entry of summary) {
    lines.push(`| ${entry.band} | ${entry.contextChars} | ${entry.contextTokens} | ${entry.promptTokens.mean} (${entry.promptTokens.min}–${entry.promptTokens.max}) | ${entry.successes}/${entry.tasks} (${Math.round(entry.successRate * 100)}%) | ${Math.round(entry.factRecall * 100)}% | ${entry.latencyMs.mean} ms | ${entry.latencyMs.p95} ms | ${money(entry.costUsd?.total ?? null)} | ${money(entry.costUsd?.perCall ?? null)} | ${entry.errors} |`);
  }
  lines.push(
    '',
    `Pricing from the gateway\'s \`/v1/models\` at run time: ${pricing ? `prompt $${(pricing.promptPerToken * 1_000_000).toFixed(2)}/M, completion $${(pricing.completionPerToken * 1_000_000).toFixed(2)}/M` : 'not reported, so cost is `—`'}.`,
    '',
    '## Per task',
    '',
    `| task | ${options.bands.map((band) => `${band}`).join(' | ')} |`,
    `| --- | ${options.bands.map(() => '---:').join(' | ')} |`,
  );
  for (const task of TASKS.slice(0, options.tasks)) {
    const cells = options.bands.map((band) => {
      const run = runs.find((entry) => entry.taskId === task.id && entry.band === band);
      return run ? `${run.found}/${FACTS_PER_TASK}${run.success ? ' ✓' : ''}` : '—';
    });
    lines.push(`| ${task.id} | ${cells.join(' | ')} |`);
  }

  const failures = runs.filter((run) => !run.success);
  lines.push('', '## Failures', '');
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    for (const failure of failures) {
      const task = TASKS.find((entry) => entry.id === failure.taskId);
      lines.push(`- \`${failure.taskId}\` @ ${failure.band} (${failure.found}/${FACTS_PER_TASK}) — expected \`${task?.facts.map((fact) => fact.code).join(', ')}\`; got \`${failure.content.slice(0, 300)}\`${failure.error ? `; error: ${failure.error}` : ''}`);
    }
  }

  const smallestBand = [...runs].sort((left, right) => left.band - right.band)[0];
  const entries = smallestBand?.entries ?? 0;
  lines.push(
    '',
    '## Random baseline',
    '',
    `A uniform guess over the codes present would have roughly \`1/${entries}\` chance per fact at the smallest band (the pool grows with fill), and \`1/(K·(K−1)·…·(K−4))\` for all five in order — effectively zero. The task is extraction, not multiple choice, so success is not inflated by a 25% guess rate.`,
    '',
    '## Reading',
    '',
    ...reading(summary).map((line) => `- ${line}`),
    '',
    '## Conclusion',
    '',
    ...conclusion(summary, options.model).map((line) => `- ${line}`),
    '',
    '## Limitations',
    '',
    '- The context is one recall lane sized to the band. The shell\'s six-lane assembler may drop a whole low-priority lane when the total exceeds `targetTokens`; that product behaviour is not reproduced here, and the target is always present.',
    '- One model only (`auto/deepseek-v4.1-flash`). E6 asks for at least two models before the per-model route value is final.',
    '- `temperature: 0` reduces but does not remove provider nondeterminism; re-running can move individual tasks.',
    '- The band unit is the shell\'s `chars/4` estimate. Provider tokens are shown separately; do not read the two columns as the same unit.',
  );
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const head = headCommit();
  const pricing = await pricingFor(options);
  const tasks = TASKS.slice(0, options.tasks);
  const runs: RunResult[] = [];

  console.log(`sweet-spot: ${tasks.length} tasks × ${options.bands.join('/')} bands · ${options.model}`);
  for (const band of options.bands) {
    for (const task of tasks) {
      const context = buildContext(task, band, options.seed);
      const outcome = await callModel(options, context.text, task.question);
      const content = outcome.content || outcome.reasoning;
      const codes = extractCodes(content);
      const expected = expectedCodes(task);
      const found = expected.filter((code) => codes.includes(code)).length;
      const success = codes.length === expected.length && expected.every((code, index) => codes[index] === code);
      const run: RunResult = {
        taskId: task.id,
        band,
        contextChars: context.contextChars,
        contextTokens: context.contextTokens,
        entries: context.entries,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        ...(outcome.reasoningTokens === undefined ? {} : { reasoningTokens: outcome.reasoningTokens }),
        estimatedUsage: outcome.estimatedUsage,
        latencyMs: outcome.latencyMs,
        attempts: outcome.attempts,
        costUsd: costOf(pricing, outcome.promptTokens, outcome.completionTokens),
        content: content.slice(0, 2_000),
        codes,
        found,
        success,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
      runs.push(run);
      console.log(`${run.success ? 'PASS' : 'FAIL'} ${task.id} @ ${band} · ${found}/${FACTS_PER_TASK} · ${run.promptTokens} tok · ${run.latencyMs} ms${run.error ? ` · ${run.error}` : ''}`);
    }
  }

  const summary = summarize(runs, options.bands);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(join(options.outDir, 'results.json'), `${JSON.stringify({
    at: startedAt,
    head,
    model: options.model,
    baseUrl: options.baseUrl,
    seed: options.seed,
    bands: options.bands,
    tasks: tasks.length,
    factsPerTask: FACTS_PER_TASK,
    pricing,
    summary,
    runs,
  }, null, 2)}\n`);
  writeFileSync(join(options.outDir, 'results.md'), report(options, startedAt, head, pricing, summary, runs));
  console.log(`wrote ${join(options.outDir, 'results.md')} and results.json`);
  if (runs.some((run) => run.error !== undefined)) process.exitCode = 1;
}

await main();

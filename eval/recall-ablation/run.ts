#!/usr/bin/env bun
/**
 * #343 — the memory-base double-write ablation.
 *
 * One command:
 *
 *   bun eval/recall-ablation/run.ts
 *
 * The corpus is `eval/recall-baseline/corpus.ts`: 20 memory targets written through
 * `KernelAgentMemoryBackend.rememberTurnWithResult()` and 10 practice targets written through
 * `MemoryKernel.recordTaskEvent()` + `procedures.compile()`. No product code is changed. The
 * compiled lane is switched off through the product's own `retrievalPolicy` (`allowedLanes`), so
 * the ablation is the same switch a strategy capsule uses.
 *
 * Arms:
 *
 *   raw_atlas          `graph` + `raw_source`; the legacy neuron/topology/cognitive-graph lane is off.
 *   raw_atlas_compiled all three lanes, stated explicitly. This is the control that must equal the
 *                      current path.
 *   all_current        no policy, exactly what `recall()` does today.
 *
 * It writes `results.md` / `results.json` next to this file. `--keep` leaves the scratch database
 * under `.cogmem/recall-ablation/run-*`.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createMemoryKernel, KernelAgentMemoryBackend, type AgentRecallItem } from '../../src/public.ts';
import {
  EVAL_NOW,
  MEMORY_SEEDS,
  PROCEDURE_SEEDS,
  SEEDS,
  seedText,
  type MemorySeed,
  type ProcedureSeed,
} from '../recall-baseline/corpus.ts';

const HOUR_MS = 3_600_000;
const MEMORY_PROJECT = 'recall-ablation-memory';
const PROCEDURE_PROJECT = 'recall-ablation-procedure';
const AGENT_ID = 'owner';
const MEMORY_LIMIT = MEMORY_SEEDS.length;
const PROCEDURE_LIMIT = PROCEDURE_SEEDS.length;
const MEASURED_PASSES = 5;

type Arm = 'raw_atlas' | 'raw_atlas_compiled' | 'all_current';

const ARMS: Arm[] = ['all_current', 'raw_atlas_compiled', 'raw_atlas'];

const POLICIES: Record<Arm, { allowedLanes: string[]; preferredLanes: string[] } | undefined> = {
  raw_atlas: { allowedLanes: ['graph', 'raw_source'], preferredLanes: ['graph', 'raw_source'] },
  raw_atlas_compiled: {
    allowedLanes: ['graph', 'compiled', 'raw_source'],
    preferredLanes: ['graph', 'compiled', 'raw_source'],
  },
  all_current: undefined,
};

interface ArmResult {
  arm: Arm;
  memory: Map<string, number | null>;
  procedure: Map<string, number | null>;
  recallModes: Map<string, number>;
  recallLatencyMs: number[];
  procedureLatencyMs: number[];
}

const repo = resolve(import.meta.dir, '../..');
const workRoot = join(repo, '.cogmem', 'recall-ablation');
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const keepScratch = process.argv.includes('--keep');

mkdirSync(workRoot, { recursive: true });
const scratch = mkdtempSync(join(workRoot, 'run-'));
process.env.TMPDIR ??= scratch;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function gitHead(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function shuffled<T extends { id: string }>(items: T[]): T[] {
  const withHash = items.map((item) => ({
    item,
    hash: createHash('sha256').update(item.id).digest('hex'),
  }));
  withHash.sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0));
  return withHash.map((entry) => entry.item);
}

function rankOf(order: string[], id: string): number | null {
  const index = order.indexOf(id);
  return index === -1 ? null : index + 1;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index]!;
}

function metric(ranks: Map<string, number | null>): { n: number; recall1: number; recall5: number } {
  let recall1 = 0;
  let recall5 = 0;
  for (const rank of ranks.values()) {
    if (rank !== null && rank <= 1) recall1 += 1;
    if (rank !== null && rank <= 5) recall5 += 1;
  }
  return { n: ranks.size, recall1, recall5 };
}

function percent(hits: number, total: number): string {
  return total === 0 ? 'n/a' : `${((100 * hits) / total).toFixed(1)}%`;
}

function allRanks(memory: Map<string, number | null>, procedure: Map<string, number | null>): Map<string, number | null> {
  return new Map([...memory, ...procedure]);
}

function itemSeed(item: AgentRecallItem, memoryEventToSeed: Map<string, string>): string | undefined {
  const eventId = item.sourceAnchor?.eventId ?? item.source;
  return eventId === undefined ? undefined : memoryEventToSeed.get(eventId);
}

function sameRanks(left: Map<string, number | null>, right: Map<string, number | null>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

async function main(): Promise<void> {
  if (SEEDS.length !== 30) throw new Error(`expected 30 seeds, found ${SEEDS.length}`);

  const kernel = createMemoryKernel({ dbPath: join(scratch, 'memory.db'), projectTimeZone: 'UTC' });
  const backend = new KernelAgentMemoryBackend(kernel, { agentId: AGENT_ID });
  const memoryEventToSeed = new Map<string, string>();
  const writeMs: number[] = [];
  const neuronIds = new Set<string>();

  for (const [index, seed] of shuffled(MEMORY_SEEDS).entries()) {
    const started = performance.now();
    const result = await backend.rememberTurnWithResult({
      agentId: AGENT_ID,
      projectId: MEMORY_PROJECT,
      sessionId: `mem-${seed.id}`,
      threadId: `mem-${seed.id}`,
      userText: seed.text,
      timestamp: EVAL_NOW - (MEMORY_SEEDS.length - index) * HOUR_MS,
    });
    writeMs.push(performance.now() - started);
    if (!result.compiledNeuronId || result.duplicate) throw new Error(`memory seed ${seed.id} did not compile: ${result.reason}`);
    if (neuronIds.has(result.compiledNeuronId)) throw new Error(`memory seed ${seed.id} reused a neuron`);
    neuronIds.add(result.compiledNeuronId);
    memoryEventToSeed.set(result.rawEventIds[0]!, seed.id);
  }

  const procedureOrder = shuffled(PROCEDURE_SEEDS);
  for (const [index, seed] of procedureOrder.entries()) {
    kernel.recordTaskEvent({
      projectId: PROCEDURE_PROJECT,
      threadId: `proc-${seed.id}`,
      role: 'system',
      content: 'task completed',
      occurredAt: EVAL_NOW - (procedureOrder.length - index) * HOUR_MS,
      metadata: {
        procedure: {
          domain: seed.domain,
          key: seed.key,
          title: seed.title,
          steps: seed.steps,
          tools: seed.tools,
          outcome: 'succeeded',
        },
      },
    });
  }
  kernel.procedures.compile({ projectId: PROCEDURE_PROJECT, now: EVAL_NOW });
  const procedureEntryToSeed = new Map<string, string>();
  const entries = kernel.procedures.entries({ projectId: PROCEDURE_PROJECT });
  if (entries.length !== PROCEDURE_SEEDS.length) {
    throw new Error(`expected ${PROCEDURE_SEEDS.length} procedure entries, found ${entries.length}`);
  }
  for (const seed of PROCEDURE_SEEDS) {
    const entry = entries.find((candidate) => candidate.domain === seed.domain && candidate.key === seed.key);
    if (!entry) throw new Error(`procedure seed ${seed.id} has no compiled entry`);
    procedureEntryToSeed.set(entry.entryId, seed.id);
  }

  const profileEntries = kernel.profile.recall({ projectId: MEMORY_PROJECT, query: MEMORY_SEEDS[0]!.query, now: EVAL_NOW });

  const results: ArmResult[] = [];
  for (const arm of ARMS) {
    const policy = POLICIES[arm];
    const memory = new Map<string, number | null>();
    const procedure = new Map<string, number | null>();
    const recallModes = new Map<string, number>();
    const recallLatencyMs: number[] = [];
    const procedureLatencyMs: number[] = [];

    const memoryRecall = (seed: MemorySeed): AgentRecallItem[] => {
      const result = backend.recall({
        agentId: AGENT_ID,
        projectId: MEMORY_PROJECT,
        query: seed.query,
        limit: MEMORY_LIMIT,
        now: EVAL_NOW,
        timeZone: 'UTC',
        localDateNow: '2026-11-16',
        ...(policy === undefined ? {} : { retrievalPolicy: policy as never }),
      });
      recallModes.set(result.recallMode, (recallModes.get(result.recallMode) ?? 0) + 1);
      return result.items;
    };
    const procedureRecall = (seed: ProcedureSeed): string[] =>
      kernel.procedures
        .recall({ projectId: PROCEDURE_PROJECT, task: seed.query, limit: PROCEDURE_LIMIT, now: EVAL_NOW })
        .map((hit) => procedureEntryToSeed.get(hit.entryId) ?? '?');

    // Warm every cache before the measured passes, then repeat so p50/p95 are not first-call noise.
    for (const seed of MEMORY_SEEDS) memoryRecall(seed);
    for (const seed of PROCEDURE_SEEDS) procedureRecall(seed);

    for (let pass = 0; pass < MEASURED_PASSES; pass += 1) {
      for (const seed of MEMORY_SEEDS) {
        const started = performance.now();
        const items = memoryRecall(seed);
        recallLatencyMs.push(performance.now() - started);
        const rank = rankOf(items.map((item) => itemSeed(item, memoryEventToSeed) ?? '?'), seed.id);
        if (pass === 0) memory.set(seed.id, rank);
        else if (memory.get(seed.id) !== rank) throw new Error(`${arm}: ${seed.id} rank changed between passes`);
      }
      for (const seed of PROCEDURE_SEEDS) {
        const started = performance.now();
        const order = procedureRecall(seed);
        procedureLatencyMs.push(performance.now() - started);
        const rank = rankOf(order, seed.id);
        if (pass === 0) procedure.set(seed.id, rank);
        else if (procedure.get(seed.id) !== rank) throw new Error(`${arm}: ${seed.id} procedure rank changed between passes`);
      }
    }
    results.push({ arm, memory, procedure, recallModes, recallLatencyMs, procedureLatencyMs });
  }

  const current = results.find((result) => result.arm === 'all_current')!;
  const explicit = results.find((result) => result.arm === 'raw_atlas_compiled')!;
  const controlMatches = sameRanks(current.memory, explicit.memory) && sameRanks(current.procedure, explicit.procedure);
  if (!controlMatches) throw new Error('control failed: explicit raw+atlas+compiled ranks differ from the current path');

  const eventCounts = kernel.eventStore
    .queryEvents(1, 10_000, { projectId: [MEMORY_PROJECT] })
    .records.reduce<Record<string, number>>((counts, event) => {
      const type = String(event.eventType ?? 'unknown');
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {});

  const head = gitHead();
  const markdown = renderMarkdown({ head, results, writeMs, eventCounts, profileEntries: profileEntries.length, controlMatches });
  const json = {
    head,
    runAt: new Date().toISOString(),
    bun: process.versions.bun,
    platform: process.platform,
    arch: process.arch,
    evalNow: EVAL_NOW,
    corpus: { seeds: SEEDS.length, memory: MEMORY_SEEDS.length, procedure: PROCEDURE_SEEDS.length },
    arms: results.map((result) => ({
      arm: result.arm,
      memory: Object.fromEntries(result.memory),
      procedure: Object.fromEntries(result.procedure),
      recallModes: Object.fromEntries(result.recallModes),
      recallLatencyMs: {
        p50: percentile(result.recallLatencyMs, 0.5),
        p95: percentile(result.recallLatencyMs, 0.95),
        n: result.recallLatencyMs.length,
      },
      procedureLatencyMs: {
        p50: percentile(result.procedureLatencyMs, 0.5),
        p95: percentile(result.procedureLatencyMs, 0.95),
        n: result.procedureLatencyMs.length,
      },
    })),
    writeMs: { p50: percentile(writeMs, 0.5), p95: percentile(writeMs, 0.95), n: writeMs.length },
    eventCounts,
    profileEntries: profileEntries.length,
    controlMatches,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.md'), markdown);
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(json, null, 2)}\n`);
  console.log(markdown);
  if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
  kernel.close();
}

function renderMarkdown(input: {
  head: string;
  results: ArmResult[];
  writeMs: number[];
  eventCounts: Record<string, number>;
  profileEntries: number;
  controlMatches: boolean;
}): string {
  const lines: string[] = [
    '# Recall ablation — #343',
    '',
    `- base commit at run: \`${input.head}\``,
    `- run at: ${new Date().toISOString()}`,
    `- bun: ${process.versions.bun} · ${process.platform}/${process.arch}`,
    '',
    '## Protocol',
    '',
    '- Corpus: `eval/recall-baseline/corpus.ts` — 20 memory targets and 10 practice targets.',
    '- Memory seeds are written through `KernelAgentMemoryBackend.rememberTurnWithResult()`; practice seeds through `MemoryKernel.recordTaskEvent()` + `procedures.compile()`. No SQL inserts the corpus.',
    '- `raw_atlas` uses `retrievalPolicy.allowedLanes = [graph, raw_source]`; `raw_atlas_compiled` states all three lanes; `all_current` omits the policy, which is the current `recall()` path.',
    `- Each arm is warmed once, then measured over ${MEASURED_PASSES} passes of all 30 queries. Ranks are asserted stable across passes.`,
    '- No product code is changed. The scratch database and temporary files live under `.cogmem/`, which is gitignored.',
    '',
    '## Results',
    '',
    '| arm | memory @1 (n=20) | memory @5 | procedure @1 (n=10) | procedure @5 | all @1 (n=30) | all @5 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of input.results) {
    const memory = metric(result.memory);
    const procedure = metric(result.procedure);
    const all = metric(allRanks(result.memory, result.procedure));
    lines.push(
      `| ${result.arm} | ${percent(memory.recall1, memory.n)} | ${percent(memory.recall5, memory.n)} | ` +
        `${percent(procedure.recall1, procedure.n)} | ${percent(procedure.recall5, procedure.n)} | ` +
        `${percent(all.recall1, all.n)} | ${percent(all.recall5, all.n)} |`,
    );
  }
  lines.push(
    '',
    '## Latency',
    '',
    '| arm | recall p50 | recall p95 | samples | procedure p50 | procedure p95 | samples |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const result of input.results) {
    lines.push(
      `| ${result.arm} | ${percentile(result.recallLatencyMs, 0.5).toFixed(2)} ms | ${percentile(result.recallLatencyMs, 0.95).toFixed(2)} ms | ${result.recallLatencyMs.length} | ` +
        `${percentile(result.procedureLatencyMs, 0.5).toFixed(2)} ms | ${percentile(result.procedureLatencyMs, 0.95).toFixed(2)} ms | ${result.procedureLatencyMs.length} |`,
    );
  }
  lines.push(
    '',
    '## Write cost',
    '',
    `- per-turn write p50: ${percentile(input.writeMs, 0.5).toFixed(1)} ms · p95: ${percentile(input.writeMs, 0.95).toFixed(1)} ms · n=${input.writeMs.length}`,
    '- ledger rows by type (memory project):',
    '',
    '| event type | rows |',
    '| --- | ---: |',
    ...Object.entries(input.eventCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => `| ${type} | ${count} |`),
    '',
    '## Lane evidence',
    '',
    '| arm | recallMode (queries) |',
    '| --- | --- |',
    ...input.results.map(
      (result) => `| ${result.arm} | ${[...result.recallModes].map(([mode, count]) => `${mode} × ${count}`).join(', ')} |`,
    ),
    '',
    '## Controls',
    '',
    `- \`raw_atlas_compiled\` ranks equal \`all_current\`: ${input.controlMatches ? 'yes' : 'NO'}.`,
    `- Profile entries compiled from this corpus: ${input.profileEntries}. The lane-policy arm also disables profile (\`withProfileItems\` is gated by \`compiled\`), so a zero makes that confound measurable rather than assumed.`,
    '',
    '## Reading',
    '',
  );

  const current = input.results.find((result) => result.arm === 'all_current')!;
  const off = input.results.find((result) => result.arm === 'raw_atlas')!;
  const currentAll = metric(allRanks(current.memory, current.procedure));
  const offAll = metric(allRanks(off.memory, off.procedure));
  const delta5 = ((100 * offAll.recall5) / offAll.n) - ((100 * currentAll.recall5) / currentAll.n);
  lines.push(
    `- Turning the compiled lane off moved all-corpus recall@5 by ${delta5 >= 0 ? '+' : ''}${delta5.toFixed(1)} points ` +
      `(${percent(currentAll.recall5, currentAll.n)} → ${percent(offAll.recall5, offAll.n)}).`,
    '- This is a measurement, not a keep/delete decision. The decision belongs to Ryu in #343 after these numbers land.',
    '',
  );
  return lines.join('\n');
}

await main();

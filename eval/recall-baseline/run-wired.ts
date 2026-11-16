#!/usr/bin/env bun
/**
 * #250 — the same 30 paraphrase queries through the *wired* recall path.
 *
 * `run.ts` measured the arms in isolation. This script measures what the shell now actually does:
 * a real kernel with the local `Xenova/bge-base-zh-v1.5` provider, neurons written through
 * `KernelAgentMemoryBackend.rememberTurnWithResult()` (so the write path embeds them), and recall
 * through `KernelAgentMemoryBackend.recall()`.
 *
 *   bun eval/recall-baseline/run-wired.ts
 *
 * The model cache defaults to `.cogmem/recall-wired/models`; `--cache-dir` points at an existing
 * download. Nothing here writes to the live companion data directory.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { createMemoryKernel, KernelAgentMemoryBackend } from '../../src/public.ts';
import { ModelRegistry } from '../../src/models/ModelRegistry.ts';
import { XenovaEmbeddingProvider } from '../../shell/src/embedding/xenova.ts';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../shell/src/embedding/model.ts';
import { EVAL_NOW, MEMORY_SEEDS, PROCEDURE_SEEDS, seedText, type Seed } from './corpus.ts';

const HOUR_MS = 3_600_000;
const MEMORY_PROJECT = 'recall-wired-memory';
const PROCEDURE_PROJECT = 'recall-wired-procedure';
const AGENT_ID = 'owner';

const repo = resolve(import.meta.dir, '../..');
const workRoot = join(repo, '.cogmem', 'recall-wired');
const cacheDir = resolve(argument('cache-dir') ?? join(workRoot, 'models'));
const keepScratch = process.argv.includes('--keep');

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function shuffled<T extends { id: string }>(items: T[]): T[] {
  return items
    .map((item) => ({ item, hash: createHash('sha256').update(item.id).digest('hex') }))
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))
    .map((entry) => entry.item);
}

function rankOf(order: string[], target: string): number | null {
  const index = order.indexOf(target);
  return index === -1 ? null : index + 1;
}

function peakRssBytes(): number {
  const match = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(readFileSync('/proc/self/status', 'utf8'));
  return match ? Number(match[1]) * 1024 : 0;
}

async function waitForEmbeddings(kernel: ReturnType<typeof createMemoryKernel>, expected: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (kernel.neuronEmbeddingStore.getProgress().total >= expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`embeddings did not settle: ${kernel.neuronEmbeddingStore.getProgress().total}/${expected}`);
}

async function main(): Promise<void> {
  mkdirSync(workRoot, { recursive: true });
  if (!existsSync(cacheDir)) {
    throw new Error(`no model cache at ${cacheDir}; run with --cache-dir or let the shell download it`);
  }
  const dataDir = mkdtempSync(join(workRoot, 'run-'));
  const models = join(dataDir, 'models');
  mkdirSync(join(models, 'Xenova'), { recursive: true });
  // The provider resolves `<dataDir>/models`; copy the shared download so the cache stays read-only.
  cpSync(join(cacheDir, EMBEDDING_MODEL), join(models, EMBEDDING_MODEL), { recursive: true });
  process.env.TMPDIR ??= dataDir;

  const dbPath = join(dataDir, 'memory.db');
  const provider = new XenovaEmbeddingProvider(dataDir);
  const registry = new ModelRegistry({
    memory: { role: 'memory', provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', modelName: 'unused', timeoutMs: 1_000, maxTokens: 1024, fallback: 'rule_only' },
    reasoning: { role: 'reasoning', provider: 'rule_only', modelName: 'rule_only', timeoutMs: 1_000, fallback: 'memory' },
    // Deterministic at construction, like the shell: the kernel builds its write-path embedder from
    // this role, and the real vectors come from `embeddingProvider`. Flip it after the load so
    // `semanticIndexEnabled()` reports the truth the shell reports.
    embedding: { role: 'embedding', provider: 'deterministic_local', modelName: 'deterministic_local', timeoutMs: 30_000 },
  });
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC', modelRegistry: registry, embeddingProvider: provider });
  const backend = new KernelAgentMemoryBackend(kernel, { agentId: AGENT_ID });
  // The provider unrefs its worker so a resident can exit; a standalone script has no tick timer, so
  // hold the event loop for the duration of the measurement.
  const keepAlive = setInterval(() => {}, 1_000);

  const loadStarted = performance.now();
  await provider.warm();
  const loadMs = Math.round(performance.now() - loadStarted);
  (registry as unknown as { config: { embedding: Record<string, unknown> } }).config.embedding = {
    role: 'embedding', provider: 'openai_compatible', modelName: EMBEDDING_MODEL, timeoutMs: 30_000,
  };
  const semanticIndex = kernel.semanticIndexEnabled();

  const memoryEventToSeed = new Map<string, string>();
  const neuronToSeed = new Map<string, string>();
  const neuronIds = new Set<string>();
  for (const [index, seed] of shuffled(MEMORY_SEEDS).entries()) {
    const result = await backend.rememberTurnWithResult({
      agentId: AGENT_ID,
      projectId: MEMORY_PROJECT,
      sessionId: `mem-${seed.id}`,
      threadId: `mem-${seed.id}`,
      userText: seed.text,
      timestamp: EVAL_NOW - (MEMORY_SEEDS.length - index) * HOUR_MS,
    });
    if (!result.compiledNeuronId || result.duplicate) throw new Error(`memory seed ${seed.id} did not compile: ${result.reason}`);
    neuronIds.add(result.compiledNeuronId);
    neuronToSeed.set(result.compiledNeuronId, seed.id);
    memoryEventToSeed.set(result.rawEventIds[0]!, seed.id);
  }
  await waitForEmbeddings(kernel, MEMORY_SEEDS.length);

  for (const [index, seed] of shuffled(PROCEDURE_SEEDS).entries()) {
    kernel.recordTaskEvent({
      projectId: PROCEDURE_PROJECT,
      threadId: `proc-${seed.id}`,
      role: 'system',
      content: 'task completed',
      occurredAt: EVAL_NOW - (PROCEDURE_SEEDS.length - index) * HOUR_MS,
      metadata: {
        procedure: { domain: seed.domain, key: seed.key, title: seed.title, steps: seed.steps, tools: seed.tools, outcome: 'succeeded' },
      },
    });
  }
  kernel.procedures.compile({ projectId: PROCEDURE_PROJECT, now: EVAL_NOW });
  const entries = kernel.procedures.entries({ projectId: PROCEDURE_PROJECT });
  const procedureEntryToSeed = new Map(entries.map((entry) => {
    const seed = PROCEDURE_SEEDS.find((candidate) => candidate.domain === entry.domain && candidate.key === entry.key);
    return [entry.entryId, seed?.id ?? '?'];
  }));

  const firstPass = await kernel.reEmbed(MEMORY_PROJECT);
  const secondPass = await kernel.reEmbed(MEMORY_PROJECT);

  const queryStarted = performance.now();
  const memoryRanks = new Map<string, number | null>();
  const evidenceRanks = new Map<string, number | null>();
  for (const seed of MEMORY_SEEDS) {
    const result = backend.recall({
      agentId: AGENT_ID,
      projectId: MEMORY_PROJECT,
      query: seed.query,
      limit: MEMORY_SEEDS.length,
      now: EVAL_NOW,
      timeZone: 'UTC',
      localDateNow: '2026-11-16',
    });
    const order = result.items.map((item) => {
      const eventId = item.sourceAnchor?.eventId ?? item.source;
      return eventId ? (memoryEventToSeed.get(eventId) ?? '?') : '?';
    });
    memoryRanks.set(seed.id, rankOf(order, seed.id));
    // The kernel's own evidence lane (`BrainRecall`), which does consult the vector index. The
    // shell's `recall()` sits above it and can return `universe_navigation` first; keeping both
    // numbers is what makes that difference visible instead of averaged away.
    const evidence = kernel.evidenceFor(seed.query, {
      projectId: MEMORY_PROJECT,
      limit: MEMORY_SEEDS.length,
      includeRawEvidence: true,
      now: EVAL_NOW,
      timeZone: 'UTC',
      localDateNow: '2026-11-16',
    });
    const evidenceOrder = evidence.rawEvidence.map((neuron) => neuronToSeed.get(neuron.id) ?? '?');
    evidenceRanks.set(seed.id, rankOf(evidenceOrder, seed.id));
  }
  const procedureRanks = new Map<string, number | null>();
  for (const seed of PROCEDURE_SEEDS) {
    const hits = kernel.procedures.recall({ projectId: PROCEDURE_PROJECT, task: seed.query, limit: PROCEDURE_SEEDS.length, now: EVAL_NOW });
    procedureRanks.set(seed.id, rankOf(hits.map((entry) => procedureEntryToSeed.get(entry.entryId) ?? '?'), seed.id));
  }
  const queryMs = Math.round(performance.now() - queryStarted);

  const metric = (ranks: Map<string, number | null>) => {
    let one = 0;
    let five = 0;
    for (const rank of ranks.values()) {
      if (rank !== null && rank <= 1) one += 1;
      if (rank !== null && rank <= 5) five += 1;
    }
    return { n: ranks.size, recall1: one / ranks.size, recall5: five / ranks.size };
  };
  const memory = metric(memoryRanks);
  const evidence = metric(evidenceRanks);
  const procedure = metric(procedureRanks);
  const all = { n: 30, recall1: (memory.recall1 * 20 + procedure.recall1 * 10) / 30, recall5: (memory.recall5 * 20 + procedure.recall5 * 10) / 30 };
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  const peakMb = Math.round(peakRssBytes() / 1048576);

  const report = {
    at: new Date().toISOString(),
    head: process.env.HEAD_COMMIT ?? 'unknown',
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    semanticIndex,
    loadMs,
    queryMs,
    reEmbed: { first: firstPass, second: secondPass },
    metrics: { memory, procedure, all },
    evidenceLane: evidence,
    rssMb,
    peakMb,
    misses: {
      memory: [...memoryRanks].filter(([, rank]) => rank === null || rank > 5).map(([id, rank]) => ({ id, rank })),
      procedure: [...procedureRanks].filter(([, rank]) => rank === null || rank > 5).map(([id, rank]) => ({ id, rank })),
    },
  };
  writeFileSync(join(import.meta.dir, 'results-wired.json'), `${JSON.stringify(report, null, 2)}\n`);

  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const markdown = [
    '# Recall through the wired path — #250',
    '',
    `- model: \`${EMBEDDING_MODEL}\` (${EMBEDDING_DIMENSIONS}d), semanticIndex=${semanticIndex}`,
    `- load: ${loadMs} ms; 30 queries: ${queryMs} ms; RSS ${rssMb} MiB; peak ${peakMb} MiB`,
    `- reEmbed: first ${firstPass.processed} processed / ${firstPass.remaining} remaining; second ${secondPass.processed} / ${secondPass.remaining}`,
    '',
    '| corpus | recall@1 | recall@5 |',
    '| --- | ---: | ---: |',
    `| memory (n=${memory.n}) | ${pct(memory.recall1)} | ${pct(memory.recall5)} |`,
    `| memory — kernel evidence lane (n=${evidence.n}) | ${pct(evidence.recall1)} | ${pct(evidence.recall5)} |`,
    `| procedure (n=${procedure.n}) | ${pct(procedure.recall1)} | ${pct(procedure.recall5)} |`,
    `| all (n=30) | ${pct(all.recall1)} | ${pct(all.recall5)} |`,
    '',
  ].join('\n');
  writeFileSync(join(import.meta.dir, 'results-wired.md'), markdown);
  process.stdout.write(markdown);

  provider.dispose();
  kernel.close();
  clearInterval(keepAlive);
  if (!keepScratch) rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

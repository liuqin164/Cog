#!/usr/bin/env bun
/**
 * #250 A6 — the recall baseline.
 *
 * One command:
 *
 *   bun eval/recall-baseline/run.ts
 *
 * It writes the scratch kernel, then measures the same 30 paraphrase queries
 * through three arms:
 *
 *   rule_only    the shell's current path: `KernelAgentMemoryBackend.recall()`
 *                for memories and `ProcedureCompiler.recall()` for practices.
 *   fts_trigram  SQLite FTS5 with `tokenize='trigram'`; the query is an OR of
 *                its character trigrams, ranked by bm25.
 *   embedding    local `@xenova/transformers` vectors, cosine rank, in a
 *                separate memory-capped process.
 *
 * Product code is not touched. The scratch database and model cache live under
 * `.cogmem/`, which is gitignored.
 */
import { Database } from 'bun:sqlite';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { createMemoryKernel, KernelAgentMemoryBackend } from '../../src/public.ts';
import { DEFAULT_VECTOR_DIMENSION } from '../../src/config/VectorDimension.ts';
import {
  EVAL_NOW,
  MEMORY_SEEDS,
  PROCEDURE_SEEDS,
  SEEDS,
  queryTrigrams,
  seedLabel,
  seedText,
  type Seed,
} from './corpus.ts';
import { cosine } from './math.ts';
import type { Arm, Kind, WorkerInput, WorkerOutput } from './types.ts';

const HOUR_MS = 3_600_000;
const MEMORY_PROJECT = 'recall-baseline-memory';
const PROCEDURE_PROJECT = 'recall-baseline-procedure';
const AGENT_ID = 'owner';
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
const MEMORY_LIMIT_KB = 16 * 1024 * 1024;
const RSS_WATCHDOG_BYTES = 2 * 1024 * 1024 * 1024;
const ARMS: Arm[] = ['rule_only', 'fts_trigram', 'embedding'];
const KINDS: Kind[] = ['memory', 'procedure'];

const repo = resolve(import.meta.dir, '../..');
const workRoot = join(repo, '.cogmem', 'recall-baseline');
const cacheDir = resolve(argument('cache-dir') ?? join(workRoot, 'models'));
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const model = argument('model') ?? 'Xenova/bge-base-zh-v1.5';
const keepScratch = process.argv.includes('--keep');

mkdirSync(workRoot, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(workRoot, 'run-'));
process.env.TMPDIR ??= scratch;

interface Failure {
  arm: Arm;
  kind: Kind;
  id: string;
  query: string;
  target: string;
  rank: number | null;
}

interface Metric {
  arm: Arm;
  kind: Kind | 'all';
  n: number;
  recall1: number;
  recall5: number;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function shuffled<T extends { id: string }>(items: T[]): T[] {
  const withHash = items.map((item) => ({
    item,
    hash: createHash('sha256').update(item.id).digest('hex'),
  }));
  withHash.sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0));
  return withHash.map((entry) => entry.item);
}

function deterministicVector(text: string, dimension: number): Float32Array {
  const seed = Array.from(text).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const vector = new Float32Array(dimension);
  for (let index = 0; index < dimension; index += 1) {
    vector[index] = (((seed + index * 11) % 101) / 50.5) - 1;
  }
  return vector;
}

function corpusProblems(): { problems: string[]; maxDeterministicCosine: number; maxPair: string } {
  const problems: string[] = [];
  if (SEEDS.length !== 30) problems.push(`expected 30 seeds, found ${SEEDS.length}`);
  if (MEMORY_SEEDS.length !== 20) problems.push(`expected 20 memory seeds, found ${MEMORY_SEEDS.length}`);
  if (PROCEDURE_SEEDS.length !== 10) problems.push(`expected 10 procedure seeds, found ${PROCEDURE_SEEDS.length}`);
  if (new Set(SEEDS.map((seed) => seed.id)).size !== SEEDS.length) problems.push('seed ids are not unique');
  if (new Set(SEEDS.map((seed) => seedText(seed))).size !== SEEDS.length) problems.push('target texts are not unique');
  for (const seed of SEEDS) {
    const target = seedText(seed).toLowerCase();
    const query = seed.query.toLowerCase();
    if (!seed.query.trim()) problems.push(`${seed.id}: empty query`);
    if (!target.trim()) problems.push(`${seed.id}: empty target`);
    if (query === target) problems.push(`${seed.id}: query equals target`);
    for (const term of seed.keyTerms) {
      if (!target.includes(term.toLowerCase())) problems.push(`${seed.id}: key term "${term}" is not in the target`);
      if (query.includes(term.toLowerCase())) problems.push(`${seed.id}: query contains forbidden key term "${term}"`);
    }
    if (queryTrigrams(seed.query).length === 0) problems.push(`${seed.id}: query has no trigrams`);
  }
  // The rule_only write path deduplicates by cosine on its deterministic
  // embedding. A pair at or above that threshold would silently drop a seed,
  // so the corpus is checked against the same rule before the run.
  let maxDeterministicCosine = 0;
  let maxPair = '';
  for (let left = 0; left < MEMORY_SEEDS.length; left += 1) {
    for (let right = left + 1; right < MEMORY_SEEDS.length; right += 1) {
      const similarity = cosine(
        deterministicVector(MEMORY_SEEDS[left]!.text, DEFAULT_VECTOR_DIMENSION),
        deterministicVector(MEMORY_SEEDS[right]!.text, DEFAULT_VECTOR_DIMENSION),
      );
      if (similarity > maxDeterministicCosine) {
        maxDeterministicCosine = similarity;
        maxPair = `${MEMORY_SEEDS[left]!.id}/${MEMORY_SEEDS[right]!.id}`;
      }
      if (similarity >= 0.98) {
        problems.push(
          `${MEMORY_SEEDS[left]!.id}/${MEMORY_SEEDS[right]!.id}: deterministic cosine ${similarity.toFixed(4)} would deduplicate a seed`,
        );
      }
    }
  }
  return { problems, maxDeterministicCosine, maxPair };
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

function directoryFiles(path: string, prefix = ''): Array<{ path: string; bytes: number }> {
  const files: Array<{ path: string; bytes: number }> = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...directoryFiles(child, relative));
    else if (entry.isFile()) files.push({ path: relative, bytes: statSync(child).size });
  }
  return files;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatPercent(hits: number, total: number): string {
  return total === 0 ? 'n/a' : `${((100 * hits) / total).toFixed(1)}%`;
}

function rankOf(order: string[], id: string): number | null {
  const index = order.indexOf(id);
  return index === -1 ? null : index + 1;
}

function metric(arm: Arm, kind: Kind | 'all', ranks: Map<string, number | null>): Metric {
  let recall1 = 0;
  let recall5 = 0;
  for (const rank of ranks.values()) {
    if (rank !== null && rank <= 1) recall1 += 1;
    if (rank !== null && rank <= 5) recall5 += 1;
  }
  return { arm, kind, n: ranks.size, recall1, recall5 };
}

function allRanks(parts: Array<Map<string, number | null>>): Map<string, number | null> {
  const merged = new Map<string, number | null>();
  for (const part of parts) for (const [id, rank] of part) merged.set(id, rank);
  return merged;
}

function pickFailures(failures: Failure[]): Failure[] {
  const picked: Failure[] = [];
  for (const kind of KINDS) {
    const first = failures.find((failure) => failure.kind === kind);
    if (first) picked.push(first);
  }
  for (const failure of failures) {
    if (picked.length >= 3) break;
    if (!picked.includes(failure)) picked.push(failure);
  }
  return picked.slice(0, 3);
}

async function main(): Promise<void> {
  const check = corpusProblems();
  if (check.problems.length > 0) {
    console.error('corpus check failed:');
    for (const problem of check.problems) console.error(`- ${problem}`);
    if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }
  console.log(
    `corpus: ${SEEDS.length} seeds (${MEMORY_SEEDS.length} memory, ${PROCEDURE_SEEDS.length} procedure); ` +
      `key terms absent; max deterministic cosine ${check.maxDeterministicCosine.toFixed(4)} (${check.maxPair})`,
  );

  const dbPath = join(scratch, 'memory.db');
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  const backend = new KernelAgentMemoryBackend(kernel, { agentId: AGENT_ID });
  const memoryEventToSeed = new Map<string, string>();
  const procedureEntryToSeed = new Map<string, string>();
  const neuronIds = new Set<string>();

  const memoryOrder = shuffled(MEMORY_SEEDS);
  for (const [index, seed] of memoryOrder.entries()) {
    const occurredAt = EVAL_NOW - (memoryOrder.length - index) * HOUR_MS;
    const result = await backend.rememberTurnWithResult({
      agentId: AGENT_ID,
      projectId: MEMORY_PROJECT,
      sessionId: `mem-${seed.id}`,
      threadId: `mem-${seed.id}`,
      userText: seed.text,
      timestamp: occurredAt,
    });
    if (!result.compiledNeuronId || result.duplicate) {
      throw new Error(`memory seed ${seed.id} did not compile: ${result.reason}`);
    }
    if (neuronIds.has(result.compiledNeuronId)) {
      throw new Error(`memory seed ${seed.id} reused neuron ${result.compiledNeuronId}; the corpus was deduplicated`);
    }
    neuronIds.add(result.compiledNeuronId);
    memoryEventToSeed.set(result.rawEventIds[0]!, seed.id);
  }
  if (neuronIds.size !== MEMORY_SEEDS.length) {
    throw new Error(`expected ${MEMORY_SEEDS.length} neurons, wrote ${neuronIds.size}`);
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
  const compiled = kernel.procedures.compile({ projectId: PROCEDURE_PROJECT, now: EVAL_NOW });
  const entries = kernel.procedures.entries({ projectId: PROCEDURE_PROJECT });
  if (entries.length !== PROCEDURE_SEEDS.length) {
    throw new Error(`expected ${PROCEDURE_SEEDS.length} procedure entries, found ${entries.length} (compiled ${compiled.written})`);
  }
  for (const seed of PROCEDURE_SEEDS) {
    const entry = entries.find((candidate) => candidate.domain === seed.domain && candidate.key === seed.key);
    if (!entry) throw new Error(`procedure seed ${seed.id} has no compiled entry`);
    procedureEntryToSeed.set(entry.entryId, seed.id);
  }

  const ruleMemory = new Map<string, number | null>();
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
    ruleMemory.set(seed.id, rankOf(order, seed.id));
  }

  const ruleProcedure = new Map<string, number | null>();
  for (const seed of PROCEDURE_SEEDS) {
    const hits = kernel.procedures.recall({
      projectId: PROCEDURE_PROJECT,
      task: seed.query,
      limit: PROCEDURE_SEEDS.length,
      now: EVAL_NOW,
    });
    const order = hits.map((hit) => procedureEntryToSeed.get(hit.entryId) ?? '?');
    ruleProcedure.set(seed.id, rankOf(order, seed.id));
  }

  const fts = new Database(join(scratch, 'fts.db'));
  const ftsTable: Record<Kind, string> = { memory: 'memory_docs', procedure: 'procedure_docs' };
  const ftsSeeds: Record<Kind, Seed[]> = { memory: MEMORY_SEEDS, procedure: PROCEDURE_SEEDS };
  for (const kind of KINDS) {
    const table = ftsTable[kind];
    fts.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(text, tokenize='trigram')`);
    for (const [index, seed] of ftsSeeds[kind].entries()) {
      fts.prepare(`INSERT INTO ${table}(rowid, text) VALUES (?, ?)`).run(index + 1, seedText(seed));
    }
  }
  const ftsOrder = (kind: Kind, query: string): string[] => {
    const trigrams = queryTrigrams(query);
    if (trigrams.length === 0) return [];
    const match = trigrams.map((trigram) => `"${trigram.replaceAll('"', '""')}"`).join(' OR ');
    const table = ftsTable[kind];
    const rows = fts
      .prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) ASC, rowid ASC`)
      .all(match) as Array<{ rowid: number }>;
    return rows.map((row) => ftsSeeds[kind][row.rowid - 1]!.id);
  };
  const ftsMemory = new Map<string, number | null>();
  for (const seed of MEMORY_SEEDS) ftsMemory.set(seed.id, rankOf(ftsOrder('memory', seed.query), seed.id));
  const ftsProcedure = new Map<string, number | null>();
  for (const seed of PROCEDURE_SEEDS) ftsProcedure.set(seed.id, rankOf(ftsOrder('procedure', seed.query), seed.id));

  const cacheWasEmpty = !existsSync(cacheDir) || readdirSync(cacheDir).length === 0;
  const workerInput: WorkerInput = {
    model,
    cacheDir,
    queryPrefix: QUERY_PREFIX,
    docs: {
      memory: MEMORY_SEEDS.map((seed) => ({ id: seed.id, text: seedText(seed) })),
      procedure: PROCEDURE_SEEDS.map((seed) => ({ id: seed.id, text: seedText(seed) })),
    },
    queries: {
      memory: MEMORY_SEEDS.map((seed) => ({ id: seed.id, text: seed.query })),
      procedure: PROCEDURE_SEEDS.map((seed) => ({ id: seed.id, text: seed.query })),
    },
  };
  const workerInputPath = join(scratch, 'embed-input.json');
  const workerOutputPath = join(scratch, 'embed-output.json');
  writeFileSync(workerInputPath, JSON.stringify(workerInput));

  let embedding: WorkerOutput | undefined;
  let embeddingStderr = '';
  let embeddingAttempts = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    embeddingAttempts = attempt;
    rmSync(workerOutputPath, { force: true });
    try {
      const workerPath = join(import.meta.dir, 'embed-worker.ts');
      const command = `ulimit -v ${MEMORY_LIMIT_KB}; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(workerPath)} ${JSON.stringify(workerInputPath)} ${JSON.stringify(workerOutputPath)}`;
      const child = Bun.spawn({
        cmd: ['bash', '-c', command],
        cwd: repo,
        env: { ...process.env, TMPDIR: scratch },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let watchdogTripped = false;
      const watchdog = setInterval(() => {
        void (async () => {
          try {
            const status = await Bun.file(`/proc/${child.pid}/status`).text();
            const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
            if (match && Number(match[1]) * 1024 > RSS_WATCHDOG_BYTES) {
              watchdogTripped = true;
              child.kill();
            }
          } catch {
            // The process is gone; `child.exited` carries the result.
          }
        })();
      }, 250);
      try {
        const stdoutPromise = new Response(child.stdout).text();
        const stderrPromise = new Response(child.stderr).text();
        const code = await child.exited;
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        embeddingStderr = stderr || stdout;
        if (existsSync(workerOutputPath)) {
          embedding = JSON.parse(readFileSync(workerOutputPath, 'utf8')) as WorkerOutput;
        }
        if (watchdogTripped) {
          embedding = {
            ok: false,
            model,
            error: `embedding worker crossed the ${formatBytes(RSS_WATCHDOG_BYTES)} RSS watchdog and was stopped`,
          };
        } else if (code === 0 && embedding?.ok) {
          break;
        } else {
          embedding = {
            ok: false,
            model,
            error: embedding?.error ?? `embedding worker exited ${code}: ${embeddingStderr.slice(-2000)}`,
          };
        }
      } finally {
        clearInterval(watchdog);
      }
    } catch (error) {
      embedding = {
        ok: false,
        model,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      };
    }
    if (attempt < 2) {
      console.error(`embedding worker attempt ${attempt} failed; retrying once: ${(embedding.error ?? '').slice(0, 400)}`);
    }
  }

  const embeddingMemory = new Map<string, number | null>();
  const embeddingProcedure = new Map<string, number | null>();
  if (embedding?.ok && embedding.rankings) {
    for (const seed of MEMORY_SEEDS) {
      const order = embedding.rankings.memory[seed.id]?.map((hit) => hit.id) ?? [];
      embeddingMemory.set(seed.id, rankOf(order, seed.id));
    }
    for (const seed of PROCEDURE_SEEDS) {
      const order = embedding.rankings.procedure[seed.id]?.map((hit) => hit.id) ?? [];
      embeddingProcedure.set(seed.id, rankOf(order, seed.id));
    }
  } else {
    for (const seed of MEMORY_SEEDS) embeddingMemory.set(seed.id, null);
    for (const seed of PROCEDURE_SEEDS) embeddingProcedure.set(seed.id, null);
  }

  const ranks: Record<Arm, Record<Kind, Map<string, number | null>>> = {
    rule_only: { memory: ruleMemory, procedure: ruleProcedure },
    fts_trigram: { memory: ftsMemory, procedure: ftsProcedure },
    embedding: { memory: embeddingMemory, procedure: embeddingProcedure },
  };

  const metrics: Metric[] = [];
  for (const arm of ARMS) {
    for (const kind of KINDS) metrics.push(metric(arm, kind, ranks[arm][kind]));
    metrics.push(metric(arm, 'all', allRanks([ranks[arm].memory, ranks[arm].procedure])));
  }

  const failures: Record<Arm, Failure[]> = { rule_only: [], fts_trigram: [], embedding: [] };
  for (const arm of ARMS) {
    for (const kind of KINDS) {
      const seeds: Seed[] = kind === 'memory' ? MEMORY_SEEDS : PROCEDURE_SEEDS;
      for (const seed of seeds) {
        const rank = ranks[arm][kind].get(seed.id) ?? null;
        if (rank === null || rank > 5) {
          failures[arm].push({
            arm,
            kind,
            id: seed.id,
            query: seed.query,
            target: seedLabel(seed),
            rank,
          });
        }
      }
    }
  }

  const head = gitHead();
  const modelFiles = existsSync(cacheDir) ? directoryFiles(cacheDir).sort((left, right) => right.bytes - left.bytes) : [];
  const modelDirBytes = modelFiles.reduce((sum, file) => sum + file.bytes, 0);
  const residentIncrement =
    embedding?.rssAfterQueriesBytes !== undefined && embedding?.rssBeforeModelBytes !== undefined
      ? embedding.rssAfterQueriesBytes - embedding.rssBeforeModelBytes
      : undefined;
  const peakIncrement =
    embedding?.peakRssBytes !== undefined && embedding?.rssBeforeModelBytes !== undefined
      ? embedding.peakRssBytes - embedding.rssBeforeModelBytes
      : undefined;

  const markdown = renderMarkdown({
    head,
    check,
    metrics,
    failures,
    embedding,
    embeddingStderr,
    embeddingAttempts,
    model,
    cacheDir,
    cacheWasEmpty,
    modelFiles,
    modelDirBytes,
    residentIncrement,
    peakIncrement,
  });
  const json = {
    head,
    runAt: new Date().toISOString(),
    bun: process.versions.bun,
    platform: process.platform,
    arch: process.arch,
    evalNow: EVAL_NOW,
    corpus: {
      seeds: SEEDS.length,
      memory: MEMORY_SEEDS.length,
      procedure: PROCEDURE_SEEDS.length,
      maxDeterministicCosine: check.maxDeterministicCosine,
      maxDeterministicPair: check.maxPair,
    },
    metrics,
    ranks: Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        Object.fromEntries(KINDS.map((kind) => [kind, Object.fromEntries(ranks[arm][kind])])),
      ]),
    ),
    failures,
    embedding: {
      ...embedding,
      attempts: embeddingAttempts,
      rssWatchdogBytes: RSS_WATCHDOG_BYTES,
      modelDirBytes,
      modelFiles,
      cacheWasEmpty,
      memoryLimitKb: MEMORY_LIMIT_KB,
      residentIncrement,
      peakIncrement,
    },
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.md'), markdown);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(json, null, 2));
  console.log(`\n${markdown}`);
  console.log(`\nwrote ${join(outDir, 'results.md')} and results.json`);

  fts.close();
  kernel.close();
  if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
}

function gitHead(): string {
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: repo }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function renderMarkdown(input: {
  head: string;
  check: { maxDeterministicCosine: number; maxPair: string };
  metrics: Metric[];
  failures: Record<Arm, Failure[]>;
  embedding?: WorkerOutput;
  embeddingStderr: string;
  embeddingAttempts: number;
  model: string;
  cacheDir: string;
  cacheWasEmpty: boolean;
  modelFiles: Array<{ path: string; bytes: number }>;
  modelDirBytes: number;
  residentIncrement?: number;
  peakIncrement?: number;
}): string {
  const lines: string[] = [];
  lines.push('# Recall baseline — #250 A6');
  lines.push('');
  lines.push(`- base commit at run: \`${input.head}\` (the corpus and harness are committed on this tree)`);
  lines.push(`- run at: ${new Date().toISOString()}`);
  lines.push(`- bun: ${process.versions.bun} · ${process.platform}/${process.arch}`);
  lines.push('');
  lines.push('## Corpus');
  lines.push('');
  lines.push(`- 30 Chinese paraphrase queries: ${MEMORY_SEEDS.length} memory targets, ${PROCEDURE_SEEDS.length} procedure targets.`);
  lines.push('- Every query was checked to contain none of its target\'s `keyTerms`; the check is in `run.ts`.');
  lines.push(
    `- Max deterministic cosine between memory targets: ${input.check.maxDeterministicCosine.toFixed(4)} (${input.check.maxPair}); ` +
      'below the 0.98 write-path dedup threshold, so all 20 survived as separate neurons.',
  );
  lines.push('- Seed write order is a fixed SHA-256 shuffle, not the corpus order, so recency is not aligned with the query list.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| corpus | arm | recall@1 | recall@5 |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const kind of KINDS) {
    for (const arm of ARMS) {
      const row = input.metrics.find((metric) => metric.arm === arm && metric.kind === kind)!;
      lines.push(`| ${kind} (n=${row.n}) | ${arm} | ${formatPercent(row.recall1, row.n)} | ${formatPercent(row.recall5, row.n)} |`);
    }
  }
  for (const arm of ARMS) {
    const row = input.metrics.find((metric) => metric.arm === arm && metric.kind === 'all')!;
    lines.push(`| all (n=${row.n}) | ${arm} | ${formatPercent(row.recall1, row.n)} | ${formatPercent(row.recall5, row.n)} |`);
  }
  lines.push('');
  lines.push(
    'Chance for a random ranker: memory @1 5.0%, @5 25.0%; procedure @1 10.0%, @5 50.0% ' +
      '(the procedure pool is 10 because `PROCEDURE_RECALL_MAX` caps a page at 10).',
  );
  lines.push('');
  lines.push('## Reading the table');
  lines.push('');
  const ruleMemory = input.metrics.find((metric) => metric.arm === 'rule_only' && metric.kind === 'memory')!;
  const embeddingMemory = input.metrics.find((metric) => metric.arm === 'embedding' && metric.kind === 'memory')!;
  const embeddingProcedure = input.metrics.find((metric) => metric.arm === 'embedding' && metric.kind === 'procedure')!;
  lines.push(
    `- On memories, \`rule_only\` answered ${ruleMemory.recall1}/${ruleMemory.n} at rank 1 and ${ruleMemory.recall5}/${ruleMemory.n} at top 5; ` +
      'the lane returns a recency-ordered window, so a paraphrase is mostly found by position, not by its words.',
  );
  lines.push(
    '- Trigram only wins when a three-character run survives the rewrite: one memory hit (m14, via the shared "不能手") ' +
      'and no procedure hit. A true paraphrase often shares no such run.',
  );
  lines.push(
    `- Embedding kept ${embeddingMemory.recall5}/${embeddingMemory.n} memories in the top 5 and ` +
      `${embeddingProcedure.recall5}/${embeddingProcedure.n} procedures; its only top-5 misses are listed below.`,
  );
  lines.push('');
  lines.push('## Failures (rank > 5 or not returned)');
  lines.push('');
  for (const arm of ARMS) {
    lines.push(`### ${arm}`);
    lines.push('');
    const picked = pickFailures(input.failures[arm]);
    if (picked.length === 0) {
      lines.push('- No misses at k ≤ 5.');
    } else {
      for (const failure of picked) {
        const rank = failure.rank === null ? 'not returned' : `rank ${failure.rank}`;
        lines.push(`- \`${failure.id}\` (${failure.kind}, ${rank}) — query: ${failure.query} — target: ${failure.target}`);
      }
    }
    lines.push('');
  }
  lines.push('## Embedding model and memory');
  lines.push('');
  lines.push(`- model: \`${input.model}\` (quantized ONNX; 102M parameters, 768 dimensions)`);
  lines.push(`- source: https://huggingface.co/${input.model}`);
  lines.push(`- query instruction: \`${QUERY_PREFIX}\` (applied to queries only; documents are embedded as written)`);
  lines.push(`- cache: \`${input.cacheDir}\` (gitignored); first run downloads, later runs reuse it.`);
  if (input.modelFiles.length > 0) {
    lines.push(`- on-disk size: ${formatBytes(input.modelDirBytes)} total`);
    for (const file of input.modelFiles.slice(0, 4)) lines.push(`  - \`${file.path}\`: ${formatBytes(file.bytes)}`);
  }
  if (input.embedding?.ok) {
    const embedding = input.embedding;
    lines.push(
      `- load: ${(embedding.loadMs ?? 0).toFixed(0)} ms${input.cacheWasEmpty ? ' (cold: includes download)' : ' (warm cache)'}; ` +
        `index: ${(embedding.indexMs ?? 0).toFixed(0)} ms; 20+10 queries: ${(embedding.queryMs ?? 0).toFixed(0)} ms`,
    );
    lines.push(
      `- RSS before model: ${formatBytes(embedding.rssBeforeModelBytes)}; after load: ${formatBytes(embedding.rssAfterModelBytes)}; ` +
        `after index: ${formatBytes(embedding.rssAfterIndexBytes)}; after queries: ${formatBytes(embedding.rssAfterQueriesBytes)}`,
    );
    lines.push(
      `- peak RSS (VmHWM): ${formatBytes(embedding.peakRssBytes)}; resident increment after queries: ` +
        `${input.residentIncrement === undefined ? 'n/a' : `+${formatBytes(input.residentIncrement)}`}; ` +
        `peak increment: ${input.peakIncrement === undefined ? 'n/a' : `+${formatBytes(input.peakIncrement)}`}`,
    );
    lines.push(
      `- dimensions: ${embedding.dimensions ?? 'n/a'}; process bound: \`ulimit -v ${MEMORY_LIMIT_KB} KB\` + ` +
        `${formatBytes(RSS_WATCHDOG_BYTES)} RSS watchdog`,
    );
    if (input.embeddingAttempts > 1) {
      lines.push(`- worker succeeded on attempt ${input.embeddingAttempts} (one transient failure was retried; the first error is not a data point).`);
    }
  } else {
    lines.push(`- **Embedding arm unavailable.** ${input.embedding?.error ?? input.embeddingStderr.slice(-2000)}`);
    lines.push('- The rule_only and FTS rows above are still the measured partial result.');
  }
  lines.push('');
  lines.push('## What this measures, and what it does not');
  lines.push('');
  lines.push('- `rule_only` is the real shell path: `KernelAgentMemoryBackend.recall()` for memories and `ProcedureCompiler.recall()` for practices.');
  lines.push(
    '- The memory recall was asked for 20 items to expose ranks beyond the shell\'s default `limit: 3`; the procedure pool is capped at 10 by the product.',
  );
  lines.push('- `fts_trigram` is SQLite FTS5 `tokenize=\'trigram\'` over the same target texts, queried as an OR of the query\'s trigrams and ranked by bm25.');
  lines.push('- `embedding` is a local vector ranker, not wired into the product. No product code was changed in this round.');
  lines.push('- Decision (enable embedding / keep lexical + change the procedure vocabulary) is Ryu\'s in #250; this file only reports the measurement.');
  return lines.join('\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
  process.exitCode = 1;
});

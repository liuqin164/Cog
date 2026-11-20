#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { CompanionShell } from '../../shell/src/app.ts';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_QUERY_PREFIX } from '../../shell/src/embedding/model.ts';
import { XenovaEmbeddingProvider } from '../../shell/src/embedding/xenova.ts';
import type { ModelCompletionInput, ModelProvider, ModelTurn } from '../../shell/src/state/agent-loop.ts';
import { sessionTokens } from '../../src/public.ts';
import { FACTS, SCENARIOS, validateCorpus, type Fact } from './corpus.ts';

const HOUR_MS = 3_600_000;
const K = 3;
const PROJECT = 'assoc-eval';
const AGENT = 'assoc-eval-agent';
const SESSION = 'assoc-eval-query';

const repo = resolve(import.meta.dir, '../..');
const workRoot = join(repo, '.cogmem', 'assoc');
const cacheDir = resolve(argument('cache-dir') ?? join(workRoot, 'models'));
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const keepScratch = process.argv.includes('--keep');

interface TimedCall {
  input: ModelCompletionInput;
  at: number;
}

class TimedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly model = 'scripted/test';
  readonly calls: TimedCall[] = [];

  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    this.calls.push({ input, at: performance.now() });
    return { text: 'ok', toolCalls: [] };
  }
}

interface Row {
  scenario: string;
  kind: 'positive' | 'negative';
  target?: string;
  companion: string[];
  vector: string[];
  companionTokens: number;
  vectorTokens: number;
  companionMs: number;
  vectorMs: number;
}

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

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
}

function recallItems(input: ModelCompletionInput): Array<{ text: string; event?: string; whyMatched?: string }> {
  const message = input.messages.find((entry) => entry.content.includes('<COGMEM_RECALL_CONTEXT'));
  if (!message) return [];
  const inner = message.content.split('<COGMEM_RECALL_CONTEXT')[1]?.split('</COGMEM_RECALL_CONTEXT>')[0] ?? '';
  const items: Array<{ text: string; event?: string; whyMatched?: string }> = [];
  for (const line of inner.split('\n')) {
    if (line.startsWith('- ')) {
      items.push({ text: line.slice(2).trim() });
      continue;
    }
    const event = /anchorEvent=(\S+?);/.exec(line)?.[1];
    const whyMatched = /whyMatched=(\S+?);/.exec(line)?.[1];
    const current = items.at(-1);
    if (event && current) current.event = event;
    if (whyMatched && current) current.whyMatched = whyMatched;
  }
  return items;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function summarize(rows: Row[], arm: 'companion' | 'vector') {
  const positives = rows.filter((row) => row.kind === 'positive');
  const negatives = rows.filter((row) => row.kind === 'negative');
  const hits = positives.filter((row) => row.target !== undefined && row[arm].includes(row.target));
  const ratios: number[] = [];
  let returned = 0;
  let irrelevant = 0;
  for (const row of rows) {
    const count = row[arm].length;
    const relevant = row.kind === 'positive' && row.target && row[arm].includes(row.target) ? 1 : 0;
    returned += count;
    irrelevant += count - relevant;
    ratios.push(count === 0 ? 0 : (count - relevant) / count);
  }
  const tokens = rows.map((row) => arm === 'companion' ? row.companionTokens : row.vectorTokens);
  const latency = rows.map((row) => arm === 'companion' ? row.companionMs : row.vectorMs);
  return {
    positives: positives.length,
    negatives: negatives.length,
    hitRate: hits.length / positives.length,
    precision: returned === 0 ? 0 : 1 - irrelevant / returned,
    falsePositiveRatio: ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
    negativeSurfaceRate: negatives.filter((row) => row[arm].length > 0).length / negatives.length,
    tokensPerScenario: tokens.reduce((sum, value) => sum + value, 0) / tokens.length,
    latencyP50Ms: percentile(latency, 0.5),
    latencyP95Ms: percentile(latency, 0.95),
  };
}

async function waitForEmbeddings(shell: CompanionShell, expected: number): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (shell.kernel.eventEmbeddingStore.getProgress().completed >= expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`embeddings did not settle: ${shell.kernel.eventEmbeddingStore.getProgress().completed}/${expected}`);
}

async function waitForEmbeddingSettle(shell: CompanionShell): Promise<void> {
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const completed = shell.kernel.eventEmbeddingStore.getProgress().completed;
    stable = completed === last ? stable + 1 : 0;
    last = completed;
    if (stable >= 15) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error('embeddings did not settle');
}

async function main(): Promise<void> {
  validateCorpus();
  if (!existsSync(cacheDir)) throw new Error(`no model cache at ${cacheDir}; pass --cache-dir or place ${EMBEDDING_MODEL} there`);
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync(join(workRoot, 'run-'));
  process.env.TMPDIR ??= dataDir;
  mkdirSync(join(dataDir, 'models', 'Xenova'), { recursive: true });
  cpSync(join(cacheDir, EMBEDDING_MODEL), join(dataDir, 'models', EMBEDDING_MODEL), { recursive: true });

  const provider = new XenovaEmbeddingProvider(dataDir);
  const keepAlive = setInterval(() => {}, 1_000);
  const timed = new TimedProvider();
  const makeShell = (sessionId: string, dir: string) => new CompanionShell({
    config: {
      workspaceRoot: join(dir, 'ws'),
      dataDir: dir,
      dbPath: join(dir, 'memory.sqlite'),
      timeZone: 'UTC',
      projectId: PROJECT,
      agentId: AGENT,
      sessionId,
      terminalEnabled: false,
      http: { enabled: false, port: 0, hostname: '127.0.0.1' },
      plugins: [],
      embedding: {
        provider: 'local',
        baseUrl: '',
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        queryPrefix: EMBEDDING_QUERY_PREFIX,
      },
    },
    modelProvider: timed,
    embeddingProvider: provider,
    tick: false,
  });
  const seedDir = join(dataDir, 'seed');
  mkdirSync(seedDir, { recursive: true });
  const shell = makeShell(SESSION, seedDir);
  await shell.start();
  await provider.warm();

  const eventToFact = new Map<string, string>();
  const textToFact = new Map(FACTS.map((fact) => [fact.text, fact.id]));
  const now = Date.now();
  for (const [index, fact] of shuffled(FACTS).entries()) {
    const result = await shell.backend.rememberTurnWithResult({
      agentId: AGENT,
      projectId: PROJECT,
      sessionId: `seed-${fact.id}`,
      threadId: `seed-${fact.id}`,
      userText: fact.text,
      timestamp: now - (FACTS.length - index) * HOUR_MS,
    });
    if (result.duplicate || !result.rawEventIds[0]) throw new Error(`seed ${fact.id} did not compile: ${result.reason}`);
    eventToFact.set(result.rawEventIds[0], fact.id);
  }
  await waitForEmbeddings(shell, FACTS.length);
  await waitForEmbeddingSettle(shell);
  const semanticIndex = shell.kernel.semanticIndexEnabled();
  await shell.stop();

  const documentVectors = await provider.embedBatch(FACTS.map((fact) => fact.text)) as Float32Array[];
  const rows: Row[] = [];
  const whyMatched = new Map<string, number>();
  for (const scenario of SCENARIOS) {
    const runDir = join(dataDir, `run-${scenario.id}`);
    mkdirSync(runDir, { recursive: true });
    for (const file of ['memory.sqlite', 'memory.sqlite-wal', 'memory.sqlite-shm']) {
      if (existsSync(join(seedDir, file))) cpSync(join(seedDir, file), join(runDir, file));
    }
    const scenarioShell = makeShell(`${SESSION}-${scenario.id}`, runDir);
    await scenarioShell.start();
    const callsBefore = timed.calls.length;
    const started = performance.now();
    await scenarioShell.submit(scenario.cue);
    const call = timed.calls[callsBefore];
    if (!call) throw new Error(`${scenario.id} produced no model request`);
    const companionMs = call.at - started;
    const items = recallItems(call.input);
    const companion = items.map((item, index) => (item.event ? eventToFact.get(item.event) : undefined) ?? textToFact.get(item.text) ?? `?${index}`);
    for (const item of items) {
      const key = item.whyMatched ?? 'unknown';
      whyMatched.set(key, (whyMatched.get(key) ?? 0) + 1);
    }
    await waitForEmbeddingSettle(scenarioShell);
    await scenarioShell.stop();

    const vectorStarted = performance.now();
    const queryVector = await provider.embed(scenario.cue);
    const ranked = FACTS
      .map((fact, index) => ({ fact, score: cosine(queryVector, documentVectors[index]!) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, K);
    const vectorMs = performance.now() - vectorStarted;
    const vector = ranked.map((entry) => entry.fact.id);
    const factText = (ids: string[], source: Fact[]) => ids.map((id) => source.find((fact) => fact.id === id)?.text ?? '').filter(Boolean).join('\n');

    rows.push({
      scenario: scenario.id,
      kind: scenario.kind,
      ...(scenario.target ? { target: scenario.target } : {}),
      companion,
      vector,
      companionTokens: sessionTokens(items.map((item) => item.text).join('\n')),
      vectorTokens: sessionTokens(factText(vector, FACTS)),
      companionMs: Math.round(companionMs),
      vectorMs: Math.round(vectorMs),
    });
    process.stdout.write(`${scenario.id} companion=${companion.join(',')} vector=${vector.join(',')}\n`);
  }

  const companion = summarize(rows, 'companion');
  const vector = summarize(rows, 'vector');
  const result = {
    at: new Date().toISOString(),
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    semanticIndex,
    k: K,
    facts: FACTS.length,
    scenarios: SCENARIOS.length,
    positives: companion.positives,
    negatives: companion.negatives,
    companion,
    vector,
    whyMatched: Object.fromEntries(whyMatched),
    rows,
  };
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);

  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const markdown = [
    '# Associative recall — #355',
    '',
    `- corpus: ${FACTS.length} synthetic facts; ${SCENARIOS.length} cues (${companion.positives} positive, ${companion.negatives} negative); k=${K}`,
    `- embedding: \`${EMBEDDING_MODEL}\` (${EMBEDDING_DIMENSIONS}d); semanticIndex=${semanticIndex}`,
    '- companion arm: `CompanionShell.submit()` -> assembled `<COGMEM_RECALL_CONTEXT>` block; vector arm: cosine top-k over the same facts',
    '',
    '| arm | hit rate | precision | false-positive ratio | negative surfaced | tokens/cue | p50 ms | p95 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| companion recall lane | ${pct(companion.hitRate)} | ${pct(companion.precision)} | ${pct(companion.falsePositiveRatio)} | ${pct(companion.negativeSurfaceRate)} | ${companion.tokensPerScenario.toFixed(1)} | ${companion.latencyP50Ms.toFixed(1)} | ${companion.latencyP95Ms.toFixed(1)} |`,
    `| vector top-k | ${pct(vector.hitRate)} | ${pct(vector.precision)} | ${pct(vector.falsePositiveRatio)} | ${pct(vector.negativeSurfaceRate)} | ${vector.tokensPerScenario.toFixed(1)} | ${vector.latencyP50Ms.toFixed(1)} | ${vector.latencyP95Ms.toFixed(1)} |`,
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'results.md'), markdown);
  process.stdout.write(markdown);

  provider.dispose();
  clearInterval(keepAlive);
  if (!keepScratch) rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});


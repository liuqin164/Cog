#!/usr/bin/env bun
/**
 * #250 — the re-embed path against a *copy* of the live brain.
 *
 *   bun eval/recall-baseline/live-copy.ts [--source ~/.cogmem/companion/memory.sqlite]
 *
 * The live file is only read to copy it. Everything else — migrations, vectors, the probe turn —
 * happens in a scratch directory under `.cogmem/`. The output is the honest state of the migration
 * for a brain written before this shell had an embedding provider.
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createMemoryKernel, KernelAgentMemoryBackend } from '../../src/public.ts';
import { ModelRegistry } from '../../src/models/ModelRegistry.ts';
import { XenovaEmbeddingProvider } from '../../shell/src/embedding/xenova.ts';
import { EMBEDDING_MODEL } from '../../shell/src/embedding/model.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const repo = resolve(import.meta.dir, '../..');
const source = resolve(argument('source') ?? join(homedir(), '.cogmem', 'companion', 'memory.sqlite'));
const projectId = argument('project') ?? 'companion';
const probeProject = 'embedding-probe';
const cacheDir = resolve(argument('cache-dir') ?? join(repo, '.cogmem', 'tmp', 'models'));
const workRoot = join(repo, '.cogmem', 'live-copy');
const keepScratch = process.argv.includes('--keep');
mkdirSync(workRoot, { recursive: true });
const scratch = mkdtempSync(join(workRoot, 'run-'));
const dbPath = join(scratch, 'memory.sqlite');
copyFileSync(source, dbPath);
const models = join(scratch, 'models');
mkdirSync(join(models, 'Xenova'), { recursive: true });
cpSync(join(cacheDir, EMBEDDING_MODEL), join(models, EMBEDDING_MODEL), { recursive: true });

const provider = new XenovaEmbeddingProvider(scratch);
const registry = new ModelRegistry({
  memory: { role: 'memory', provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', modelName: 'unused', timeoutMs: 1_000, maxTokens: 1024, fallback: 'rule_only' },
  reasoning: { role: 'reasoning', provider: 'rule_only', modelName: 'rule_only', timeoutMs: 1_000, fallback: 'memory' },
  embedding: { role: 'embedding', provider: 'deterministic_local', modelName: 'deterministic_local', timeoutMs: 30_000 },
});
const kernel = createMemoryKernel({ dbPath, modelRegistry: registry, embeddingProvider: provider });
const keepAlive = setInterval(() => {}, 1_000);

const before = kernel.getHealthStatus().stats;
const rowsBefore = kernel.neuronEmbeddingStore.getProgress();
await provider.warm();
(registry as unknown as { config: { embedding: Record<string, unknown> } }).config.embedding = {
  role: 'embedding', provider: 'openai_compatible', modelName: EMBEDDING_MODEL, timeoutMs: 30_000,
};

const started = performance.now();
const runs: Array<{ processed: number; remaining: number }> = [];
for (let pass = 0; pass < 20; pass += 1) {
  const result = await kernel.reEmbed(projectId);
  runs.push(result);
  if (result.remaining === 0) break;
}
const firstMs = Math.round(performance.now() - started);
const first = runs[0]!;
const second = runs[1] ?? { processed: 0, remaining: 0 };
const settled = await kernel.reEmbed(projectId);
const rowsAfter = kernel.neuronEmbeddingStore.getProgress();

// A brain that never had vectors has no rows to migrate. Prove that the forward path works: one
// new turn through the real write path gets a vector, without touching any pre-existing neuron.
const backend = new KernelAgentMemoryBackend(kernel, { agentId: 'owner' });
const rowsBeforeProbe = kernel.neuronEmbeddingStore.getProgress().total;
const turn = await backend.rememberTurnWithResult({
  agentId: 'owner',
  projectId: probeProject,
  sessionId: `re-embed-probe-${Date.now()}`,
  userText: `重嵌入探针 ${randomUUID()}：这是一条用于验证新写入会带向量的临时记忆。`,
});
for (let i = 0; i < 50; i += 1) { if (kernel.neuronEmbeddingStore.getProgress().total > rowsBeforeProbe) break; await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); }
const rowsAfterProbe = kernel.neuronEmbeddingStore.getProgress();

console.log(JSON.stringify({
  source,
  dbPath,
  sourceBytes: statSync(source).size,
  copyBytes: statSync(dbPath).size,
  projectId,
  neurons: before,
  embeddingRowsBefore: rowsBefore,
  reEmbed: { first, second, runs, settled, firstMs },
  embeddingRowsAfter: rowsAfter,
  probe: {
    projectId: probeProject,
    neuronId: turn.compiledNeuronId ?? null,
    rows: rowsAfterProbe,
    vectorRecall: kernel.getHealthStatus().vectorRecall,
  },
}, null, 2));

clearInterval(keepAlive);
provider.dispose();
kernel.close();
if (!keepScratch) rmSync(scratch, { recursive: true, force: true });

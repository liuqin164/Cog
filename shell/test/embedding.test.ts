/**
 * #250 — the embedding seam's honesty and degradation.
 *
 * These do not load the 99 MiB model: the provider is exercised offline (no remote models), which
 * is exactly the missing-model path the companion must survive. The real model is measured by
 * `eval/recall-baseline/run-wired.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { isAbsolute, join } from 'node:path';
import { createMemoryKernel } from 'cogmem';
import { ModelRegistry } from 'cogmem/internal';
import { CompanionShell } from '../src/app.ts';
import { embeddingWorkerScript, XenovaEmbeddingProvider } from '../src/embedding/xenova.ts';
import { EMBEDDING_MODEL } from '../src/embedding/model.ts';
import { makeTempDir } from './helpers.ts';

describe('embedding provider without a model', () => {
  test('the worker entry is an absolute filesystem path, never a file:// URL (#280)', () => {
    const script = embeddingWorkerScript();
    expect(isAbsolute(script)).toBe(true);
    expect(script.startsWith('file:')).toBe(false);
    expect(script.endsWith('worker.ts')).toBe(true);
  });

  test('warm fails cleanly and embedSync returns an empty vector instead of throwing', async () => {
    const dataDir = makeTempDir();
    const provider = new XenovaEmbeddingProvider(dataDir, undefined, 2_000, false);
    await expect(provider.warm()).rejects.toThrow(/embedding_unavailable/);
    expect(provider.status().state).toBe('degraded');
    const extracted = provider.embedSync;
    expect(extracted('查一下会议时间').length).toBe(0);
    expect(provider.embedSync('x').length).toBe(0);
    provider.dispose();
  }, 20_000);
});

describe('shell embedding wiring', () => {
  test('a shell with the local embedder starts with semanticIndex false until the model is ready', () => {
    const dataDir = makeTempDir();
    const shell = new CompanionShell({
      config: { dataDir, dbPath: join(dataDir, 'memory.sqlite') },
      embedding: true,
      tick: false,
    });
    try {
      expect(shell.kernel.semanticIndexEnabled()).toBe(false);
      expect(shell.kernel.getHealthStatus().embeddingModelId).toBe(EMBEDDING_MODEL);
    } finally {
      shell.kernel.close();
    }
  });

  test('a host-supplied provider is reported as a real index through the shell registry', () => {
    const dataDir = makeTempDir();
    const provider = {
      dimensions: 4,
      modelId: 'test/embedding',
      async embed() { return new Float32Array([1, 0, 0, 0]); },
      async embedBatch(texts: string[]) { return texts.map(() => new Float32Array([1, 0, 0, 0])); },
    };
    const shell = new CompanionShell({
      config: { dataDir, dbPath: join(dataDir, 'memory.sqlite') },
      embeddingProvider: provider,
      tick: false,
    });
    try {
      expect(shell.kernel.semanticIndexEnabled()).toBe(true);
    } finally {
      shell.kernel.close();
    }
  });
});

describe('reEmbed idempotency', () => {
  test('a stale row migrates once and the second pass does no work', async () => {
    const dataDir = makeTempDir();
    const provider = {
      dimensions: 4,
      modelId: 'test/current',
      async embed() { return new Float32Array([1, 0, 0, 0]); },
      async embedBatch(texts: string[]) { return texts.map(() => new Float32Array([1, 0, 0, 0])); },
    };
    const registry = new ModelRegistry({
      memory: { role: 'memory', provider: 'rule_only', modelName: 'rule_only', timeoutMs: 1_000, fallback: 'rule_only' },
      reasoning: { role: 'reasoning', provider: 'rule_only', modelName: 'rule_only', timeoutMs: 1_000, fallback: 'memory' },
      embedding: { role: 'embedding', provider: 'openai_compatible', modelName: 'test/current', timeoutMs: 1_000 },
    });
    const kernel = createMemoryKernel({ dbPath: join(dataDir, 'memory.sqlite'), modelRegistry: registry, embeddingProvider: provider });
    try {
      const neuronId = 'nrn-reembed-old';
      kernel.memoryGraph.addNeuron({
        id: neuronId,
        content: '需要重嵌入的旧记忆',
        prev_hash: '',
        self_hash: 'hash-reembed-old',
        synapses: [],
        metadata: { type: 'chat', createdAt: 1, projectId: 'p', tags: [] },
        coordinates: { T: 1, S: [0, 0, 0], V: [1, 0, 0, 0] },
      } as never);
      kernel.neuronEmbeddingStore.upsert(neuronId, 'test/old', new Float32Array([0, 1, 0, 0]), 'p');
      const first = await kernel.reEmbed('p');
      const second = await kernel.reEmbed('p');
      expect(first).toEqual({ processed: 1, remaining: 0 });
      expect(second).toEqual({ processed: 0, remaining: 0 });
    } finally {
      kernel.close();
    }
  });
});

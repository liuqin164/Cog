import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import type { EmbeddingProvider } from '../src/embedding/EmbeddingProvider.js';
import { makeTempDir } from './helpers/tmp.js';

function provider(modelId: string, vector: Float32Array, fail = false): EmbeddingProvider {
  return {
    dimensions: vector.length,
    modelId,
    embedBatch: async (texts: string[]) => {
      if (fail) throw new Error('provider_down');
      return texts.map(() => vector);
    },
    embed: async () => {
      if (fail) throw new Error('provider_down');
      return vector;
    },
    embedSync: () => vector,
  } as EmbeddingProvider;
}

test('raw events gain vectors after an embedding model change and are recalled', async () => {
  const dir = makeTempDir('cogmem-embedding-backfill-');
  const dbPath = join(dir, 'brain.db');
  const first = createMemoryKernel({ dbPath, embeddingProvider: provider('embedding/old', new Float32Array([1, 0])) });
  const eventIds = (await new KernelAgentMemoryBackend(first).rememberTurnWithResult({
    agentId: 'a',
    projectId: 'p',
    sessionId: 's',
    userText: '归档保留期定成七年。',
    assistantText: '记下了。',
    ingestMode: 'raw_archive_only',
  })).rawEventIds;
  first.eventEmbeddingStore.upsert(eventIds[0]!, 'embedding/old', new Float32Array([1, 0]), 'p');
  first.close();

  const second = createMemoryKernel({ dbPath, embeddingProvider: provider('embedding/new', new Float32Array([1, 0])) });
  const backend = new KernelAgentMemoryBackend(second);
  try {
    expect(second.nearestRawEventIds('归档保留期', 'p', 5)).toEqual([]);
    expect(second.getHealthStatus().hasStaleVectors).toBe(true);

    expect(await second.backfillEventEmbeddings({ projectId: 'p' })).toEqual({ completed: 2, failed: 0 });

    expect(second.nearestRawEventIds('归档保留期', 'p', 5).sort()).toEqual([...eventIds].sort());
    expect(second.getHealthStatus().hasStaleVectors).toBe(false);
    expect(second.eventEmbeddingStore.getProgress('p')).toEqual({ total: 2, completed: 2, failed: 0 });
    expect(backend.recall({ agentId: 'a', projectId: 'p', query: '归档保留期', limit: 5 }).items.map((item) => item.id))
      .toContain(eventIds[0]);
  } finally {
    second.close();
  }
});

test('a failed backfill is non-fatal and recorded', async () => {
  const dir = makeTempDir('cogmem-embedding-backfill-failed-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider('embedding/down', new Float32Array([1, 0]), true) });
  try {
    await new KernelAgentMemoryBackend(kernel).rememberTurnWithResult({
      agentId: 'a',
      projectId: 'p',
      sessionId: 's',
      userText: '失败不致命。',
      ingestMode: 'raw_archive_only',
    });

    expect(await kernel.backfillEventEmbeddings({ projectId: 'p' })).toEqual({ completed: 0, failed: 1 });
    expect(kernel.pipelineMetrics.getNonFatalCount('event_embedding_failed', { projectId: 'p' })).toBe(1);
    expect(kernel.getHealthStatus().status).toBe('ok');
  } finally {
    kernel.close();
  }
});

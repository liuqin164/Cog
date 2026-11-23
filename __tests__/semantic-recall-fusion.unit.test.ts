import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import type { EmbeddingProvider } from '../src/embedding/EmbeddingProvider.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const MODEL_ID = 'test/fusion';

function provider(): EmbeddingProvider {
  return {
    dimensions: 2,
    modelId: MODEL_ID,
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])),
    embed: async () => new Float32Array([1, 0]),
    embedSync: () => new Float32Array([1, 0]),
  } as EmbeddingProvider;
}

test('a low-similarity semantic hit does not displace an exact lexical hit', async () => {
  const dir = makeTempDir('cogmem-semantic-fusion-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider() });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    const unrelated = await backend.rememberTurnWithResult({
      agentId: 'a',
      projectId: 'p',
      sessionId: 's',
      userText: 'The weather was sunny all week.',
      assistantText: 'Noted.',
      ingestMode: 'raw_archive_only',
    });
    const exact = await backend.rememberTurnWithResult({
      agentId: 'a',
      projectId: 'p',
      sessionId: 's',
      userText: 'Archival retention period is seven years.',
      assistantText: 'Understood.',
      ingestMode: 'raw_archive_only',
    });
    await kernel.flushEventEmbeddings();
    const db = kernel.factStore.getDatabase();
    for (const eventId of [...unrelated.rawEventIds, ...exact.rawEventIds]) {
      db.query('DELETE FROM memory_event_embeddings WHERE event_id = ?').run(eventId);
    }
    kernel.eventEmbeddingStore.upsert(unrelated.rawEventIds[0]!, MODEL_ID, new Float32Array([0, 1]), 'p');
    kernel.eventEmbeddingStore.upsert(exact.rawEventIds[1]!, MODEL_ID, new Float32Array([0, 1]), 'p');

    expect(kernel.nearestRawEventIds('Archival retention period', 'p', 5)).toEqual([]);

    const recalled = backend.recall({
      agentId: 'a',
      projectId: 'p',
      query: 'Archival retention period',
      limit: 1,
    });
    expect(recalled.items.map((item) => item.id)).toEqual([exact.rawEventIds[0]]);
  } finally {
    kernel.close();
  }
});

test('an unscoped semantic search covers every project', () => {
  const dir = makeTempDir('cogmem-semantic-scope-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider() });
  try {
    const event = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 't',
      role: 'user',
      content: 'project scoped vector',
    });
    kernel.eventEmbeddingStore.upsert(event.eventId, MODEL_ID, new Float32Array([1, 0]), 'p');

    expect(kernel.nearestRawEventIds('anything', undefined, 5)).toEqual([event.eventId]);
    expect(kernel.nearestRawEventIds('anything', 'other', 5)).toEqual([]);
  } finally {
    kernel.close();
  }
});

test('without embeddings, raw recall keeps the primary-source order', () => {
  const dir = makeTempDir('cogmem-semantic-order-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db') });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    const user = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'user-source',
      sessionId: 'user-source',
      role: 'user',
      content: '部署脚本 用户来源',
      occurredAt: 1_000,
    });
    kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'assistant-source',
      sessionId: 'assistant-source',
      role: 'assistant',
      content: '部署脚本 助手来源',
      occurredAt: 2_000,
    });

    const recalled = backend.recall({
      agentId: 'a',
      projectId: 'p',
      query: '部署 脚本',
      limit: 5,
      retrievalPolicy: { allowedLanes: ['raw_source'], preferredLanes: [] },
    });

    expect(recalled.items[0]?.id).toBe(user.eventId);
  } finally {
    kernel.close();
  }
});

test('with embeddings, fusion still reorders the raw candidates', () => {
  const dir = makeTempDir('cogmem-semantic-order-fused-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider() });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    const user = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'fused-user',
      sessionId: 'fused-user',
      role: 'user',
      content: '部署脚本 用户来源',
      occurredAt: 1_000,
    });
    const assistant = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'fused-assistant',
      sessionId: 'fused-assistant',
      role: 'assistant',
      content: '部署脚本 助手来源',
      occurredAt: 2_000,
    });
    kernel.eventEmbeddingStore.upsert(user.eventId, MODEL_ID, new Float32Array([0.9, Math.sqrt(0.19)]), 'p');
    kernel.eventEmbeddingStore.upsert(assistant.eventId, MODEL_ID, new Float32Array([1, 0]), 'p');

    const recalled = backend.recall({
      agentId: 'a',
      projectId: 'p',
      query: '部署 脚本',
      limit: 5,
      retrievalPolicy: { allowedLanes: ['raw_source'], preferredLanes: [] },
    });

    expect(recalled.items[0]?.id).toBe(assistant.eventId);
  } finally {
    kernel.close();
  }
});

test('the similarity floor is relative to the best hit', () => {
  const dir = makeTempDir('cogmem-semantic-threshold-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider() });
  try {
    const high = kernel.recordRawEvent({ projectId: 'p', threadId: 'high', sessionId: 'high', role: 'user', content: 'high' });
    const mid = kernel.recordRawEvent({ projectId: 'p', threadId: 'mid', sessionId: 'mid', role: 'user', content: 'mid' });
    const low = kernel.recordRawEvent({ projectId: 'p', threadId: 'low', sessionId: 'low', role: 'user', content: 'low' });
    kernel.eventEmbeddingStore.upsert(high.eventId, MODEL_ID, new Float32Array([1, 0]), 'p');
    kernel.eventEmbeddingStore.upsert(mid.eventId, MODEL_ID, new Float32Array([0.85, Math.sqrt(1 - 0.85 ** 2)]), 'p');
    kernel.eventEmbeddingStore.upsert(low.eventId, MODEL_ID, new Float32Array([0.6, 0.8]), 'p');

    expect(kernel.nearestRawEventIds('threshold', 'p', 5)).toEqual([high.eventId, mid.eventId]);
  } finally {
    kernel.close();
  }
});

test('semantic search honours the recall time window', () => {
  const dir = makeTempDir('cogmem-semantic-window-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider() });
  try {
    const early = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'early',
      sessionId: 'early',
      role: 'user',
      content: 'early',
      occurredAt: 1_000,
    });
    const late = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'late',
      sessionId: 'late',
      role: 'user',
      content: 'late',
      occurredAt: 2_000,
    });
    kernel.eventEmbeddingStore.upsert(early.eventId, MODEL_ID, new Float32Array([1, 0]), 'p');
    kernel.eventEmbeddingStore.upsert(late.eventId, MODEL_ID, new Float32Array([1, 0]), 'p');

    expect(kernel.nearestRawEventIds('window', 'p', 5, { startTime: 1_500 })).toEqual([late.eventId]);
    expect(kernel.nearestRawEventIds('window', 'p', 5, { endTime: 1_500 })).toEqual([early.eventId]);
  } finally {
    kernel.close();
  }
});

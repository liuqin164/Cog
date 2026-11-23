import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import type { EmbeddingProvider } from '../src/embedding/EmbeddingProvider.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const MODEL_ID = 'test/raw-loop';

function provider(counter?: { calls: number }): EmbeddingProvider {
  const vector = new Float32Array([1, 0]);
  return {
    dimensions: 2,
    modelId: MODEL_ID,
    embedBatch: async (texts: string[]) => texts.map(() => vector),
    embed: async () => vector,
    embedSync: () => {
      if (counter) counter.calls += 1;
      return vector;
    },
  } as EmbeddingProvider;
}

test('the expansion loop embeds the query once across all four rounds', () => {
  const dir = makeTempDir('cogmem-raw-loop-embed-');
  const counter = { calls: 0 };
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider(counter) });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    for (let index = 0; index < 200; index += 1) {
      kernel.recordRawEvent({
        projectId: 'p',
        threadId: `noise-${index}`,
        sessionId: `noise-${index}`,
        role: 'user',
        content: `zzmarker noise ${index}`,
        metadata: { tags: ['operational_noise'] },
        occurredAt: 1_000 + index,
      });
    }

    const recalled = backend.recall({ agentId: 'a', projectId: 'p', query: 'zzmarker', limit: 5 });

    expect(recalled.items).toHaveLength(0);
    expect(counter.calls).toBe(1);
  } finally {
    kernel.close();
  }
});

test('candidate events are read in one batch instead of one getEvent per candidate', () => {
  const dir = makeTempDir('cogmem-raw-loop-batch-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider() });
  const backend = new KernelAgentMemoryBackend(kernel);
  const originalGetEvent = kernel.eventStore.getEvent.bind(kernel.eventStore);
  const candidateIds: string[] = [];
  try {
    for (let index = 0; index < 60; index += 1) {
      const event = kernel.recordRawEvent({
        projectId: 'p',
        threadId: `batch-${index}`,
        sessionId: `batch-${index}`,
        role: 'user',
        content: `batch marker ${index}`,
        occurredAt: 2_000 + index,
      });
      candidateIds.push(event.eventId);
      kernel.eventEmbeddingStore.upsert(event.eventId, MODEL_ID, new Float32Array([1, 0]), 'p');
    }
    expect(kernel.eventStore.getEventsByIds([candidateIds[2]!, candidateIds[0]!]).map((event) => event.eventId))
      .toEqual([candidateIds[2]!, candidateIds[0]!]);

    const getEventCalls = new Set<string>();
    kernel.eventStore.getEvent = (eventId: string) => {
      if (candidateIds.includes(eventId)) getEventCalls.add(eventId);
      return originalGetEvent(eventId);
    };

    const recalled = backend.recall({
      agentId: 'a',
      projectId: 'p',
      query: 'batch marker',
      limit: 5,
      retrievalPolicy: { allowedLanes: ['raw_source'], preferredLanes: [] },
    });

    expect(recalled.items.length).toBeGreaterThan(0);
    expect(getEventCalls.size).toBeLessThanOrEqual(5);
  } finally {
    kernel.close();
  }
});

test('the resident vector cache picks up rows written after it was warmed, by seq', () => {
  const dir = makeTempDir('cogmem-raw-loop-cache-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), embeddingProvider: provider() });
  try {
    const first = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'cache-1',
      sessionId: 'cache-1',
      role: 'user',
      content: 'cache marker one',
      occurredAt: 3_000,
    });
    kernel.eventEmbeddingStore.upsert(first.eventId, MODEL_ID, new Float32Array([1, 0]), 'p');
    expect(kernel.nearestRawEventIds('cache marker', 'p', 5)).toEqual([first.eventId]);

    const second = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'cache-2',
      sessionId: 'cache-2',
      role: 'user',
      content: 'cache marker two',
      occurredAt: 3_100,
    });
    const db = kernel.factStore.getDatabase();
    db.query(`
      INSERT INTO memory_event_embeddings(event_id,model_id,dimensions,vector_blob,project_id,updated_at)
      VALUES(?,?,?,?,?,?)
    `).run(
      second.eventId,
      MODEL_ID,
      2,
      Buffer.from(new Float32Array([1, 0]).buffer),
      'p',
      Date.now(),
    );

    expect(new Set(kernel.nearestRawEventIds('cache marker', 'p', 5))).toEqual(new Set([first.eventId, second.eventId]));
  } finally {
    kernel.close();
  }
});

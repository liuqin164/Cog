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
    await new Promise((resolve) => setTimeout(resolve, 20));
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

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const projectId = 'session-tail-backfill';
const sessionId = 'session-tail';
const T0 = Date.UTC(2026, 10, 23, 9);
let kernel: MemoryKernel;
let backend: KernelAgentMemoryBackend;

beforeAll(() => {
  kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-tail-backfill-'), 'memory.db'), projectTimeZone: 'UTC' });
  backend = new KernelAgentMemoryBackend(kernel);
});

afterAll(() => {
  kernel.close();
});

test('newest-first raw recall backfills past the excluded session tail', () => {
  const events = Array.from({ length: 40 }, (_, index) => kernel.recordRawEvent({
    projectId,
    threadId: 'tail-thread',
    sessionId,
    turnSeq: index + 1,
    role: 'user',
    content: `第 ${index} 条：东京出差记录。`,
    occurredAt: T0 + index,
  }));

  const recalled = backend.recall({
    projectId,
    agentId: 'hermes',
    query: '东京',
    limit: 3,
    excludeSessionId: sessionId,
    excludeSessionTailTurns: 8,
  });

  expect(recalled.items).toHaveLength(3);
  const excludedIds = new Set(events.slice(-8).map((event) => event.eventId));
  expect(recalled.items.some((item) => excludedIds.has(item.id))).toBe(false);
});

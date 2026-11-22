import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const T0 = Date.UTC(2026, 10, 16, 9);
const projectId = 'correction-recall-scope';
const scratch = makeTempDir('cogmem-correction-recall-');
let kernel: MemoryKernel;
let backend: KernelAgentMemoryBackend;

beforeAll(() => {
  kernel = createMemoryKernel({ dbPath: join(scratch, 'memory.db'), projectTimeZone: 'UTC' });
  backend = new KernelAgentMemoryBackend(kernel);
});

afterAll(() => {
  kernel.close();
});

function turn(content: string, occurredAt: number): string {
  return kernel.recordRawEvent({
    projectId,
    threadId: 'tokyo-thread',
    role: 'user',
    content,
    occurredAt,
  }).eventId;
}

test('a correction drops only its own evidence, keeps other Tokyo memories, and backfills the lane', () => {
  const oldId = turn('我住在东京。', T0);
  kernel.beliefStore.upsert({
    projectId,
    scope: 'project',
    subject: 'owner',
    predicate: 'location',
    objectValue: { raw: '东京', type: 'string' },
    confidence: 0.9,
    sourceType: 'user_input',
    extractionReason: 'explicit_user_statement',
    sourceEventId: oldId,
    validFrom: T0,
  }, T0);
  kernel.profile.compile({ projectId, now: T0 + 1 });
  const entry = kernel.profile.entries({ projectId, ledger: 'facts' })
    .find((candidate) => candidate.value === '东京')!;

  turn('去年在东京的聚餐很开心。', T0 + 100);
  turn('下周去东京出差。', T0 + 200);
  turn('东京塔的夜景不错。', T0 + 300);
  turn('东京的樱花季很短。', T0 + 400);
  const correctionId = turn('其实我住在东京这件事不对，现在住在大阪。', T0 + 2_000);
  kernel.profile.correct({
    projectId,
    ledger: 'facts',
    key: entry.key,
    value: '大阪',
    correctionEventId: correctionId,
    now: T0 + 3_000,
  });
  turn('下个月还要去东京出差。', T0 + 4_000);

  const wide = backend.recall({ projectId, agentId: 'hermes', query: '东京', limit: 8 });
  const wideText = wide.items.map((item) => item.text).join('\n');
  expect(wide.items.map((item) => item.id)).not.toContain(oldId);
  expect(wideText).toContain('聚餐');
  expect(wideText).toContain('下个月还要去东京出差');
  expect(wide.decisionTrace?.suppressed).toContainEqual({ reason: 'profile_superseded', count: 1 });

  const limited = backend.recall({ projectId, agentId: 'hermes', query: '东京', limit: 3 });
  expect(limited.items).toHaveLength(3);
  expect(limited.items.map((item) => item.id)).not.toContain(oldId);
});

import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel, localDateFor } from '../src/public.js';
import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { localDateCue } from '../src/agent/AgentRecallText.js';
import { MultidimensionalQueryPlanner } from '../src/recall/MultidimensionalQueryPlanner.js';
import { makeTempDir } from './helpers/tmp.js';

const TOKYO = 'Asia/Tokyo';

test('a relative day window uses the project time zone (#447)', async () => {
  const kernel = createMemoryKernel({
    dbPath: join(makeTempDir('recall-relative-'), 'brain.db'),
    projectTimeZone: TOKYO,
  });
  const backend = new KernelAgentMemoryBackend(kernel);
  const now = Date.parse('2026-11-20T03:00:00.000Z');
  try {
    kernel.recordRawEvent({
      threadId: 't-yesterday', projectId: 'p', role: 'user', sourceId: 'a',
      content: '昨天说的部署窗口是周二凌晨两点。',
      occurredAt: Date.parse('2026-11-19T01:00:00.000Z'),
    });
    kernel.recordRawEvent({
      threadId: 't-today', projectId: 'p', role: 'user', sourceId: 'a',
      content: '今天又提了一次部署窗口。',
      occurredAt: Date.parse('2026-11-20T01:00:00.000Z'),
    });

    const recalled = backend.recall({ projectId: 'p', agentId: 'a', query: '昨天聊的部署窗口是什么', now, limit: 5 });
    expect(recalled.items.map((item) => item.text)).toEqual(['昨天说的部署窗口是周二凌晨两点。']);
  } finally {
    kernel.close();
  }
});

test('a date cue reaches a day older than the newest 1000 events (#447)', async () => {
  const kernel = createMemoryKernel({
    dbPath: join(makeTempDir('recall-old-date-'), 'brain.db'),
    projectTimeZone: TOKYO,
  });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    kernel.recordRawEvent({
      threadId: 't-target', projectId: 'p', role: 'user', sourceId: 'a',
      content: '把发布窗口锁到周二。',
      occurredAt: Date.parse('2026-11-03T00:30:00+09:00'),
    });
    for (let index = 0; index < 1100; index += 1) {
      kernel.recordRawEvent({
        threadId: `t-filler-${index}`, projectId: 'p', role: 'user', sourceId: 'a',
        content: `完全无关的记录内容。`,
        occurredAt: Date.parse('2026-11-04T00:00:00+09:00') + index * 60_000,
      });
    }

    const recalled = backend.recall({ projectId: 'p', agentId: 'a', query: '2026年11月3日我的原话是什么', limit: 5 });
    expect(recalled.items.some((item) => item.text.includes('把发布窗口锁到周二'))).toBe(true);
  } finally {
    kernel.close();
  }
}, 30_000);

test('the local-date fallback covers local midnight to midnight, not UTC (#447)', async () => {
  const kernel = createMemoryKernel({
    dbPath: join(makeTempDir('recall-local-day-'), 'brain.db'),
    projectTimeZone: TOKYO,
  });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    for (const [threadId, content, at] of [
      ['t-alpha', '阿尔法记录', '2026-11-03T00:30:00+09:00'],
      ['t-beta', '贝塔记录', '2026-11-03T23:30:00+09:00'],
      ['t-gamma', '伽马记录', '2026-11-02T23:30:00+09:00'],
      ['t-delta', '德尔塔记录', '2026-11-04T00:30:00+09:00'],
    ] as const) {
      kernel.recordRawEvent({
        threadId, projectId: 'p', role: 'user', sourceId: 'a', content,
        occurredAt: Date.parse(at),
      });
    }
    kernel.factStore.getDatabase().query('UPDATE memory_events SET local_date = NULL').run();

    const recalled = backend.recall({ projectId: 'p', agentId: 'a', query: '2026年11月3日我的原话是什么', limit: 5 });
    const texts = recalled.items.map((item) => item.text);
    expect(texts).toContain('阿尔法记录');
    expect(texts).toContain('贝塔记录');
    expect(texts).not.toContain('伽马记录');
    expect(texts).not.toContain('德尔塔记录');
  } finally {
    kernel.close();
  }
});

test('a month without a year is not pushed into the future, and bare "may" is not a month (#447)', () => {
  const options = { localDateNow: '2026-02-10', timeZone: TOKYO };
  const planner = new MultidimensionalQueryPlanner();

  expect(planner.plan('may I ask what we discussed', options).time).toBeUndefined();
  expect(localDateFor(planner.plan('11月', options).time!.from!, TOKYO)).toBe('2025-11-01');
  expect(localDateFor(planner.plan('in May', options).time!.from!, TOKYO)).toBe('2025-05-01');
  expect(localDateCue('11月3日', options)).toBe('2025-11-03');
  expect(localDateCue('2026年11月3日', options)).toBe('2026-11-03');
});

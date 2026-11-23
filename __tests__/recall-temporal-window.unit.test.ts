import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel, localDateFor } from '../src/public.js';
import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { localDateCue } from '../src/agent/AgentRecallText.js';
import { FacetQueryPlanner } from '../src/atlas/FacetQueryPlanner.js';
import { MultidimensionalQueryPlanner } from '../src/recall/MultidimensionalQueryPlanner.js';
import { relativeDateRange } from '../src/temporal/RelativeDateRange.js';
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

test('year and half-year relative windows keep their civil boundaries (#464)', () => {
  const options = { localDateNow: '2026-11-20', timeZone: TOKYO };
  const window = (query: string) => {
    const range = relativeDateRange(query, options)!;
    return [localDateFor(range.from, TOKYO), localDateFor(range.to, TOKYO)];
  };

  expect(window('今年')).toEqual(['2026-01-01', '2027-01-01']);
  expect(window('去年')).toEqual(['2025-01-01', '2026-01-01']);
  expect(window('近半年')).toEqual(['2026-05-21', '2026-11-21']);
  expect(window('近一年')).toEqual(['2025-11-20', '2026-11-21']);
  expect(window('半年前')).toEqual(['2026-05-04', '2026-06-13']);

  expect(window('昨天')).toEqual(['2026-11-19', '2026-11-20']);
  expect(window('前天')).toEqual(['2026-11-18', '2026-11-19']);
  expect(window('上周')).toEqual(['2026-11-09', '2026-11-16']);
  expect(window('上个月')).toEqual(['2026-10-01', '2026-11-01']);
  expect(window('3天前')).toEqual(['2026-11-17', '2026-11-18']);
});

test('刚才 is a sliding two-hour window, not a civil day (#491)', () => {
  const now = Date.parse('2026-11-24T00:05:00+09:00');
  const range = relativeDateRange('刚才', { now, timeZone: TOKYO })!;
  expect(range.from).toBe(now - 2 * 60 * 60 * 1000);
  expect(range.to).toBe(now + 1);
});

test('a yearless facet day falls back to last year when its month is still ahead (#464)', () => {
  const planner = new FacetQueryPlanner();
  const timeValue = (query: string, localDateNow: string) =>
    planner.plan(query, { projectId: 'p', localDateNow, timeZone: TOKYO }).facets.find((facet) => facet.type === 'time')?.value;

  expect(timeValue('11月3日', '2026-02-10')).toBe('2025-11-03');
  expect(timeValue('11月3日', '2026-11-20')).toBe('2026-11-03');
  expect(timeValue('2026年11月3日', '2026-02-10')).toBe('2026-11-03');
});

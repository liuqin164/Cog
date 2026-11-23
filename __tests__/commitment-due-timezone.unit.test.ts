import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { parseCommitmentDue, recognizeCommitments } from '../src/commitment/index.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

describe('a due instant follows the project time zone, not UTC', () => {
  test('JST 10:00「明天」是次日 18:00 JST', () => {
    const now = Date.UTC(2026, 10, 15, 1);
    expect(parseCommitmentDue('我明天把文件发你', now, 'Asia/Tokyo').dueAt).toBe(Date.UTC(2026, 10, 16, 9));
  });

  test('JST 01:00「今晚」是当日 22:00 JST', () => {
    const now = Date.UTC(2026, 10, 14, 16);
    expect(parseCommitmentDue('我今晚把文件发你', now, 'Asia/Tokyo').dueAt).toBe(Date.UTC(2026, 10, 15, 13));
  });

  test('America/New_York 跨春令时仍落在本地 18:00', () => {
    const now = Date.UTC(2026, 2, 7, 15);
    expect(parseCommitmentDue('我明天把文件发你', now, 'America/New_York').dueAt).toBe(Date.UTC(2026, 2, 8, 22));
  });

  test('the recognizer carries the zone for every signal', () => {
    const [signal] = recognizeCommitments({
      text: '我明天把文件发你。',
      role: 'user',
      occurredAt: Date.UTC(2026, 10, 15, 1),
      timeZone: 'Asia/Tokyo',
    });
    expect(signal?.dueAt).toBe(Date.UTC(2026, 10, 16, 9));
  });

  test('the commitment book reads its project zone end to end', () => {
    const scratch = makeTempDir('cogmem-commitment-zone-');
    const kernel = createMemoryKernel({ dbPath: join(scratch, 'memory.db'), projectTimeZone: 'Asia/Tokyo' });
    try {
      const projectId = 'commitment-tokyo';
      const now = Date.UTC(2026, 10, 15, 1);
      kernel.recordRawEvent({ projectId, threadId: 't-tokyo', role: 'user', content: '我明天把文件发你。', occurredAt: now });
      kernel.commitments.compile({ projectId, now: now + 1_000 });
      expect(kernel.commitments.list({ projectId, now: now + 1_000 })[0]!.dueAt).toBe(Date.UTC(2026, 10, 16, 9));
    } finally {
      kernel.close();
    }
  });
});

describe('下周X and 这周 follow ISO weekday numbering', () => {
  const targets = [
    ['一', 1],
    ['二', 2],
    ['三', 3],
    ['四', 4],
    ['五', 5],
    ['六', 6],
    ['日', 7],
  ] as const;
  const daysAhead: Record<number, readonly number[]> = {
    1: [7, 8, 9, 10, 11, 12, 13],
    2: [6, 7, 8, 9, 10, 11, 12],
    3: [5, 6, 7, 8, 9, 10, 11],
    4: [4, 5, 6, 7, 8, 9, 10],
    5: [3, 4, 5, 6, 7, 8, 9],
    6: [2, 3, 4, 5, 6, 7, 8],
    7: [1, 2, 3, 4, 5, 6, 7],
  };
  const weekdayNames: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };

  for (const [todayIso, row] of Object.entries(daysAhead)) {
    for (const [token, targetIso] of targets) {
      test(`JST 00:30 周${weekdayNames[Number(todayIso)]}说下周${token}`, () => {
        const now = Date.UTC(2026, 10, 15 + Number(todayIso) - 1, 15, 30);
        const expected = Date.UTC(2026, 10, 16 + Number(todayIso) - 1 + row[targetIso - 1]!, 9);
        expect(parseCommitmentDue(`我下周${token}把方案给你`, now, 'Asia/Tokyo').dueAt).toBe(expected);
      });
    }
  }

  test('JST 周三 00:30 说「下周一」是 5 天后的周一 18:00', () => {
    const now = Date.UTC(2026, 10, 17, 15, 30);
    expect(parseCommitmentDue('我下周一前把方案给你', now, 'Asia/Tokyo').dueAt).toBe(Date.UTC(2026, 10, 23, 9));
  });

  test('JST 周日 00:30 说「这周」是当天 18:00', () => {
    const now = Date.UTC(2026, 10, 21, 15, 30);
    expect(parseCommitmentDue('我这周把方案给你', now, 'Asia/Tokyo').dueAt).toBe(Date.UTC(2026, 10, 22, 9));
  });
});

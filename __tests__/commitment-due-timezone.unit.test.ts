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

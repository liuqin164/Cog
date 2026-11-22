import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const kernels: MemoryKernel[] = [];

afterEach(() => {
  while (kernels.length > 0) kernels.pop()!.close();
});

describe('forget erases an intention stream and its wake intention', () => {
  test('the updated content, the reopened book and the wake row are all gone', () => {
    const dir = makeTempDir('cogmem-forget-intention-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
    kernels.push(kernel);
    const projectId = 'forget-intention';
    const marker = 'zzintentionmarker424';
    const now = Date.UTC(2026, 10, 20, 9);
    const source = kernel.recordRawEvent({
      projectId,
      threadId: 't-forget-intention',
      role: 'user',
      content: `${marker} 我准备把缓存层换掉。`,
      occurredAt: now,
    });
    const proposed = kernel.intentions.propose({
      projectId,
      agentId: 'hermes',
      content: `${marker} 我准备把缓存层换掉。`,
      sourceRefs: [{ eventId: source.eventId }],
      dueAt: now + 60_000,
      now: now + 1,
    });
    const scheduled = kernel.intentions.schedule({ projectId, intentionId: proposed.intentionId, now: now + 2 });
    expect(scheduled.wakeIntentionId).toBeTruthy();
    const wakeId = scheduled.wakeIntentionId!;
    expect(kernel.wakeIntentions.get(wakeId, projectId)).toBeTruthy();
    const db = kernel.factStore.getDatabase();
    const hits = () => Number((db.prepare(`SELECT COUNT(*) AS c FROM memory_events_fts WHERE memory_events_fts MATCH ?`)
      .get(marker) as { c: number }).c);
    expect(hits()).toBeGreaterThan(0);

    kernel.sovereignty.deleteRange({ projectId, start: now - 1, end: now + 1 });

    expect(kernel.intentions.audit({ projectId, intentionId: proposed.intentionId })).toHaveLength(0);
    expect(kernel.intentions.list({ projectId }).some((entry) => entry.intentionId === proposed.intentionId)).toBe(false);
    expect(kernel.wakeIntentions.get(wakeId, projectId)).toBeNull();
    expect(hits()).toBe(0);
  });
});

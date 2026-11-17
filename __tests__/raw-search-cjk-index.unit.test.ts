import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { EventStore } from '../src/store/EventStore.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * A two-character Chinese word is a lookup, not a LIKE scan (#100).
 *
 * `unicode61` keeps a run of Chinese characters as one token, so `张伟` inside
 * "我今天下午去了北京出差见了张伟" is not an FTS term and the old path fell
 * through to `fallbackRawTextSearch`. The term table indexes overlapping
 * two-character runs, ordered by `global_seq`, which is exactly the order the
 * fallback produces for a single token.
 */

function tempDbPath(prefix: string): string {
  return join(makeTempDir(prefix), 'memory.db');
}

function seed(instance: EventStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    instance.append({
      streamId: `thread-${index}`,
      streamType: 'thread',
      eventType: 'RAW_EVENT_RECORDED',
      projectId: 'p',
      payload: { text: `第 ${index} 条：涉及单据号 D-${index}，负责人 张伟。`, role: 'user' },
    });
  }
  instance.append({
    streamId: 'target',
    streamType: 'thread',
    eventType: 'RAW_EVENT_RECORDED',
    projectId: 'p',
    payload: { text: '我今天下午去了北京出差见了张伟', role: 'user' },
  });
}

test('a two-character Chinese query returns the fallback rows through the index', () => {
  const store = new EventStore(tempDbPath('cogmem-cjk-same-'));
  seed(store, 20);

  const fallbackIds = (store as any)
    .fallbackRawTextSearch('张伟', { projectId: 'p' }, 50)
    .map((event: { eventId: string }) => event.eventId);
  const fallbackCalls: string[] = [];
  const original = (store as any).fallbackRawTextSearch;
  (store as any).fallbackRawTextSearch = function (query: string, ...rest: unknown[]) {
    fallbackCalls.push(query);
    return original.call(this, query, ...rest);
  };

  const rows = store.searchRawEvents('张伟', { projectId: 'p', limit: 50 });

  expect(fallbackIds.length).toBe(21);
  expect(rows.map((event) => event.eventId)).toEqual(fallbackIds);
  expect(fallbackCalls).toEqual([]);

  // A complete index also answers "nothing" without the scan.
  expect(store.searchRawEvents('上海', { projectId: 'p', limit: 50 })).toEqual([]);
  expect(fallbackCalls).toEqual([]);
  store.close();
});

test('the two-character lookup is an index range scan', () => {
  const store = new EventStore(tempDbPath('cogmem-cjk-plan-'));
  seed(store, 5);

  const plan = store.getDatabase().prepare(`
    EXPLAIN QUERY PLAN
    SELECT e.event_id
    FROM memory_event_cjk_terms t
    JOIN memory_events e ON e.event_id = t.event_id
    WHERE t.term = ? AND COALESCE(e.project_id, '') = ?
    ORDER BY t.global_seq ASC, t.event_id ASC
    LIMIT ?
  `).all('张伟', 'p', 20) as Array<{ detail: string }>;

  expect(plan.map((row) => row.detail).join(' ')).toContain('idx_memory_event_cjk_terms_seq');
  store.close();
});

test('the lookup does not grow with the corpus', () => {
  const measure = (count: number): number => {
    const store = new EventStore(tempDbPath(`cogmem-cjk-scale-${count}-`));
    seed(store, count);
    store.searchRawEvents('张伟', { projectId: 'p' });
    const samples: number[] = [];
    for (let round = 0; round < 30; round += 1) {
      const started = performance.now();
      store.searchRawEvents('张伟', { projectId: 'p' });
      samples.push(performance.now() - started);
    }
    store.close();
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length / 2)]!;
  };

  const small = measure(25);
  const large = measure(250);
  expect(large).toBeLessThan(small * 4 + 5);
}, 20000);

test('reopening rebuilds the terms for a ledger written before the index', () => {
  const path = tempDbPath('cogmem-cjk-backfill-');
  const first = new EventStore(path);
  seed(first, 5);
  first.close();

  const raw = new Database(path);
  raw.exec(`DELETE FROM memory_event_cjk_terms`);
  raw.exec(`DELETE FROM memory_event_fts_state WHERE key LIKE 'cjk_%'`);
  raw.close();

  const reopened = new EventStore(path);
  expect(reopened.searchRawEvents('张伟', { projectId: 'p' }).length).toBe(6);
  expect((reopened as any).countRawEventMatches('张伟', { projectId: 'p', cap: 3 })).toBe(3);
  reopened.close();
});

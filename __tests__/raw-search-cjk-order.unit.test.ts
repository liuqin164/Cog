import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { EventStore } from '../src/store/EventStore.js';
import { makeTempDir } from './helpers/tmp.js';

function store(): EventStore {
  return new EventStore(join(makeTempDir('cogmem-cjk-order-'), 'memory.db'));
}

function append(instance: EventStore, text: string, threadId: string): string {
  return instance.append({
    streamId: threadId,
    streamType: 'thread',
    eventType: 'RAW_EVENT_RECORDED',
    projectId: 'p',
    payload: { text, role: 'user' },
  }).eventId;
}

test('a two-character CJK relevance lookup returns the newest match first', () => {
  const instance = store();
  const ids = Array.from({ length: 5 }, (_, index) => append(instance, `第 ${index} 条：负责人 张伟。`, `t-${index}`));

  expect(instance.searchRawEvents('张伟', { projectId: 'p', limit: 3, orderBy: 'relevance' }).map((event) => event.eventId))
    .toEqual(ids.slice(-3).reverse());
  expect(instance.searchRawEvents('张伟', { projectId: 'p', limit: 3 }).map((event) => event.eventId))
    .toEqual(ids.slice(0, 3));
  instance.close();
});

test('a multi-character CJK query is answered by the posting intersection, newest first', () => {
  const instance = store();
  const ids = Array.from({ length: 4 }, (_, index) => append(instance, `第 ${index} 条：我今天下午去了北京出差见了张伟。`, `t-${index}`));
  const fallbackCalls: string[] = [];
  const original = (instance as any).fallbackRawTextSearch;
  (instance as any).fallbackRawTextSearch = function (query: string, ...rest: unknown[]) {
    fallbackCalls.push(query);
    return original.call(this, query, ...rest);
  };

  const rows = instance.searchRawEvents('北京出差见了张伟', { projectId: 'p', limit: 2, orderBy: 'relevance' });
  expect(rows.map((event) => event.eventId)).toEqual(ids.slice(-2).reverse());
  expect(fallbackCalls).toEqual([]);
  expect((instance as any).countRawEventMatches('北京出差见了张伟', { projectId: 'p', cap: 10 })).toBe(4);
  expect(fallbackCalls).toEqual([]);
  instance.close();
});

test('the LIKE fallback tie-break is newest first on the relevance path', () => {
  const instance = store();
  const ids = Array.from({ length: 3 }, (_, index) => append(instance, `第 ${index} 条：我去了东京旅行。`, `t-${index}`));

  expect(instance.searchRawEvents('东京之旅 nomatchword', { projectId: 'p', limit: 3, orderBy: 'relevance' }).map((event) => event.eventId))
    .toEqual(ids.slice().reverse());
  instance.close();
});

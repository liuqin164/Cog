import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { EventStore } from '../src/store/EventStore.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * A recall query mixes words the ledger holds everywhere with one code that is
 * unique. Matching any word is right — the question is not the statement — but
 * one OR over every word lets the common word decide the cost: SQLite ranks the
 * whole ledger before LIMIT can drop anything (#243). The bounded path reads a
 * capped candidate list per word instead, and the LIKE scan stays the last
 * resort rather than the normal path.
 */

test('a common word plus a hyphenated code does not fall through to the LIKE scan', () => {
  const instance = new EventStore(join(makeTempDir('cogmem-raw-bounded-'), 'memory.db'));
  for (let index = 0; index < 40; index += 1) {
    instance.append({
      streamId: `thread-${index}`,
      streamType: 'thread',
      eventType: 'RAW_EVENT_RECORDED',
      projectId: 'p',
      payload: { text: `第 ${index} 件事：重构，涉及单据号 D-${index}，负责人 张伟。`, role: 'user' },
    });
  }
  instance.append({
    streamId: 'answer',
    streamType: 'thread',
    eventType: 'RAW_EVENT_RECORDED',
    projectId: 'p',
    payload: { text: '有一件事：迁移，涉及单据号 DECADE-10-7000，负责人 张伟。', role: 'user' },
  });

  const fallbackCalls: string[] = [];
  const original = (instance as any).fallbackRawTextSearch;
  (instance as any).fallbackRawTextSearch = function (query: string, ...rest: unknown[]) {
    fallbackCalls.push(query);
    return original.call(this, query, ...rest);
  };

  const rows = instance.searchRawEvents('单据号 DECADE-10-7000 那件事是谁负责的', {
    projectId: 'p',
    limit: 10,
    orderBy: 'relevance',
  });

  expect(rows.some((row) => String((row.payload as { text?: string }).text ?? '').includes('DECADE-10-7000'))).toBe(true);
  expect(fallbackCalls).toEqual([]);
  instance.close();
});

import { expect, test } from 'bun:test';

import { EventStore } from '../src/store/EventStore.js';

const input = { streamId: 'retry-stream', streamType: 'thread' as const, eventType: 'RAW_EVENT_RECORDED' as const, payload: {} };

function storeThrowing(message: string): { store: EventStore; attempts: () => number } {
  const store = new EventStore(':memory:');
  let attempts = 0;
  (store as unknown as { db: unknown }).db = {
    transaction: () => () => {
      attempts += 1;
      throw new Error(message);
    },
  };
  return { store, attempts: () => attempts };
}

test('#412 a lock conflict reaches the caller without a busy retry', () => {
  const { store, attempts } = storeThrowing('database is locked');
  expect(() => store.append(input)).toThrow('database is locked');
  expect(attempts()).toBe(1);
});

test('#412 a stream version conflict is still retried', () => {
  const { store, attempts } = storeThrowing('UNIQUE constraint failed: memory_events.project_scope, memory_events.stream_id, memory_events.event_version');
  expect(() => store.append(input)).toThrow('UNIQUE constraint failed');
  expect(attempts()).toBe(6);
});

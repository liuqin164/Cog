import { expect, test } from 'bun:test';

import { AgentRecallEngine } from '../src/agent/AgentRecallEngine.js';
import type { AgentRecallItem } from '../src/agent/AgentMemoryTypes.js';

const NOW = Date.UTC(2026, 10, 6);
const DAY = 86_400_000;

function item(id: string, text: string, occurredAt?: number, order = 0): AgentRecallItem {
  return {
    id, text, tags: [], projectId: 'p', sourceType: 'raw_ledger',
    sourceAnchor: { eventId: id, occurredAt, turnSeq: order, eventOrdinal: order },
  };
}

function merge(items: AgentRecallItem[]): AgentRecallItem[] {
  const engine = new AgentRecallEngine({} as never);
  const method = (engine as unknown as {
    mergeRecallItems(primary: AgentRecallItem[], secondary: AgentRecallItem[], limit: number, forensic?: boolean): AgentRecallItem[];
  }).mergeRecallItems;
  return method.call(engine, items, [], 5, true);
}

test('#457 supersession orders by anchor event time, not turnSeq', () => {
  const newer = item('newer', 'Correction: the deploy window for beacon is now on day 17.', NOW, 1);
  const older = item('older', 'The deploy window for beacon is on day 3.', NOW - DAY, 99);

  expect(merge([newer, older]).map((entry) => entry.id)).toEqual(['newer']);
});

test('#457 an item without an anchor event time gives up the comparison', () => {
  const untimed = item('untimed', 'The deploy window for beacon is on day 3.', undefined, 99);
  const correction = item('correction', 'Correction: the deploy window for beacon is now on day 17.', NOW, 1);

  expect(merge([untimed, correction]).map((entry) => entry.id)).toEqual(['untimed', 'correction']);
});

import { expect, test } from 'bun:test';

import { measureDecade, quantile } from '../scripts/measure-decade-curve.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * The decade harness is a measurement, not product behaviour. This keeps its two
 * pieces honest on a corpus small enough for the suite: the nearest-rank quantile
 * the curves use, and the checkpoint shape at each year boundary.
 */

test('quantile is nearest-rank', () => {
  expect(quantile([], 0.5)).toBe(0);
  expect(quantile([3, 1, 2], 0.5)).toBe(2);
  expect(quantile([3, 1, 2], 0.95)).toBe(3);
});

test('a two-year corpus reports compile and recall at each checkpoint', async () => {
  const result = await measureDecade({
    years: 2,
    turnsPerYear: 40,
    probeTurns: 3,
    recallRounds: 1,
    seed: 11,
    dir: makeTempDir('cogmem-decade-'),
  });

  expect(result.checkpoints).toHaveLength(2);
  const first = result.checkpoints[0]!;
  const second = result.checkpoints[1]!;
  expect(first.turns).toBe(43);
  expect(second.events).toBeGreaterThan(first.events);
  for (const point of result.checkpoints) {
    expect(point.compile.samples).toBe(3);
    expect(point.compile.medianMs).toBeGreaterThan(0);
    expect(point.recall.queries).toBe(point.year);
    expect(point.recall.byTarget).toHaveLength(point.year);
    expect(point.recall.byTarget.every((target) => target.ageDays >= 0)).toBe(true);
  }
});

import { describe, expect, test } from 'bun:test';

import { defaultShellConfig } from '../src/config.ts';
import { ClockService } from '../src/plugins/clock.ts';
import type { StateMachine } from '../src/state/machine.ts';
import { makeTempDir } from './helpers.ts';

const config = {
  timeZone: 'UTC',
  idleWakeIntervalMs: 60_000,
  dreamWindow: { startHour: 3, endHour: 5 },
};

function clock(): ClockService {
  const machine = {
    wakeIntents: [],
    runtime: { lastInteractionAt: undefined },
  } as unknown as StateMachine;
  return new ClockService(machine, config);
}

describe('the time context is minute-stable (#320)', () => {
  test('milliseconds do not reach the prompt', () => {
    const block = clock().timeContextBlock(Date.UTC(2026, 10, 18, 21, 59, 21, 861));
    expect(block).toContain('now: 2026-11-18T21:59Z');
    expect(block).not.toContain('.861');
    expect(block).not.toContain('21:59:21');
  });

  test('two requests in one minute render identical bytes; the next minute changes it', () => {
    const service = clock();
    const start = Date.UTC(2026, 10, 18, 21, 59, 21, 861);
    const sameMinute = service.timeContextBlock(start + 38_000);
    const nextMinute = service.timeContextBlock(start + 60_000);

    expect(sameMinute).toBe(service.timeContextBlock(start));
    expect(nextMinute).not.toBe(sameMinute);
    expect(nextMinute).toContain('now: 2026-11-18T22:00Z');
  });

  test('the next wake intent is minute-stable too', () => {
    const machine = {
      wakeIntents: [{ id: 'w1', at: Date.UTC(2026, 10, 18, 22, 3, 44, 512), reason: 'idle' }],
      runtime: { lastInteractionAt: undefined },
    } as unknown as StateMachine;
    const service = new ClockService(machine, config);
    const at = Date.UTC(2026, 10, 18, 21, 59, 0);
    expect(service.timeContextBlock(at)).toContain('2026-11-18T22:03Z (idle)');
  });
});

describe('the dream window and its target day (#327)', () => {
  function service(window: { startHour: number; endHour: number }): ClockService {
    const machine = { wakeIntents: [], runtime: {} } as unknown as StateMachine;
    return new ClockService(machine, { timeZone: 'UTC', idleWakeIntervalMs: 60_000, dreamWindow: window });
  }

  test('a 23 to 6 window is open on both sides of midnight and closed at noon', () => {
    const clock = service({ startHour: 23, endHour: 6 });
    expect(clock.dreamWindowOpen(Date.UTC(2026, 2, 10, 23, 30))).toBe(true);
    expect(clock.dreamWindowOpen(Date.UTC(2026, 2, 11, 2, 0))).toBe(true);
    expect(clock.dreamWindowOpen(Date.UTC(2026, 2, 11, 6, 0))).toBe(false);
    expect(clock.dreamWindowOpen(Date.UTC(2026, 2, 11, 12, 0))).toBe(false);
  });

  test('a zero-length window never opens', () => {
    const clock = service({ startHour: 3, endHour: 3 });
    expect(clock.dreamWindowOpen(Date.UTC(2026, 2, 11, 3, 0))).toBe(false);
  });

  test('the 02:00 dream folds yesterday; the 23:30 dream folds the day before that', () => {
    const morning = service({ startHour: 2, endHour: 5 });
    expect(morning.dreamTargetDate(Date.UTC(2026, 2, 11, 2, 0))).toBe('2026-03-10');
    expect(morning.dreamTargetDate(Date.UTC(2026, 2, 11, 4, 59))).toBe('2026-03-10');

    const midnight = service({ startHour: 23, endHour: 6 });
    expect(midnight.dreamTargetDate(Date.UTC(2026, 2, 10, 23, 30))).toBe('2026-03-09');
    expect(midnight.dreamTargetDate(Date.UTC(2026, 2, 11, 2, 0))).toBe('2026-03-09');
  });

  test('catch-up is closed only after the window ends', () => {
    const clock = service({ startHour: 2, endHour: 5 });
    expect(clock.dreamWindowClosed(Date.UTC(2026, 2, 11, 4, 59))).toBe(false);
    expect(clock.dreamWindowClosed(Date.UTC(2026, 2, 11, 5, 0))).toBe(true);
    expect(clock.dreamWindowClosed(Date.UTC(2026, 2, 11, 1, 0))).toBe(true);
  });

  test('config refuses a zero-length window and names the reason', () => {
    const dir = makeTempDir('dream-window-');
    expect(() => defaultShellConfig({
      dataDir: dir,
      workspaceRoot: dir,
      dream: { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 },
    })).toThrow(/invalid_dream_window: start 3 equals end 3/u);

    const previousStart = process.env.COG_DREAM_START;
    const previousEnd = process.env.COG_DREAM_END;
    process.env.COG_DREAM_START = '23';
    process.env.COG_DREAM_END = '23';
    try {
      expect(() => defaultShellConfig({ dataDir: dir, workspaceRoot: dir })).toThrow(/invalid_dream_window/u);
    } finally {
      if (previousStart === undefined) delete process.env.COG_DREAM_START;
      else process.env.COG_DREAM_START = previousStart;
      if (previousEnd === undefined) delete process.env.COG_DREAM_END;
      else process.env.COG_DREAM_END = previousEnd;
    }
  });
});

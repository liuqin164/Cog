import { describe, expect, test } from 'bun:test';

import { ClockService } from '../src/plugins/clock.ts';
import type { StateMachine } from '../src/state/machine.ts';

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

import { describe, expect, test } from 'bun:test';
import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 1, 3);

function healthSnapshot(payload: unknown): { lastSuccessAt: number | null; lastFailureAt: number | null } {
  return (payload as { snapshot: { lastSuccessAt: number | null; lastFailureAt: number | null } }).snapshot;
}

describe('resident snapshot retry (#404)', () => {
  test('overlapping ticks run one pass and trace the skip (#453)', async () => {
    const clock = { now: T0 };
    const shell: CompanionShell = makeShell(
      makeTempDir('resident-tick-inflight-'),
      new ScriptedProvider([{ text: '在。', toolCalls: [] }]),
      {},
      { now: () => clock.now },
    );
    await shell.start();
    try {
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const backup = shell.kernel.backup as unknown as { snapshot: () => Promise<unknown> };
      backup.snapshot = async () => {
        calls += 1;
        await gate;
        return {
          snapshot: { file: 'brain-test.snap' },
          createdAt: new Date(clock.now).toISOString(),
          verification: { ok: true },
        };
      };

      const first = shell.tick(T0);
      const second = shell.tick(T0);
      await waitUntil(() => calls === 1);
      release();
      await Promise.all([first, second]);

      expect(calls).toBe(1);
      expect(shell.trace.read().filter((record) => record.kind === 'tick_skipped')).toHaveLength(1);
      expect(shell.trace.read().filter((record) => record.kind === 'snapshot_taken')).toHaveLength(1);

      clock.now = T0 + 24 * 60 * MINUTE;
      await shell.tick(clock.now);
      expect(calls).toBe(2);
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('a failed snapshot backs off 5/10/20/30 minutes and only success advances the day', async () => {
    const clock = { now: T0 };
    const shell: CompanionShell = makeShell(
      makeTempDir('resident-snapshot-'),
      new ScriptedProvider([{ text: '在。', toolCalls: [] }]),
      { http: { enabled: true, port: 0, hostname: '127.0.0.1' } },
      { now: () => clock.now },
    );
    await shell.start();
    try {
      let calls = 0;
      let fail = true;
      const backup = shell.kernel.backup as unknown as { snapshot: () => Promise<unknown> };
      backup.snapshot = async () => {
        calls += 1;
        if (fail) throw new Error('disk full');
        return {
          snapshot: { file: 'brain-test.snap' },
          createdAt: new Date(clock.now).toISOString(),
          verification: { ok: true },
        };
      };

      await shell.tick(T0);
      expect(calls).toBe(1);
      expect(shell.machine.runtime.lastSnapshotAt).toBeUndefined();
      expect(shell.machine.runtime.lastSnapshotFailureAt).toBe(T0);
      expect(shell.machine.runtime.snapshotRetry).toEqual({ attempts: 1, nextAt: T0 + 5 * MINUTE });
      expect(healthSnapshot(await (await fetch(`${shell.httpUrl}/health`)).json())).toEqual({
        lastSuccessAt: null,
        lastFailureAt: T0,
      });

      await shell.tick(T0 + 4 * MINUTE);
      expect(calls).toBe(1);
      await shell.tick(T0 + 5 * MINUTE);
      expect(calls).toBe(2);
      expect(shell.machine.runtime.snapshotRetry).toEqual({ attempts: 2, nextAt: T0 + 15 * MINUTE });
      await shell.tick(T0 + 15 * MINUTE);
      expect(calls).toBe(3);
      expect(shell.machine.runtime.snapshotRetry).toEqual({ attempts: 3, nextAt: T0 + 35 * MINUTE });
      await shell.tick(T0 + 35 * MINUTE);
      expect(calls).toBe(4);
      expect(shell.machine.runtime.snapshotRetry).toEqual({ attempts: 4, nextAt: T0 + 65 * MINUTE });

      fail = false;
      await shell.tick(T0 + 65 * MINUTE);
      expect(calls).toBe(5);
      expect(shell.machine.runtime.lastSnapshotAt).toBe(T0 + 65 * MINUTE);
      expect(shell.machine.runtime.snapshotRetry).toBeUndefined();
      expect(healthSnapshot(await (await fetch(`${shell.httpUrl}/health`)).json())).toEqual({
        lastSuccessAt: T0 + 65 * MINUTE,
        lastFailureAt: T0 + 35 * MINUTE,
      });

      await shell.tick(T0 + 66 * MINUTE);
      expect(calls).toBe(5);
    } finally {
      await shell.stop();
    }
  }, 60_000);
});

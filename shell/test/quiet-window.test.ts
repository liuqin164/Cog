import { describe, expect, test } from 'bun:test';
import { defaultShellConfig } from '../src/config.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const QUIET_AT = Date.UTC(2026, 10, 15, 23, 30, 0);
const AFTER_QUIET = Date.UTC(2026, 10, 16, 7, 30, 0);
const NO_DREAM = { windowStartHour: 0, windowEndHour: 1, runKernelNight: false, maxEpisodes: 5 };

describe('the quiet window gates proactive speech (#328)', () => {
  test('a due promise is queued in the window and delivered on the first tick after it', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: '我在。', toolCalls: [] },
      { text: '提醒你。', toolCalls: [] },
    ]);
    let now = QUIET_AT;
    const shell = makeShell(dir, provider, { quiet: { startHour: 23, endHour: 7 }, dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'quiet-seed',
        userText: '我今晚把面包店地址发你',
        assistantText: '记下了。',
        timestamp: QUIET_AT,
        ingestMode: 'immediate_compile',
      });
      shell.kernel.commitments.compile({ projectId: shell.config.projectId, now: QUIET_AT + 1_000 });

      const events: unknown[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));

      await shell.tick(QUIET_AT);
      expect(events).toHaveLength(0);
      expect(shell.machine.runtime.awayQueue).toHaveLength(1);
      expect(shell.machine.runtime.awayQueue?.[0]?.deferred).toBe('quiet');

      const status = await shell.runCommand('status', '');
      expect(status.text).toContain('23:00–07:00（生效中）');

      await shell.submit('我还在，只是路过。');
      expect(provider.calls).toHaveLength(1);

      now = AFTER_QUIET;
      await shell.tick(AFTER_QUIET);
      expect(events).toHaveLength(1);
      expect(provider.calls).toHaveLength(2);
      expect(shell.machine.runtime.awayQueue).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the config reads a cross-midnight window and refuses a broken one', () => {
    const previousStart = process.env.COG_QUIET_START;
    const previousEnd = process.env.COG_QUIET_END;
    try {
      process.env.COG_QUIET_START = '23';
      process.env.COG_QUIET_END = '7';
      const dir = makeTempDir();
      expect(defaultShellConfig({ dataDir: dir }).quiet).toEqual({ startHour: 23, endHour: 7 });

      process.env.COG_QUIET_END = '23';
      expect(() => defaultShellConfig({ dataDir: dir })).toThrow('invalid_quiet_window');
    } finally {
      if (previousStart === undefined) delete process.env.COG_QUIET_START;
      else process.env.COG_QUIET_START = previousStart;
      if (previousEnd === undefined) delete process.env.COG_QUIET_END;
      else process.env.COG_QUIET_END = previousEnd;
    }
  });
});

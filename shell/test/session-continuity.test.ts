import { describe, expect, test } from 'bun:test';
import { localDateFor, localDateRange } from 'cogmem';

import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

const ZONE = 'Asia/Tokyo';

describe('session continuity across midnight', () => {
  test('the request after midnight carries the previous day tail', async () => {
    const firstDay = localDateRange(2026, 6, 1, 2026, 6, 2, ZONE);
    const secondDay = localDateRange(2026, 6, 2, 2026, 6, 3, ZONE);
    const clock = { now: firstDay.to - 2 * 60_000 };
    const provider = new ScriptedProvider([
      { text: 'noted the blue teapot', toolCalls: [] },
      { text: 'still here', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('session-continuity-'), provider, { timeZone: ZONE }, { now: () => clock.now });
    await shell.start();
    try {
      await shell.submit('remember the blue teapot');
      clock.now = secondDay.from + 2 * 60_000;
      await shell.submit('what did I just say?');

      const injected = provider.calls[1]!.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const start = injected.indexOf('[tail]');
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = injected.slice(start);
      const recall = rest.indexOf('[recall]');
      const tail = recall >= 0 ? rest.slice(0, recall) : rest;
      expect(tail).toContain('remember the blue teapot');
      expect(tail).toContain('noted the blue teapot');

      const previousSession = `session-test:${localDateFor(firstDay.to - 2 * 60_000, ZONE)}`;
      expect(tail).toContain(`[from ${previousSession}]`);
      expect(shell.lastLaneAssembly?.digest.tail.map((turn) => turn.sessionId)).toContain(previousSession);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a run that crosses midnight keeps user and assistant in one session', async () => {
    const firstDay = localDateRange(2026, 6, 1, 2026, 6, 2, ZONE);
    const secondDay = localDateRange(2026, 6, 2, 2026, 6, 3, ZONE);
    const clock = { now: firstDay.to - 60_000 };
    let crossed = false;
    const provider = new ScriptedProvider([
      () => {
        clock.now = secondDay.from + 60_000;
        crossed = true;
        return { text: 'reply after midnight', toolCalls: [] };
      },
    ]);
    const shell = makeShell(makeTempDir('session-midnight-run-'), provider, { timeZone: ZONE }, { now: () => clock.now });
    await shell.start();
    try {
      const summary = (await shell.submit('late night question'))!;
      expect(crossed).toBe(true);
      expect(summary.sessionId).toBe(`session-test:${localDateFor(firstDay.to - 60_000, ZONE)}`);
      const rows = shell.kernel.eventStore.queryEvents(1, 100, { projectId: [shell.config.projectId] }).records
        .filter((event) => event.turnId === summary.turnId && (event.role === 'user' || event.role === 'assistant'));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((event) => event.sessionId))).toEqual(new Set([summary.sessionId]));
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

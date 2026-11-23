/**
 * #248: the session id is an install fact, not a process start time, and the shell's captured turns
 * carry the conversation lane marker the kernel's session context reads.
 */
import { describe, expect, test } from 'bun:test';
import { localDateFor, localDateRange } from 'cogmem';

import { defaultShellConfig } from '../src/config.ts';
import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

describe('session identity', () => {
  test('the configured session id wins, and an uninstalled shell no longer mints one per process', () => {
    const previous = process.env.COG_SESSION;
    try {
      process.env.COG_SESSION = 'session-installed';
      expect(defaultShellConfig({ dataDir: makeTempDir() }).sessionId).toBe('session-installed');
      delete process.env.COG_SESSION;
      const first = defaultShellConfig({ dataDir: makeTempDir() }).sessionId;
      const second = defaultShellConfig({ dataDir: makeTempDir() }).sessionId;
      expect(first).toBe('session-default');
      expect(second).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.COG_SESSION;
      else process.env.COG_SESSION = previous;
    }
  });

  test('a restarted shell reads the same lane back, row for row', async () => {
    const dir = makeTempDir();
    const sessionId = 'session-stable';
    const provider = new ScriptedProvider(Array.from({ length: 9 }, (_, index) => ({ text: `ack ${index + 1}`, toolCalls: [] })));
    const assemble = (shell: ReturnType<typeof makeShell>) => shell.kernel.sessionContext.assemble({
      projectId: shell.config.projectId,
      agentId: shell.config.agentId,
      sessionId: shell.config.sessionId,
      targetTokens: 100_000,
      tailTurns: 16,
    });

    const first = makeShell(dir, provider, { sessionId });
    await first.start();
    for (let round = 1; round <= 8; round += 1) await first.submit(`before restart ${round}`);
    const before = assemble(first);
    const beforeRows = [...before.digest.entries, ...before.digest.tail].map((turn) => turn.text);
    expect(before.digest.tail).toHaveLength(16);
    const expectedSpeakers = Array.from({ length: 8 }, () => ['owner', 'agent'] as const).flat();
    expect(before.digest.tail.map((turn) => turn.speaker)).toEqual(expectedSpeakers);
    await first.stop();

    // A new process on the same data dir and install identity: only the process changed.
    const second = makeShell(dir, provider, { sessionId });
    await second.start();
    try {
      await second.submit('after restart 9');
      const after = assemble(second);
      const afterRows = [...after.digest.entries, ...after.digest.tail].map((turn) => turn.text);
      // The 16 pre-restart rows are still the first 16 in order; the ninth round appended after them.
      expect(afterRows.slice(0, beforeRows.length)).toEqual(beforeRows);
      expect(afterRows.at(-2)).toBe('after restart 9');
      expect(afterRows.at(-1)).toBe('ack 9');
    } finally {
      await second.stop();
    }
  }, 30_000);

  test('the resident lane splits on the project local day, not the host day', async () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const zones = ['America/New_York', 'Asia/Tokyo', 'Europe/Berlin', 'Pacific/Auckland', 'Asia/Kolkata', 'UTC'];
    const project = zones.find((zone) => {
      if (zone === host) return false;
      const first = localDateRange(2026, 6, 1, 2026, 6, 2, zone);
      const second = localDateRange(2026, 6, 2, 2026, 6, 3, zone);
      return localDateFor(first.to - 60_000, host) === localDateFor(second.from + 60_000, host);
    });
    expect(project).toBeDefined();
    const firstDay = localDateRange(2026, 6, 1, 2026, 6, 2, project);
    const secondDay = localDateRange(2026, 6, 2, 2026, 6, 3, project);
    const clock = { now: firstDay.to - 60_000 };
    const shell = makeShell(
      makeTempDir('session-day-split-'),
      new ScriptedProvider([
        { text: 'before.', toolCalls: [] },
        { text: 'after.', toolCalls: [] },
      ]),
      { timeZone: project },
      { now: () => clock.now },
    );
    await shell.start();
    try {
      await shell.submit('before midnight');
      clock.now = secondDay.from + 60_000;
      await shell.submit('after midnight');
      const userRows = shell.kernel.eventStore.queryEvents(1, 100, { projectId: [shell.config.projectId] }).records
        .filter((event) => event.role === 'user');
      const sessions = userRows.map((event) => event.sessionId);
      expect(new Set(sessions).size).toBe(2);
      expect(sessions.some((sessionId) => sessionId?.endsWith(`:${localDateFor(firstDay.to - 60_000, project)}`))).toBe(true);
      expect(sessions.some((sessionId) => sessionId?.endsWith(`:${localDateFor(secondDay.from + 60_000, project)}`))).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

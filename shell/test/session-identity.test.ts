/**
 * #248: the session id is an install fact, not a process start time, and the shell's captured turns
 * carry the conversation lane marker the kernel's session context reads.
 */
import { describe, expect, test } from 'bun:test';

import { defaultShellConfig } from '../src/config.ts';
import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

describe('session identity', () => {
  test('the configured session id wins, and an uninstalled shell no longer mints one per process', () => {
    const previous = process.env.COGMEM_SHELL_SESSION;
    try {
      process.env.COGMEM_SHELL_SESSION = 'session-installed';
      expect(defaultShellConfig({ dataDir: makeTempDir() }).sessionId).toBe('session-installed');
      delete process.env.COGMEM_SHELL_SESSION;
      const first = defaultShellConfig({ dataDir: makeTempDir() }).sessionId;
      const second = defaultShellConfig({ dataDir: makeTempDir() }).sessionId;
      expect(first).toBe('session-default');
      expect(second).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.COGMEM_SHELL_SESSION;
      else process.env.COGMEM_SHELL_SESSION = previous;
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
});

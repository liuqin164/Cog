import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

describe('a run that throws after entering RUNNING', () => {
  test('leaves the machine at IDLE and the next submit still runs', async () => {
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'again', toolCalls: [] }]));
    await shell.start();
    try {
      const runtime = (shell as unknown as { runtime: { run: (...args: unknown[]) => Promise<unknown> } }).runtime;
      const original = runtime.run.bind(runtime);
      runtime.run = async () => {
        throw new Error('runtime unreachable');
      };
      await expect(shell.submit('do work')).rejects.toThrow('runtime unreachable');
      expect(shell.state).toBe('IDLE');
      expect(shell.trace.read().some((record) => record.kind === 'run_execute_failed')).toBe(true);
      runtime.run = original;
      const summary = await shell.submit('try once more');
      expect(summary?.stopReason).toBe('run_complete');
      expect(shell.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanionShell } from '../src/app.ts';
import { defaultShellConfig } from '../src/config.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const BASE = new Date('2026-01-01T12:00:00Z').getTime();

function tokyoDate(at: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

/** One candidate at the decision point, so a tick is an autonomous run. */
function emerge(shell: CompanionShell, id: string): void {
  (shell as unknown as { emergence: unknown }).emergence = {
    decide: () => ({ candidates: [{ id, text: `thought ${id}`, reason: 'test' }], suppressed: [] }),
  };
}

describe('the daily budget (#233)', () => {
  test('budgets.json reads maxTokensPerDay and refuses a non-positive one', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ maxTokensPerDay: 12_345 }));
    const config = defaultShellConfig({ dataDir: dir, workspaceRoot: join(dir, 'ws') });
    expect(config.dailyBudget.maxTokensPerDay).toBe(12_345);

    writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ maxTokensPerDay: 0 }));
    expect(() => defaultShellConfig({ dataDir: dir, workspaceRoot: join(dir, 'ws') })).toThrow(/maxTokensPerDay must be a positive integer/);
  });

  test('an autonomous run is not started once the checkpointed day is at the limit, and the count survives a restart', async () => {
    const dir = makeTempDir();
    const limit = 1_000;
    const first = makeShell(
      dir,
      new ScriptedProvider([{ text: 'spent', toolCalls: [], usage: { input: 1_500, output: 1 } }]),
      { dailyBudget: { maxTokensPerDay: limit } },
      { now: () => BASE },
    );
    await first.start();
    try {
      emerge(first, 'one');
      await first.tick(BASE);
      expect(first.machine.runtime.costDayDate).toBe(tokyoDate(BASE));
      expect(first.machine.runtime.costDayTokens).toBe(1_501);
    } finally {
      await first.stop();
    }

    // A fresh process reads the same checkpoint. The day is over budget, so the candidate is not run.
    const provider = new ScriptedProvider([{ text: 'must not run', toolCalls: [] }]);
    const second = makeShell(dir, provider, { dailyBudget: { maxTokensPerDay: limit } }, { now: () => BASE + 10 * 60_000 });
    await second.start();
    try {
      emerge(second, 'two');
      await second.tick(BASE + 10 * 60_000);
      expect(provider.calls).toHaveLength(0);
      expect(second.trace.read().some((record) => record.kind === 'emergence_skipped' && record.reason === 'daily_token_budget')).toBe(true);
    } finally {
      await second.stop();
    }
  });

  test('a user line still runs when the day is at the limit, and the stop is said out loud once', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'still here', toolCalls: [] }]);
    const shell = makeShell(dir, provider, { dailyBudget: { maxTokensPerDay: 100 } }, { now: () => BASE });
    await shell.start();
    try {
      shell.machine.updateRuntime({ costDayDate: tokyoDate(BASE), costDayTokens: 100 });
      const notices: string[] = [];
      shell.host.bus.on('terminal_print', (event: { text?: string }) => {
        if (typeof event.text === 'string') notices.push(event.text);
      });
      const summary = await shell.submit('hello');
      expect(summary?.stopReason).toBe('run_complete');
      expect(provider.calls).toHaveLength(1);
      expect(notices.join('')).toContain('已到今日预算上限');
      expect(shell.trace.read().some((record) => record.kind === 'daily_budget_exceeded' && record.trigger === 'user_message')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('a crossing is charged per turn and recorded before the run settles', async () => {
    const dir = makeTempDir();
    const shell = makeShell(
      dir,
      new ScriptedProvider([
        { text: 'one', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'x.txt' } }], usage: { input: 60, output: 1 } },
        { text: 'two', toolCalls: [], usage: { input: 60, output: 1 } },
      ]),
      { dailyBudget: { maxTokensPerDay: 100 } },
      { now: () => BASE },
    );
    await shell.start();
    try {
      mkdirSync(join(dir, 'ws'), { recursive: true });
      writeFileSync(join(dir, 'ws', 'x.txt'), 'x');
      await shell.submit('spend a little');
      expect(shell.machine.runtime.costDayTokens).toBe(122);
      expect(shell.trace.read().some((record) => record.kind === 'daily_budget_crossed')).toBe(true);
    } finally {
      await shell.stop();
    }
  });
});

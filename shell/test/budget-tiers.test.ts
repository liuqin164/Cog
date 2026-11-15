import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const TIGHT = { maxTurnsPerRun: 6, maxTokensPerRun: 20_000, toolWhitelist: null };

/** The emergence decision point replaced with one candidate, so a tick starts an autonomous run. */
function emerge(shell: CompanionShell, text = 'an autonomous thought'): void {
  (shell as unknown as { emergence: unknown }).emergence = {
    decide: () => ({ candidates: [{ id: 'candidate-1', text, reason: 'test' }], suppressed: [] }),
  };
}

function budgetRecords(shell: CompanionShell): Array<Record<string, unknown>> {
  return shell.trace.read().filter((record) => record.kind === 'run_budget');
}

function cageViolations(shell: CompanionShell): Array<Record<string, unknown>> {
  return shell.trace.read().filter((record) => record.kind === 'cage_violation');
}

describe('the budget tiers (#222)', () => {
  test('a user-assigned run continues past 20k under the work cage', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'reading the installer', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'installer.ts' } }], usage: { input: 25_000, output: 1 } },
      { text: 'done', toolCalls: [], usage: { input: 100, output: 1 } },
    ]);
    const shell = makeShell(dir, provider, { budgets: TIGHT, workBudget: { maxTurnsPerRun: 32, maxTokensPerRun: 50_000 } });
    await shell.start();
    try {
      const summary = await shell.submit('install the plugin');
      expect(summary!.stopReason).toBe('run_complete');
      expect(summary!.turns).toBe(2);
      expect(summary!.tokens).toBeGreaterThan(20_000);
      expect(cageViolations(shell)).toHaveLength(0);
      const record = budgetRecords(shell).find((entry) => entry.runId === summary!.runId)!;
      expect(record.tier).toBe('work');
      expect(record.maxTokensPerRun).toBe(50_000);
    } finally {
      await shell.stop();
    }
  });

  test('a pure autonomous run is still cut at 20k under the tight cage', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'expensive idea', toolCalls: [], usage: { input: 25_000, output: 1 } }]);
    const shell = makeShell(dir, provider, { budgets: TIGHT, workBudget: { maxTurnsPerRun: 32, maxTokensPerRun: 400_000 } });
    await shell.start();
    try {
      emerge(shell);
      await shell.tick(new Date('2026-01-01T12:00:00Z').getTime());
      expect(shell.state).toBe('IDLE');
      const record = budgetRecords(shell).at(-1)!;
      expect(record.tier).toBe('autonomous');
      expect(record.maxTokensPerRun).toBe(20_000);
      expect(cageViolations(shell).some((entry) => entry.violation === 'token_budget')).toBe(true);
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
    } finally {
      await shell.stop();
    }
  });

  test('a paused work run resumes under the work cage after the owner approves the grant', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'starting', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'config.ts' } }], usage: { input: 3_500, output: 1 } },
      { text: 'finished', toolCalls: [], usage: { input: 2_500, output: 1 } },
    ]);
    const shell = makeShell(dir, provider, {
      budgets: { maxTurnsPerRun: 6, maxTokensPerRun: 1_000, toolWhitelist: null },
      workBudget: { maxTurnsPerRun: 2, maxTokensPerRun: 3_000 },
    });
    await shell.start();
    try {
      const first = await shell.submit('install the plugin');
      expect(first!.stopReason).toBe('budget_exceeded');
      expect(shell.state).toBe('SUSPENDED');
      // The stop is written where the next run reads it: place and next move, not just a counter.
      const open = shell.machine.runtime.openAssignment!;
      expect(open.origin).toBe('user_message');
      expect(open.stoppedStep).toContain('read');
      expect(open.nextStep).toBeTruthy();
      expect(shell.systemPrompt()).toContain('<open-assignment>');
      expect(shell.systemPrompt()).toContain(open.nextStep!);
      expect(shell.trace.read().some((record) => record.kind === 'assignment_stopped')).toBe(true);
      // 3.5k spent on one turn at a 3k cap: the estimate is one more turn at the same rate.
      expect(shell.machine.runtime.suspension?.budget?.additionalTokens).toBe(3_501);
      expect(shell.machine.runtime.suspension?.budget?.additionalTurns).toBe(1);

      const receipt = await shell.runCommand('continue');
      expect(receipt.text).toContain('已批准');
      await waitUntil(() => shell.state === 'IDLE');
      const records = budgetRecords(shell);
      expect(records).toHaveLength(2);
      expect(records[1].tier).toBe('work');
      // The approved grant widens this one run; the base cap in the file is untouched.
      expect(records[1].maxTokensPerRun).toBe(6_501);
      expect(shell.config.workBudget.maxTokensPerRun).toBe(3_000);
      expect(cageViolations(shell).filter((entry) => entry.violation === 'token_budget')).toHaveLength(1);
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
    } finally {
      await shell.stop();
    }
  });

  test('an autonomous wake inherits the work cage when a failed user run left the assignment open', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      () => {
        throw new Error('provider down');
      },
      { text: 'continuing', toolCalls: [], usage: { input: 2_500, output: 1 } },
    ]);
    const shell = makeShell(dir, provider, {
      budgets: { maxTurnsPerRun: 6, maxTokensPerRun: 1_000, toolWhitelist: null },
      workBudget: { maxTurnsPerRun: 2, maxTokensPerRun: 3_000 },
    });
    await shell.start();
    try {
      const first = await shell.submit('install the plugin');
      expect(first!.stopReason).toBe('run_error');
      expect(shell.machine.runtime.openAssignment?.origin).toBe('user_message');

      emerge(shell, 'continue where you stopped');
      await shell.tick(new Date('2026-01-01T12:00:00Z').getTime());
      const records = budgetRecords(shell);
      expect(records).toHaveLength(2);
      expect(records[1].tier).toBe('work');
      expect(records[1].maxTokensPerRun).toBe(3_000);
      // 2.5k is over the tight 1k and under the work 3k: only the inherited tier could finish.
      expect(cageViolations(shell).filter((entry) => entry.violation === 'token_budget')).toHaveLength(0);
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
    } finally {
      await shell.stop();
    }
  });

  test('an autonomous wake with no user assignment stays tight even when one just finished', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'done', toolCalls: [], usage: { input: 10, output: 1 } },
      { text: 'expensive idea', toolCalls: [], usage: { input: 2_500, output: 1 } },
    ]);
    const shell = makeShell(dir, provider, {
      budgets: { maxTurnsPerRun: 6, maxTokensPerRun: 1_000, toolWhitelist: null },
      workBudget: { maxTurnsPerRun: 32, maxTokensPerRun: 400_000 },
    });
    await shell.start();
    try {
      await shell.submit('a task that finishes');
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
      emerge(shell, 'a fresh idea');
      await shell.tick(new Date('2026-01-01T12:00:00Z').getTime());
      expect(budgetRecords(shell).at(-1)!.tier).toBe('autonomous');
      expect(cageViolations(shell).some((entry) => entry.violation === 'token_budget')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('the operating config changes both tiers without a source edit', async () => {
    const dir = makeTempDir();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'budgets.json'), JSON.stringify({
      work: { maxTurnsPerRun: 7, maxTokensPerRun: 40_000 },
      autonomous: { maxTurnsPerRun: 5, maxTokensPerRun: 30_000 },
    }));
    const provider = new ScriptedProvider([
      { text: 'done', toolCalls: [], usage: { input: 25_000, output: 1 } },
      { text: 'done', toolCalls: [], usage: { input: 25_000, output: 1 } },
    ]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      emerge(shell, 'an autonomous thought');
      expect(shell.config.workBudget).toEqual({ maxTurnsPerRun: 7, maxTokensPerRun: 40_000 });
      expect(shell.config.budgets.maxTokensPerRun).toBe(30_000);
      const user = await shell.submit('do the work');
      expect(user!.stopReason).toBe('run_complete');
      expect(user!.tokens).toBe(25_001);
      await shell.tick(new Date('2026-01-01T12:00:00Z').getTime());
      expect(budgetRecords(shell).map((record) => record.tier)).toEqual(['work', 'autonomous']);
      expect(cageViolations(shell)).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  });
});

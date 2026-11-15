/**
 * The cross-run handoff (#223, item 4): a work run that ends unfinished writes its closing text into
 * the open assignment, and the next run's prompt carries it — so a continuation does not re-read the
 * same sources to rediscover the same line numbers.
 *
 * Red/green is the ticket's own discriminator: run A writes a conclusion, run B's prompt contains it.
 */
import { describe, expect, test } from 'bun:test';
import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const TIGHT = { maxTurnsPerRun: 6, maxTokensPerRun: 20_000, toolWhitelist: null };
const NO_DREAM = { windowStartHour: 0, windowEndHour: 0, runKernelNight: false, maxEpisodes: 5 };

function emerge(shell: CompanionShell, text = '继续之前的工作'): void {
  (shell as unknown as { emergence: unknown }).emergence = {
    decide: () => ({ candidates: [{ id: 'candidate-1', text, reason: 'test' }], suppressed: [] }),
  };
}

describe('confirmed findings travel with the open assignment', () => {
  test('run A\'s conclusion is in run B\'s prompt', async () => {
    const dir = makeTempDir('assignment-findings-');
    const conclusion = '结论：插件列表只从 shell/src/config.ts:147 读，安装面是 /plugins。';
    const provider = new ScriptedProvider([
      { text: conclusion, toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
      { text: 'done', toolCalls: [], usage: { input: 1, output: 1 } },
    ]);
    const shell = makeShell(dir, provider, { budgets: TIGHT, workBudget: { maxTurnsPerRun: 4, maxTokensPerRun: 1_000 }, dream: NO_DREAM });
    await shell.start();
    try {
      const first = await shell.submit('install the plugin');
      expect(first!.stopReason).toBe('budget_exceeded');
      expect(shell.machine.runtime.openAssignment?.findings).toBe(conclusion);
      expect(shell.machine.runtime.openAssignment?.findings).toContain('config.ts:147');

      // A continuation is a new run while the assignment is still open; an autonomous wake is the
      // one the shell starts on its own, and it keeps the assignment (a user message starts a new one).
      emerge(shell);
      await shell.tick(Date.now());
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[1].systemPrompt).toContain(`confirmed findings: ${conclusion}`);
      expect(provider.calls[1].systemPrompt).toContain('install the plugin');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an over-long conclusion is truncated to the bound and the cut is traced', async () => {
    const dir = makeTempDir('assignment-findings-long-');
    const long = `结论：${'很长的排查记录。'.repeat(400)}`;
    const provider = new ScriptedProvider([
      { text: long, toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
    ]);
    const shell = makeShell(dir, provider, { budgets: TIGHT, workBudget: { maxTurnsPerRun: 4, maxTokensPerRun: 1_000 }, dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('install the plugin');
      const findings = shell.machine.runtime.openAssignment?.findings ?? '';
      expect(findings.length).toBe(600);
      expect(findings.endsWith('…')).toBe(true);
      const truncated = shell.trace.read().find((record) => record.kind === 'assignment_findings_truncated');
      expect(truncated?.chars).toBe(long.length);
      expect(truncated?.kept).toBe(600);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

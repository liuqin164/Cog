/**
 * #228's discriminating tests: a run that stops to wait for its owner is a first-class state, not a
 * run that happened to end. Each case drives the whole seam — the lifecycle, the checkpoint, the
 * command/proposal faces and the prompt — because a pause that exists in only one of them is the
 * silent stop this feature exists to remove.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { CompanionShell } from '../src/app.ts';
import { CheckpointStore } from '../src/state/checkpoint.ts';
import type { CageConfig } from '../src/plugins/cage.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const TIGHT: CageConfig = { maxTurnsPerRun: 5, maxTokensPerRun: 1_000, toolWhitelist: null };

/** The emergence decision point replaced with one candidate, so a tick starts an autonomous run. */
function emerge(shell: CompanionShell, text = 'continue the open task'): void {
  (shell as unknown as { emergence: unknown }).emergence = {
    decide: () => ({ candidates: [{ id: 'candidate-1', text, reason: 'test' }], suppressed: [] }),
  };
}

function pausedShell(dir: string, provider: ScriptedProvider): CompanionShell {
  return makeShell(dir, provider, { budgets: TIGHT, workBudget: TIGHT });
}

describe('a budget pause (#228)', () => {
  test('the pause is visible, the approval is an offer, and approving continues the same task', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'working', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 1_500, output: 1 } },
      { text: 'finished', toolCalls: [], usage: { input: 100, output: 1 } },
    ]);
    const shell = pausedShell(dir, provider);
    await shell.start();
    try {
      const first = await shell.submit('do the thing');
      expect(first!.stopReason).toBe('budget_exceeded');
      expect(shell.state).toBe('SUSPENDED');

      const suspension = shell.machine.runtime.suspension!;
      expect(suspension.kind).toBe('budget');
      expect(suspension.assignmentId).toBe(shell.machine.runtime.openAssignment!.id);
      expect(suspension.budget?.violation).toBe('token_budget');
      expect(suspension.budget?.additionalTokens).toBeGreaterThan(0);
      expect(suspension.budget?.basis).toContain('tokens over');

      // Visible: the status line says why, and the approval is a pending command proposal.
      expect(shell.currentStatus().suspended?.kind).toBe('budget');
      expect(shell.currentStatus().suspended?.text).toContain('预算到顶');
      const proposal = shell.currentProposals().find((entry) => entry.command === 'continue')!;
      expect(proposal.status).toBe('pending');
      expect(proposal.args).toBe(suspension.id);

      const confirmed = await shell.confirmProposal(proposal.id);
      expect(confirmed.ok).toBe(true);
      expect(confirmed.reply?.text).toContain('已批准');
      await waitUntil(() => shell.state === 'IDLE' && shell.machine.runtime.openAssignment === undefined);

      expect(shell.machine.runtime.suspension).toBeUndefined();
      expect(shell.trace.read().some((record) => record.kind === 'suspension_approved')).toBe(true);
      // The resumed run is the same assignment: its prompt still names the place to continue.
      expect(provider.calls[1].systemPrompt).toContain('<open-assignment>');
      expect(provider.calls[1].systemPrompt).toContain('do the thing');
    } finally {
      await shell.stop();
    }
  });

  test('refusing the offer closes the task as budget_exceeded instead of leaving a pause', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'working', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 1_500, output: 1 } },
    ]);
    const shell = pausedShell(dir, provider);
    await shell.start();
    try {
      await shell.submit('do the thing');
      const proposal = shell.currentProposals().find((entry) => entry.command === 'continue')!;
      shell.discardProposal(proposal.id);
      await waitUntil(() => shell.state === 'IDLE');

      expect(shell.machine.runtime.suspension).toBeUndefined();
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
      const refusal = shell.trace.read().find((record) => record.kind === 'suspension_rejected');
      expect(refusal?.closedAs).toBe('budget_exceeded');
      expect(shell.currentProposals()).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  });

  test('the pause object survives a process restart and is re-offered there', async () => {
    const dir = makeTempDir();
    const first = pausedShell(dir, new ScriptedProvider([
      { text: 'working', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 1_500, output: 1 } },
    ]));
    await first.start();
    await first.submit('do the thing');
    const suspensionId = first.machine.runtime.suspension!.id;
    await first.stop();
    // A graceful stop is still a process end: the pause is on disk, not converted to DORMANT.
    expect(new CheckpointStore(join(dir, 'data')).load()?.state).toBe('SUSPENDED');

    const second = pausedShell(dir, new ScriptedProvider([{ text: 'finished', toolCalls: [] }]));
    await second.start();
    try {
      expect(second.state).toBe('SUSPENDED');
      expect(second.machine.runtime.suspension?.id).toBe(suspensionId);
      expect(second.currentStatus().suspended?.text).toContain('预算');
      expect(second.currentProposals().some((entry) => entry.command === 'continue')).toBe(true);
      expect(second.trace.read().some((record) => record.kind === 'suspension_restored')).toBe(true);

      await second.runCommand('continue');
      await waitUntil(() => second.state === 'IDLE');
      expect(second.machine.runtime.openAssignment).toBeUndefined();
    } finally {
      await second.stop();
    }
  });

  test('an autonomous run still hits the wall: no pause, no assignment, just the cage', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'expensive idea', toolCalls: [], usage: { input: 5_000, output: 1 } }]);
    const shell = makeShell(dir, provider, { budgets: TIGHT, workBudget: { maxTurnsPerRun: 5, maxTokensPerRun: 10_000 } });
    await shell.start();
    try {
      emerge(shell);
      await shell.tick(new Date('2026-01-01T12:00:00Z').getTime());
      expect(shell.state).toBe('IDLE');
      expect(shell.machine.runtime.suspension).toBeUndefined();
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
      expect(shell.trace.read().some((record) => record.kind === 'cage_violation' && record.violation === 'token_budget')).toBe(true);
      expect(shell.trace.read().some((record) => record.kind === 'assignment_paused')).toBe(false);
    } finally {
      await shell.stop();
    }
  });
});

describe('a question pause (#228)', () => {
  test('asking suspends the run, and the owner answer is the next run of the same task', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'I need a decision', toolCalls: [{ toolCallId: 'q1', toolName: 'ask_user', input: { question: '用 A 还是 B？', context: 'src/choice.ts' } }] },
      { text: 'waiting for the answer', toolCalls: [] },
      { text: 'went with A', toolCalls: [] },
    ]);
    const shell = pausedShell(dir, provider);
    await shell.start();
    try {
      const first = await shell.submit('choose a branch');
      expect(first!.stopReason).toBe('run_complete');
      expect(shell.state).toBe('SUSPENDED');
      const suspension = shell.machine.runtime.suspension!;
      expect(suspension.kind).toBe('question');
      expect(suspension.question?.text).toBe('用 A 还是 B？');
      expect(suspension.question?.contextRef).toBe('src/choice.ts');
      expect(shell.currentStatus().suspended?.text).toContain('等你回答');
      // A question is answered by text, not by an approval command.
      expect(shell.currentProposals()).toHaveLength(0);

      const answered = await shell.submit('用 A');
      expect(answered!.userText).toBe('用 A');
      expect(shell.state).toBe('IDLE');
      expect(shell.machine.runtime.suspension).toBeUndefined();
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
      // The question travelled into the resumed run's prompt, so the answer has something to attach to.
      expect(provider.calls[2].systemPrompt).toContain('<pending-question>');
      expect(provider.calls[2].systemPrompt).toContain('用 A 还是 B？');
      expect(shell.trace.read().some((record) => record.kind === 'suspension_answered')).toBe(true);
    } finally {
      await shell.stop();
    }
  });
});


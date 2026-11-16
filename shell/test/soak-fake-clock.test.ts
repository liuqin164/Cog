/**
 * #235 shell-layer soak: a fake clock, not a wall clock. The memory soak asks whether the process
 * retains memory; this one asks whether *time* makes the resident do more work than the events that
 * arrived. Every scenario advances the clock in fixed ticks and asserts a hard ceiling on model
 * calls, ledger rows and the user lane:
 *
 *   idle              240 ticks with no event: zero model calls, zero ledger rows.
 *   one message       one submit, then 240 ticks: exactly one run, no later row.
 *   promise expiry    one promise, ticks to its due instant: one autonomous run, then silence.
 *   mixed             messages and a promise across idle gaps: calls <= messages + promises.
 *
 * The lane assertion is the #229 contract at the time dimension: autonomous content is booked with
 * `origin=emergence` and never as `role=user`. This suite runs in CI with the rest of `shell/test`.
 */
import { describe, expect, test } from 'bun:test';
import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
const TICK_MS = 30_000;
const TICKS_PER_SCENARIO = 240;

function makeSoakShell(dir: string, provider: ScriptedProvider, clock: { now: number }): CompanionShell {
  return makeShell(
    dir,
    provider,
    {
      // Keep the 2–5 dream window out of the fake day; the soak is about ticks, not the night.
      dream: { windowStartHour: 23, windowEndHour: 23, runKernelNight: false, maxEpisodes: 5 },
    },
    { now: () => clock.now },
  );
}

function ledger(shell: CompanionShell) {
  return shell.kernel.eventStore.queryEvents(1, 10_000, {
    projectId: [shell.config.projectId],
    order: 'asc',
  }).records;
}

function ledgerSize(shell: CompanionShell): number {
  return shell.kernel.eventStore.queryEvents(1, 1, { projectId: [shell.config.projectId] }).total;
}

function lanes(shell: CompanionShell) {
  const rows = ledger(shell);
  return {
    user: rows.filter((event) => event.role === 'user').length,
    assistant: rows.filter((event) => event.role === 'assistant').length,
    system: rows.filter((event) => event.role === 'system').length,
    autonomous: rows.filter((event) => (event.payload as { metadata?: { origin?: string } }).metadata?.origin === 'emergence').length,
  };
}

/** #229's contract at the time dimension: an autonomous run never books a user turn. */
function autonomousUserRows(shell: CompanionShell): number {
  return ledger(shell).filter((event) =>
    event.role === 'user'
    && (event.payload as { metadata?: { origin?: string } }).metadata?.origin === 'emergence').length;
}

async function advance(shell: CompanionShell, clock: { now: number }, ticks: number, step = TICK_MS): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    clock.now += step;
    await shell.tick(clock.now);
  }
}

describe('fake-clock soak (#235)', () => {
  test('idle: 240 ticks start no run and add no ledger row', async () => {
    const dir = makeTempDir('companion-soak-clock-');
    const clock = { now: T0 };
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeSoakShell(dir, provider, clock);
    await shell.start();
    try {
      const before = ledgerSize(shell);
      await advance(shell, clock, TICKS_PER_SCENARIO);
      const after = ledgerSize(shell);
      console.log(`[soak-clock] idle ledger ${before}->${after}, calls ${provider.calls.length}`);
      expect(provider.calls).toHaveLength(0);
      expect(after - before).toBe(0);
      expect(lanes(shell).user).toBe(0);
      expect(shell.machine.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('single user message: one run and one turn of rows, unchanged over 240 ticks', async () => {
    const dir = makeTempDir('companion-soak-clock-');
    const clock = { now: T0 };
    const provider = new ScriptedProvider([{ text: '好的。', toolCalls: [] }]);
    const shell = makeSoakShell(dir, provider, clock);
    await shell.start();
    try {
      const before = ledgerSize(shell);
      await shell.submit('今天在整理书架，先记下这一条。');
      const afterSubmit = ledgerSize(shell);
      console.log(`[soak-clock] one-message submit added ${afterSubmit - before} rows, calls ${provider.calls.length}`);
      await advance(shell, clock, TICKS_PER_SCENARIO);
      const after = ledgerSize(shell);
      console.log(`[soak-clock] one-message after ticks ${afterSubmit}->${after}, calls ${provider.calls.length}`);
      expect(provider.calls).toHaveLength(1);
      expect(afterSubmit - before).toBeLessThanOrEqual(2);
      expect(after).toBe(afterSubmit);
      expect(lanes(shell)).toMatchObject({ user: 1, assistant: 1, autonomous: 0 });
      expect(shell.machine.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('promise expiry: one autonomous run at the due instant, then no growth', async () => {
    const dir = makeTempDir('companion-soak-clock-');
    const clock = { now: T0 };
    const provider = new ScriptedProvider([{ text: '收到。', toolCalls: [] }, { text: '我来提醒你。', toolCalls: [] }]);
    const shell = makeSoakShell(dir, provider, clock);
    await shell.start();
    try {
      await shell.submit('我明天下午三点把文件发你。');
      const afterMessage = ledgerSize(shell);
      await advance(shell, clock, 1);
      const entry = shell.kernel.commitments
        .list({ projectId: shell.config.projectId, now: clock.now })
        .find((item) => item.content.includes('文件'));
      expect(entry?.dueAt).toBeDefined();
      const due = entry!.dueAt!;
      expect(due).toBeGreaterThan(clock.now);

      // Walk the fake clock to the due instant in half-hour ticks, then past it.
      while (clock.now < due) {
        clock.now = Math.min(clock.now + 30 * 60_000, due);
        await shell.tick(clock.now);
      }
      const afterDue = ledgerSize(shell);
      const callsAtDue = provider.calls.length;
      console.log(`[soak-clock] promise after-message ${afterMessage}, at due ${afterDue}, calls ${callsAtDue}`);
      expect(callsAtDue).toBe(2);

      await advance(shell, clock, TICKS_PER_SCENARIO);
      const after = ledgerSize(shell);
      console.log(`[soak-clock] promise after ticks ${afterDue}->${after}, calls ${provider.calls.length}`);
      expect(provider.calls).toHaveLength(2);
      expect(after).toBe(afterDue);
      // One promise: its opened + surfaced rows, the autonomous task, and the ingest's two projections.
      expect(afterDue - afterMessage).toBeLessThanOrEqual(6);
      expect(lanes(shell)).toMatchObject({ user: 1, assistant: 1, system: 1, autonomous: 1 });
      expect(autonomousUserRows(shell)).toBe(0);
      expect(shell.machine.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('mixed: idle gaps, two messages and one promise keep calls and rows bounded', async () => {
    const dir = makeTempDir('companion-soak-clock-');
    const clock = { now: T0 };
    const provider = new ScriptedProvider([
      { text: '第一条。', toolCalls: [] },
      { text: '第二条。', toolCalls: [] },
      { text: '提醒到了。', toolCalls: [] },
    ]);
    const shell = makeSoakShell(dir, provider, clock);
    await shell.start();
    try {
      await shell.submit('今天在整理书架，第一件事是给书编号。');
      await advance(shell, clock, 60);
      await shell.submit('我明天下午三点把文件发你。');
      await advance(shell, clock, 60);
      const entry = shell.kernel.commitments
        .list({ projectId: shell.config.projectId, now: clock.now })
        .find((item) => item.content.includes('文件'));
      expect(entry?.dueAt).toBeDefined();
      const due = entry!.dueAt!;
      while (clock.now < due) {
        clock.now = Math.min(clock.now + 30 * 60_000, due);
        await shell.tick(clock.now);
      }
      const afterDue = ledgerSize(shell);
      await advance(shell, clock, 60);
      const after = ledgerSize(shell);
      console.log(`[soak-clock] mixed calls ${provider.calls.length}, ledger ${afterDue}->${after}, lanes ${JSON.stringify(lanes(shell))}`);
      // Two user messages, one promise: the due promise is the only autonomous run allowed.
      expect(provider.calls).toHaveLength(3);
      expect(after).toBe(afterDue);
      expect(lanes(shell).user).toBe(2);
      expect(lanes(shell)).toMatchObject({ user: 2, assistant: 2, system: 1, autonomous: 1 });
      expect(autonomousUserRows(shell)).toBe(0);
      // Two turns (2 rows each) plus the promise's opened/surfaced/autonomous rows and projections.
      expect(ledgerSize(shell)).toBeLessThanOrEqual(10);
      expect(shell.machine.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  }, 60_000);
});

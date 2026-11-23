import { describe, expect, test } from 'bun:test';
import type { CageConfig } from '../src/plugins/cage.ts';
import { ScriptedProvider, makeShell, makeTempDir, seedOpenAssignment } from './helpers.ts';

const TIGHT: CageConfig = { maxTurnsPerRun: 5, maxTokensPerRun: 1_000, toolWhitelist: null };
const T0 = Date.UTC(2026, 0, 1, 12);

async function suspend(clock: { now: number }, provider: ScriptedProvider) {
  const shell = makeShell(makeTempDir('suspended-resident-'), provider, { budgets: TIGHT, workBudget: TIGHT }, { now: () => clock.now });
  await shell.start();
  seedOpenAssignment(shell, 'do the thing');
  await shell.submit('do the thing');
  expect(shell.state).toBe('SUSPENDED');
  return shell;
}

const provider = (): ScriptedProvider =>
  new ScriptedProvider([
    { text: 'working', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 1_500, output: 1 } },
  ]);

describe('a suspended resident keeps its background work (#437)', () => {
  test('health, backfill, Dream and a snapshot still run, and no new model run starts', async () => {
    const clock = { now: T0 };
    const scripted = provider();
    const shell = await suspend(clock, scripted);
    try {
      const callsBefore = scripted.calls.length;
      let healthChecks = 0;
      let snapshots = 0;
      let backfills = 0;
      let dreams = 0;
      const health = shell.kernel.health as unknown as { check: () => unknown };
      health.check = () => {
        healthChecks += 1;
      };
      const backup = shell.kernel.backup as unknown as { snapshot: () => Promise<unknown> };
      backup.snapshot = async () => {
        snapshots += 1;
        return undefined;
      };
      const kernel = shell.kernel as unknown as {
        backfillEventEmbeddingBatch: () => Promise<unknown>;
        bindRawEvents: () => unknown;
      };
      kernel.backfillEventEmbeddingBatch = async () => {
        backfills += 1;
        return { completed: 0, failed: 0, hasMore: false, nextRowId: 0 };
      };
      kernel.bindRawEvents = () => ({ boundEvents: 0, bindableEvents: 0, hasMore: false });
      const dream = (shell as unknown as { dream: { integrate: () => Promise<unknown> } }).dream;
      dream.integrate = async () => {
        dreams += 1;
        return { localDate: '2026-01-01', eventCount: 0, sourceRefs: [], summary: '', kernelNightRan: false, memoryModelUsed: false };
      };
      (shell.residentTick as unknown as { dreamDecision: () => unknown }).dreamDecision = () => ({
        start: true,
        reason: 'idle_and_backlog',
        night: false,
        idleMs: null,
        idleMinMs: 0,
        backlogMin: 0,
        backlogEvents: 0,
        backlogEpisodes: 0,
      });

      clock.now += 1_000;
      await shell.tick(clock.now);

      expect(healthChecks).toBeGreaterThan(0);
      expect(backfills).toBe(1);
      expect(dreams).toBe(1);
      expect(snapshots).toBe(1);
      expect(shell.machine.runtime.lastSnapshotAt).toBe(clock.now);
      expect(shell.trace.read().some((record) => record.kind === 'dream_complete')).toBe(true);
      expect(shell.state).toBe('SUSPENDED');
      expect(shell.machine.runtime.suspension).toBeDefined();
      expect(scripted.calls.length).toBe(callsBefore);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a due wake intent waits in the away queue instead of dispatching from SUSPENDED', async () => {
    const clock = { now: T0 };
    const shell = await suspend(clock, provider());
    try {
      (shell.residentTick as unknown as { dreamDecision: () => unknown }).dreamDecision = () => ({
        start: false,
        reason: 'backlog_low',
        night: false,
        idleMs: null,
        idleMinMs: 0,
        backlogMin: 1,
        backlogEvents: 0,
        backlogEpisodes: 0,
      });
      const intent = shell.machine.addWakeIntent({ at: clock.now, reason: 'idle_checkin' });
      clock.now += 1;
      await shell.tick(clock.now);

      expect(shell.machine.wakeIntents.find((entry) => entry.id === intent.id)?.consumedAt).toBeDefined();
      const deferred = shell.machine.runtime.awayQueue?.find((entry) => entry.id === `wake:${intent.id}`);
      expect(deferred?.reason).toBe('wake_intent:idle_checkin');
      expect(shell.trace.read().some((record) => record.kind === 'wake_intent_deferred')).toBe(true);
      expect(shell.state).toBe('SUSPENDED');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a reply waits for the in-place dream pass that is already running', async () => {
    const clock = { now: T0 };
    const scripted = new ScriptedProvider([
      { text: 'working', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 1_500, output: 1 } },
      { text: '答', toolCalls: [] },
    ]);
    const shell = await suspend(clock, scripted);
    try {
      let dreamed = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const startedDream = new Promise<void>((resolve) => { started = resolve; });
      const dream = (shell as unknown as { dream: { integrate: (localDate: string) => Promise<unknown> } }).dream;
      dream.integrate = async (localDate: string) => {
        started();
        await gate;
        dreamed = true;
        return { localDate, eventCount: 0, sourceRefs: [], summary: 'gated', kernelNightRan: false, memoryModelUsed: false };
      };
      const backup = shell.kernel.backup as unknown as { snapshot: () => Promise<unknown> };
      backup.snapshot = async () => undefined;
      (shell.residentTick as unknown as { dreamDecision: () => unknown }).dreamDecision = () => ({
        start: true,
        reason: 'idle_and_backlog',
        night: false,
        idleMs: null,
        idleMinMs: 0,
        backlogMin: 0,
        backlogEvents: 0,
        backlogEpisodes: 0,
      });

      clock.now += 1_000;
      const tick = shell.tick(clock.now);
      await startedDream;
      const callsBefore = scripted.calls.length;
      const submitted = shell.submit('回答');
      await Bun.sleep(20);
      expect(dreamed).toBe(false);
      expect(shell.state).toBe('SUSPENDED');
      expect(scripted.calls.length).toBe(callsBefore);

      release();
      await tick;
      const summary = await submitted;
      expect(summary?.stopReason).toBe('run_complete');
      expect(dreamed).toBe(true);
      expect(scripted.calls.length).toBe(callsBefore + 1);
      expect(shell.trace.read().some((record) => record.kind === 'dream_complete')).toBe(true);
      expect(shell.trace.read().some((record) => record.kind === 'illegal_transition')).toBe(false);
      expect(shell.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

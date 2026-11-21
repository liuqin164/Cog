import { describe, expect, test } from 'bun:test';
import type { CompanionShell } from '../src/app.ts';
import type { ClockService } from '../src/plugins/clock.ts';
import type { RunSummary } from '../src/state/agent-loop.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 2, windowEndHour: 5 };
const DAY_MINUTE = 60_000;
const HOUR = 60 * DAY_MINUTE;

function at(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!, hour, minute);
}

async function seed(shell: CompanionShell, date: string, when: number, tag: string): Promise<void> {
  await shell.backend.rememberTurnWithResult({
    agentId: shell.config.agentId,
    projectId: shell.config.projectId,
    sessionId: shell.config.sessionId,
    threadId: `companion-day:${date}`,
    turnId: `dream-trigger-${date}-${tag}-${when}`,
    userText: `${date} ${tag}`,
    assistantText: '记下了。',
    timestamp: when,
    ingestMode: 'raw_archive_only',
  });
}

function coveredEventIds(shell: CompanionShell, date: string): Set<string> {
  const projectId = shell.config.projectId;
  const covered = new Set<string>();
  for (const product of shell.kernel.getThreadEvents(`companion-dream:${date}`, { projectId, limit: 50 })) {
    const ids = (product.payload as { metadata?: { sourceEventIds?: unknown } } | undefined)?.metadata?.sourceEventIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') covered.add(id);
  }
  return covered;
}

function uncurated(shell: CompanionShell, date: string): number {
  const covered = coveredEventIds(shell, date);
  return shell.kernel
    .getThreadEvents(`companion-day:${date}`, { projectId: shell.config.projectId, limit: 5_000 })
    .filter((event) => !covered.has(event.eventId)).length;
}

function dreams(shell: CompanionShell): Array<{ localDate: string }> {
  return shell.trace.read().filter((record) => record.kind === 'dream_complete') as unknown as Array<{ localDate: string }>;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

describe('dream trigger: idle + backlog + night weight (#379)', () => {
  test('a 03:00 conversation does not starve the night, and the next night clears it', async () => {
    const clock = { now: at('2026-03-02', 9) };
    const shell = makeShell(makeTempDir('dream-trigger-night-'), new ScriptedProvider([{ text: '在。', toolCalls: [] }]), { dream: DREAM }, { now: () => clock.now });
    await shell.start();
    try {
      const clockService = shell.host.getService<ClockService>('clock');
      await seed(shell, '2026-03-02', at('2026-03-02', 10), 'a');
      await seed(shell, '2026-03-02', at('2026-03-02', 10, 4), 'b');
      clockService.markInteraction(at('2026-03-02', 10, 4));

      clock.now = at('2026-03-03', 3);
      clockService.markInteraction(clock.now);
      clock.now = at('2026-03-03', 3, 1);
      await shell.tick(clock.now);
      expect(dreams(shell)).toHaveLength(0);
      const delayed = shell.trace.read().find((record) => record.kind === 'dream_trigger' && record.at === clock.now)!;
      expect(delayed.reason).toBe('idle_short');
      expect(delayed.night).toBe(true);

      clock.now = at('2026-03-03', 3, 6);
      await shell.tick(clock.now);
      expect(dreams(shell).map((dream) => dream.localDate)).toEqual(['2026-03-02']);
      expect(uncurated(shell, '2026-03-02')).toBe(0);
      const started = shell.trace.read().find((record) => record.kind === 'dream_trigger' && record.at === clock.now)!;
      expect(started.decision).toBe('start');
      expect(started.night).toBe(true);
      expect(started.idleMs).toBe(6 * DAY_MINUTE);
      expect(started.backlogEvents).toBe(4);

      clock.now = at('2026-03-03', 3, 7);
      await shell.tick(clock.now);
      expect(dreams(shell)).toHaveLength(1);
      const skipped = shell.trace.read().find((record) => record.kind === 'dream_trigger' && record.at === clock.now)!;
      expect(skipped.reason).toBe('already_dreamed');
      expect(shell.kernel.getEpisodeDreamStatus(shell.config.projectId).pending).toBe(0);
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('a user turn during a triggered daytime dream returns before the dream finishes', async () => {
    const clock = { now: at('2026-03-10', 12) };
    const shell = makeShell(makeTempDir('dream-trigger-yield-'), new ScriptedProvider([{ text: '白天我在。', toolCalls: [] }]), { dream: DREAM }, { now: () => clock.now });
    await shell.start();
    try {
      const clockService = shell.host.getService<ClockService>('clock');
      await seed(shell, '2026-03-09', at('2026-03-09', 10), 'a');
      await seed(shell, '2026-03-09', at('2026-03-09', 10, 4), 'b');
      clockService.markInteraction(at('2026-03-10', 10));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const startedDream = new Promise<void>((resolve) => { started = resolve; });
      (shell as unknown as { dream: { integrate: (localDate: string) => Promise<unknown> } }).dream = {
        integrate: async (localDate: string) => {
          started();
          await gate;
          return { localDate, eventCount: 0, sourceRefs: [], summary: 'gated', kernelNightRan: false };
        },
      };

      const tick = shell.tick(clock.now);
      await startedDream;
      expect(shell.state).toBe('DREAMING');

      const summary = await within<RunSummary | undefined>(shell.submit('白天找我'), 5_000);
      expect(summary?.stopReason).toBe('run_complete');
      expect(shell.trace.read().some((record) => record.kind === 'illegal_transition')).toBe(false);

      release();
      await tick;
      expect(shell.state).toBe('IDLE');
      expect(shell.trace.read().some((record) => record.kind === 'dream_finished_after_wake')).toBe(true);
      const started1 = shell.trace.read().find((record) => record.kind === 'dream_trigger' && record.decision === 'start')!;
      expect(started1.night).toBe(false);
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('a whole night without a word dreams at the old 02:00 boundary', async () => {
    const clock = { now: at('2026-03-05', 23) };
    const shell = makeShell(makeTempDir('dream-trigger-quiet-'), new ScriptedProvider([{ text: '在。', toolCalls: [] }]), { dream: DREAM }, { now: () => clock.now });
    await shell.start();
    try {
      const clockService = shell.host.getService<ClockService>('clock');
      await seed(shell, '2026-03-05', at('2026-03-05', 10), 'a');
      await seed(shell, '2026-03-05', at('2026-03-05', 10, 4), 'b');
      clockService.markInteraction(at('2026-03-05', 23));

      clock.now = at('2026-03-06', 1, 59);
      await shell.tick(clock.now);
      expect(dreams(shell)).toHaveLength(0);

      clock.now = at('2026-03-06', 2);
      await shell.tick(clock.now);
      expect(dreams(shell).map((dream) => dream.localDate)).toEqual(['2026-03-05']);
      expect(uncurated(shell, '2026-03-05')).toBe(0);
      const boundary = shell.trace.read().find((record) => record.kind === 'dream_trigger' && record.at === clock.now)!;
      expect(boundary.decision).toBe('start');
      expect(boundary.night).toBe(true);
      expect(boundary.backlogEvents).toBe(4);
      expect(boundary.idleMs).toBe(3 * HOUR);
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('one simulated week across three night types never accumulates the dream backlog', async () => {
    const clock = { now: at('2026-03-02', 9) };
    const shell = makeShell(makeTempDir('dream-trigger-week-'), new ScriptedProvider([{ text: '在。', toolCalls: [] }]), { dream: DREAM }, { now: () => clock.now });
    await shell.start();
    try {
      const clockService = shell.host.getService<ClockService>('clock');
      const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'];
      const types = ['night-owl', 'quiet', 'scattered', 'night-owl', 'quiet', 'scattered', 'quiet'];
      const samples: number[] = [];

      for (const [index, day] of days.entries()) {
        const next = days[index + 1] ?? '2026-03-09';
        for (const [minute, tag] of [[0, 'a'], [4, 'b']] as const) {
          clock.now = at(day, 10, minute);
          await seed(shell, day, clock.now, tag);
        }
        if (types[index] === 'scattered') {
          for (const [minute, tag] of [[8, 'c'], [12, 'd']] as const) {
            clock.now = at(day, 10, minute);
            await seed(shell, day, clock.now, tag);
          }
        }
        clock.now = at(day, 16);
        clockService.markInteraction(clock.now);

        if (types[index] === 'night-owl') {
          clock.now = at(next, 3);
          clockService.markInteraction(clock.now);
          clock.now = at(next, 3, 1);
          await shell.tick(clock.now);
          expect(dreams(shell).map((dream) => dream.localDate)).not.toContain(day);
          clock.now = at(next, 3, 6);
        } else {
          clock.now = types[index] === 'scattered' ? at(next, 6, 30) : at(next, 2, 5);
        }
        samples.push(uncurated(shell, day));
        await shell.tick(clock.now);
        expect(dreams(shell).map((dream) => dream.localDate)).toContain(day);
        expect(uncurated(shell, day)).toBe(0);
      }

      expect(dreams(shell).map((dream) => dream.localDate)).toEqual(days);
      expect(days.reduce((total, day) => total + uncurated(shell, day), 0)).toBe(0);
      expect(shell.kernel.getEpisodeDreamStatus(shell.config.projectId).pending).toBe(0);
      expect(samples).toEqual([4, 4, 8, 4, 4, 8, 4]);
      expect(Math.max(...samples)).toBeLessThanOrEqual(8);

      const triggers = shell.trace.read().filter((record) => record.kind === 'dream_trigger');
      expect(triggers.some((record) => record.night === true && record.decision === 'start')).toBe(true);
      expect(triggers.some((record) => record.night === false && record.decision === 'start')).toBe(true);
      expect(triggers.filter((record) => record.night === true && record.reason === 'idle_short')).toHaveLength(2);
      for (const trigger of triggers) {
        expect(['start', 'skip']).toContain(trigger.decision as string);
        expect(typeof trigger.backlogEvents).toBe('number');
        expect(typeof trigger.backlogEpisodes).toBe('number');
        expect(typeof trigger.idleMinMs).toBe('number');
        expect(typeof trigger.backlogMin).toBe('number');
        expect(trigger.idleMs === null || typeof trigger.idleMs === 'number').toBe(true);
      }
    } finally {
      await shell.stop();
    }
  }, 120_000);
});

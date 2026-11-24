import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOON = Date.UTC(2026, 10, 20, 12, 0, 0);
const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 2, windowEndHour: 4 };

function stubReadings(shell: ReturnType<typeof makeShell>, input: { episodes?: number; dreamBacklog?: number; expiring72h?: number; oldestAt?: number } = {}): void {
  (shell.kernel as any).getEpisodeDreamStatus = () => ({
    pending: input.episodes ?? 0,
    retryScheduled: 0,
    failedRetryable: 0,
    processing: 0,
    failed: 0,
  });
  (shell.kernel as any).getBacklogReadings = (_projectId?: string, now = NOON) => ({
    measuredAt: now,
    unboundEvents: 0,
    dreamBacklog: input.dreamBacklog ?? 0,
    aliasConflicts: 0,
    candidateQueue: {
      candidate: 0,
      needsConfirmation: 0,
      promoted: 0,
      rejected: 0,
      superseded: 0,
      shadow: 0,
      oldestCandidateAt: null,
      oldestCandidateAgeMs: null,
      needsConfirmationExpiringSoon: 0,
      needsConfirmationExpiring72h: input.expiring72h ?? 0,
      needsConfirmationOverdue: 0,
      highPrivilege: {
        needsConfirmation: 0,
        needsConfirmationExpiringSoon: 0,
        needsConfirmationOverdue: 0,
      },
    },
  });
  (shell.kernel as any).getEmbeddingBacklog = () => ({
    count: input.oldestAt === undefined ? 0 : 1,
    ...(input.oldestAt === undefined ? {} : { oldestAt: input.oldestAt }),
  });
}

function degraded(shell: ReturnType<typeof makeShell>, at: number, reason = 'semantic_processor_failed'): void {
  shell.machine.updateRuntime({
    memoryModel: { state: reason === 'semantic_processor_budget' ? 'degraded' : 'unreachable', reason, since: at - DAY, pendingBackfill: true },
  });
}

describe('self_care surfacing (#532)', () => {
  test('a degraded night speaks once with its reason and pending episode count, then reports the drain', async () => {
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => NOON });
    await shell.start();
    try {
      stubReadings(shell, { episodes: 6 });
      degraded(shell, NOON);
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));

      await shell.tick(NOON);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: 'self_care', strength: 'proactive' });
      expect(events[0].text).toContain('昨晚记忆模型没连上（网络）');
      expect(events[0].text).toContain('6 段对话等恢复后补上');
      expect(shell.machine.runtime.emergence).toBeUndefined();

      await shell.tick(NOON + 60_000);
      expect(events).toHaveLength(1);

      const next = NOON + DAY;
      shell.machine.updateRuntime({ memoryModel: { state: 'reachable', since: NOON, pendingBackfill: false } });
      await shell.tick(next);
      expect(events).toHaveLength(2);
      expect(events[1].text).toContain('已补完 6 段');
      expect(shell.machine.runtime.selfCare?.pendingEpisodes).toBeUndefined();
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('budget exhaustion has its own wording and measured numbers', async () => {
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => NOON });
    await shell.start();
    try {
      stubReadings(shell, { episodes: 4 });
      degraded(shell, NOON, 'semantic_processor_budget');
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(NOON);
      expect(events).toHaveLength(1);
      expect(events[0].text).toContain('昨晚整理额度用完了（200k/200k）');
      expect(events[0].text).not.toContain('没连上');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('expiring confirmations link to the classification audit and combine with other conditions', async () => {
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM, http: { enabled: true, port: 0, hostname: '127.0.0.1' } }, { now: () => NOON });
    await shell.start();
    try {
      stubReadings(shell, { episodes: 3, expiring72h: 2 });
      degraded(shell, NOON);
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(NOON);
      expect(events).toHaveLength(1);
      expect(events[0].text).toContain('3 段对话等恢复后补上');
      expect(events[0].text).toContain('有 2 条待确认记忆 72 小时内过期');
      expect(events[0].text).toContain('/observatory/#classification');
      expect(events[0].text.split('；')).toHaveLength(2);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a repeated condition waits seven days unless it worsens, and the daily line is one', async () => {
    let now = NOON;
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      stubReadings(shell, { episodes: 6 });
      degraded(shell, NOON);
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(now);
      expect(events).toHaveLength(1);

      now += DAY;
      stubReadings(shell, { episodes: 6 });
      await shell.tick(now);
      expect(events).toHaveLength(1);

      now += 2 * DAY;
      stubReadings(shell, { episodes: 9 });
      await shell.tick(now);
      expect(events).toHaveLength(2);
      expect(events[1].text).toContain('9 段对话等恢复后补上');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a second condition on the same day is held, and a self_care line does not spend the promise quota', async () => {
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => NOON });
    await shell.start();
    try {
      stubReadings(shell, { episodes: 2 });
      degraded(shell, NOON);
      shell.machine.updateRuntime({ emergence: { day: shell.statusFace.localDay(NOON), count: 3, consumed: [] } });
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(NOON);
      expect(events).toHaveLength(1);
      expect(shell.machine.runtime.emergence).toMatchObject({ count: 3 });

      shell.machine.updateRuntime({ memoryModel: { state: 'reachable', since: NOON, pendingBackfill: false }, snapshotRetry: { attempts: 2, nextAt: NOON + DAY } });
      await shell.tick(NOON + 60_000);
      expect(events).toHaveLength(1);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('snapshot failure, flat backlog and an old unembedded event each surface once', async () => {
    let now = NOON;
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      stubReadings(shell, { dreamBacklog: 5 });
      shell.machine.updateRuntime({ snapshotRetry: { attempts: 2, nextAt: NOON + HOUR } });
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(now);
      expect(events).toHaveLength(1);
      expect(events[0].text).toContain('快照连续失败 2 次');

      now += DAY;
      shell.machine.updateRuntime({ snapshotRetry: undefined });
      stubReadings(shell, { dreamBacklog: 5, oldestAt: now - 25 * HOUR });
      await shell.tick(now);
      expect(events).toHaveLength(2);
      expect(events[1].text).toContain('最老未嵌入事件已积压 25 小时');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a flat compile backlog over two nights is a condition', async () => {
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => NOON });
    await shell.start();
    try {
      stubReadings(shell, { dreamBacklog: 5 });
      shell.machine.updateRuntime({
        selfCare: {
          backlogSamples: [
            { day: '2026-11-18', count: 3 },
            { day: '2026-11-19', count: 4 },
            { day: '2026-11-20', count: 5 },
          ],
        },
      });
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(NOON);
      expect(events).toHaveLength(1);
      expect(events[0].text).toContain('待编译量连续 2 晚没降（5 段）');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the quiet window queues self_care and delivers it on the first tick after the window', async () => {
    const quietAt = Date.UTC(2026, 10, 15, 23, 30, 0);
    const afterQuiet = Date.UTC(2026, 10, 16, 7, 30, 0);
    let now = quietAt;
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM, quiet: { startHour: 23, endHour: 7 } }, { now: () => now });
    await shell.start();
    try {
      stubReadings(shell, { episodes: 6 });
      degraded(shell, quietAt);
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(quietAt);
      expect(events).toHaveLength(0);
      expect(shell.machine.runtime.awayQueue).toHaveLength(1);
      expect(shell.machine.runtime.awayQueue?.[0]).toMatchObject({ id: 'self_care', source: 'self_care', deferred: 'quiet' });

      now = afterQuiet;
      await shell.tick(afterQuiet);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: 'self_care', strength: 'incidental' });
      expect(shell.machine.runtime.awayQueue).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a rule-only install shows the condition on /status and never speaks it', async () => {
    const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => NOON });
    await shell.start();
    try {
      stubReadings(shell, { episodes: 6 });
      degraded(shell, NOON);
      (shell.statusFace as any).memoryModelHealth = () => ({ state: 'rule_only', route: 'default', model: 'rule_only', baseUrl: '', line: '记忆模型：规则', pendingBackfill: true, since: NOON, backlogEpisodes: 6 });
      const events: any[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      await shell.tick(NOON);
      expect(events).toHaveLength(0);
      const status = await shell.runCommand('status', '');
      expect(status.text).toContain('自我照料：');
      expect(status.text).toContain('6 段对话等恢复后补上');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

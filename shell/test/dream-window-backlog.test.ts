import { describe, expect, test } from 'bun:test';
import type { CompanionShell } from '../src/app.ts';
import type { ClockService } from '../src/plugins/clock.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const MINUTE = 60_000;
const VECTOR = new Float32Array([1, 0]);

function embedder() {
  return {
    dimensions: VECTOR.length,
    modelId: 'test-embedding',
    embedBatch: async (texts: string[]) => texts.map(() => VECTOR),
    embed: async () => VECTOR,
    embedSync: () => VECTOR,
  };
}

function at(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!, hour, minute);
}

function products(shell: CompanionShell, date: string): number {
  return shell.kernel
    .getThreadEvents(`companion-dream:${date}`, { projectId: shell.config.projectId, limit: 50 })
    .filter((event) => (event.payload as { metadata?: { kind?: string } }).metadata?.kind === 'dream-integration')
    .length;
}

async function seedDay(shell: CompanionShell, date: string, when: number): Promise<void> {
  await shell.backend.rememberTurnWithResult({
    agentId: shell.config.agentId,
    projectId: shell.config.projectId,
    sessionId: shell.config.sessionId,
    threadId: `companion-day:${date}`,
    turnId: `dream-window-${date}-${when}`,
    userText: '昨天整理书架，把工具书放到第二层。',
    assistantText: '记下了：工具书在第二层。',
    timestamp: when,
    ingestMode: 'raw_archive_only',
  });
}

function seedEpisode(shell: CompanionShell, date: string, index: number, when: number): void {
  const sessionId = `session-backlog-${index}`;
  const event = shell.kernel.eventStore.append({
    eventId: `evt-backlog-${index}`,
    streamId: sessionId,
    streamType: 'thread',
    eventType: 'RAW_EVENT_RECORDED',
    rawEventType: 'message',
    projectId: shell.config.projectId,
    sessionId,
    threadId: `companion-day:${date}`,
    role: 'user',
    occurredAt: when,
    localDate: date,
    payload: { text: `第 ${index} 条：部署负责人是青栎组。` },
  });
  shell.kernel.appendRawEventToEpisode(event, {
    projectId: shell.config.projectId,
    sessionId,
    sourceAgent: shell.config.agentId,
    now: when,
  });
}

describe('dream window and backlog (#455)', () => {
  test('a 23:30 cross-midnight run folds that day and a rerun reuses its product', async () => {
    const clock = { now: at('2026-03-10', 23, 30) };
    const shell = makeShell(
      makeTempDir('dream-midnight-day-'),
      new ScriptedProvider([{ text: '在。', toolCalls: [] }]),
      { dream: { runKernelNight: false, maxEpisodes: 5, windowStartHour: 23, windowEndHour: 6 } },
      { now: () => clock.now },
    );
    await shell.start();
    try {
      const clockService = shell.host.getService<ClockService>('clock');
      expect(clockService.dreamTargetDate(clock.now)).toBe('2026-03-10');
      await seedDay(shell, '2026-03-10', at('2026-03-10', 22));

      await shell.runDream(clock.now);
      expect(shell.machine.runtime.lastDreamDate).toBe('2026-03-10');
      expect(products(shell, '2026-03-10')).toBe(1);

      shell.machine.updateRuntime({ lastDreamDate: undefined });
      clock.now += MINUTE;
      await shell.runDream(clock.now);
      expect(shell.machine.runtime.lastDreamDate).toBe('2026-03-10');
      expect(products(shell, '2026-03-10')).toBe(1);

      clock.now = at('2026-03-11', 2);
      expect(clockService.dreamTargetDate(clock.now)).toBe('2026-03-10');
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('25 of 26 episodes do not mark the night dreamed; the rest drain on the next idle tick', async () => {
    const clock = { now: at('2026-06-05', 12) };
    const shell = makeShell(
      makeTempDir('dream-backlog-continue-'),
      new ScriptedProvider([{ text: '在。', toolCalls: [] }]),
      {
        model: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test', timeoutMs: 1_000 },
        dream: { runKernelNight: true, maxEpisodes: 25, windowStartHour: 0, windowEndHour: 24 },
      },
      { now: () => clock.now, embeddingProvider: embedder() },
    );
    await shell.start();
    try {
      const clockService = shell.host.getService<ClockService>('clock');
      const target = clockService.dreamTargetDate(clock.now);
      const seededAt = at(target, 20);
      for (let index = 0; index < 26; index += 1) seedEpisode(shell, target, index, seededAt + index);
      clockService.markInteraction(clock.now - 10 * MINUTE);

      await shell.tick(clock.now);
      expect(shell.machine.runtime.lastDreamDate).toBeUndefined();
      expect(shell.trace.read().filter((record) => record.kind === 'dream_backlog_remaining')).toHaveLength(1);
      expect(products(shell, target)).toBe(1);

      clock.now += 6 * MINUTE;
      await shell.tick(clock.now);
      expect(shell.machine.runtime.lastDreamDate).toBe(target);
      expect(shell.kernel.getEpisodeDreamStatus(shell.config.projectId)).toMatchObject({ pending: 0, retryScheduled: 0, failedRetryable: 0 });
      expect(shell.trace.read().filter((record) => record.kind === 'dream_complete')).toHaveLength(2);
      expect(products(shell, target)).toBe(1);
    } finally {
      await shell.stop();
    }
  }, 120_000);
});

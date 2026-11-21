import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const BASE = Date.UTC(2026, 10, 15, 12, 0, 0);
const NO_DREAM = { windowStartHour: 0, windowEndHour: 1, runKernelNight: false, maxEpisodes: 5 };

describe('the surfacing loop closes in the shell (#330)', () => {
  test('a kernel wake intention set through /wake fires at its instant', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '到点了。', toolCalls: [] }]);
    let now = BASE;
    const shell = makeShell(dir, provider, { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      const events: unknown[] = [];
      shell.host.bus.on('companion_emergence', (event: unknown) => events.push(event));
      const reply = await shell.runCommand('wake', '1 看看烤箱');
      expect(reply.receipt).toBe(true);

      await shell.tick(BASE + 30_000);
      expect(events).toHaveLength(0);

      now = BASE + 60_000;
      await shell.tick(now);
      expect(events).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
      expect(shell.trace.read().some((record) => record.kind === 'wake_intention_registered')).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('three ignored surfaces raise the source level and the next one is withheld', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: '一', toolCalls: [] },
      { text: '二', toolCalls: [] },
      { text: '三', toolCalls: [] },
    ]);
    let now = BASE;
    const shell = makeShell(dir, provider, { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      for (let index = 1; index <= 3; index += 1) {
        await shell.runCommand('wake', `1 thought ${index}`);
        now += 60_000;
        await shell.tick(now);
        now += 24 * 60 * 60_000;
        shell.clock!.markInteraction(now);
        await shell.tick(now);
      }
      await shell.runCommand('wake', '1 thought 4');
      now += 60_000;
      await shell.tick(now);
      await shell.runCommand('wake', '1 thought 5');
      now += 60_000;
      await shell.tick(now);
      expect(provider.calls).toHaveLength(3);

      const state = shell.backend.surfacingFeedbackState({ projectId: shell.config.projectId, now });
      const wake = state.types.find((entry) => entry.type === 'wake-intention')!;
      expect(wake.consecutiveIgnored).toBe(3);
      expect(wake.level).toBe(1);
      expect(wake.cooldownUntil).not.toBeNull();
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the owner stopping a source is visible in the panel and stops it', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '好。', toolCalls: [] }]);
    let now = BASE;
    const shell = makeShell(dir, provider, { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      await shell.runCommand('wake', '1 report');
      now = BASE + 60_000;
      await shell.tick(now);

      const panel = await shell.runCommand('surfacing', '');
      expect(panel.text).toContain('wake-intention');

      const stopped = await shell.runCommand('surfacing', 'stop wake-intention');
      expect(stopped.receipt).toBe(true);
      const state = shell.backend.surfacingFeedbackState({ projectId: shell.config.projectId, now });
      expect(state.stoppedTypes).toContain('wake-intention');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('/snooze moves a surfaced commitment to its resume instant', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: '提醒你。', toolCalls: [] },
      { text: '再提醒一次。', toolCalls: [] },
    ]);
    let now = BASE;
    const shell = makeShell(dir, provider, { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'snooze-seed',
        userText: '我明天把面包店地址发你',
        assistantText: '记下了。',
        timestamp: BASE,
        ingestMode: 'immediate_compile',
      });
      shell.kernel.commitments.compile({ projectId: shell.config.projectId, now: BASE + 1_000 });
      const due = shell.kernel.commitments.list({ projectId: shell.config.projectId, now: BASE + 1_000 })[0]!.dueAt!;

      now = due;
      await shell.tick(due);
      expect(provider.calls).toHaveLength(1);

      const snoozed = await shell.runCommand('snooze', '30');
      expect(snoozed.receipt).toBe(true);
      const commitment = shell.backend.surfacingFeedbackState({ projectId: shell.config.projectId, now })
        .types.find((entry) => entry.type === 'commitment')!;
      expect(commitment.ignoredCount).toBe(0);
      expect(shell.backend.surfacingPending({ projectId: shell.config.projectId })).toHaveLength(0);
      expect(shell.kernel.surfacingFeedback.audit({ projectId: shell.config.projectId }).at(-1)?.outcome).toBe('snoozed');

      now = due + 60_000;
      await shell.tick(now);
      expect(provider.calls).toHaveLength(1);

      now = due + 31 * 60_000;
      await shell.tick(now);
      expect(provider.calls).toHaveLength(2);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a reply naming the surfaced content is engaged', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '到点了。', toolCalls: [] }, { text: '好。', toolCalls: [] }]);
    let now = BASE;
    const shell = makeShell(dir, provider, { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      await shell.runCommand('wake', '1 看看烤箱');
      now += 60_000;
      await shell.tick(now);
      expect(shell.backend.surfacingPending({ projectId: shell.config.projectId })).toHaveLength(1);

      now += 60_000;
      await shell.submit('烤箱我看过了。');

      const wake = shell.backend.surfacingFeedbackState({ projectId: shell.config.projectId, now })
        .types.find((entry) => entry.type === 'wake-intention')!;
      expect(wake.engagedCount).toBe(1);
      expect(wake.consecutiveIgnored).toBe(0);
      expect(shell.backend.surfacingPending({ projectId: shell.config.projectId })).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an unrelated message followed by a day without a targeted reply is ignored', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '到点了。', toolCalls: [] }, { text: '天气不错。', toolCalls: [] }]);
    let now = BASE;
    const shell = makeShell(dir, provider, { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      await shell.runCommand('wake', '1 看看烤箱');
      now += 60_000;
      await shell.tick(now);

      now += 60_000;
      await shell.submit('今天天气不错。');
      let wake = shell.backend.surfacingFeedbackState({ projectId: shell.config.projectId, now })
        .types.find((entry) => entry.type === 'wake-intention')!;
      expect(wake.engagedCount).toBe(0);
      expect(wake.ignoredCount).toBe(0);

      now += 24 * 60 * 60_000;
      await shell.tick(now);
      wake = shell.backend.surfacingFeedbackState({ projectId: shell.config.projectId, now })
        .types.find((entry) => entry.type === 'wake-intention')!;
      expect(wake.ignoredCount).toBe(1);
      expect(wake.consecutiveIgnored).toBe(1);
      expect(shell.backend.surfacingPending({ projectId: shell.config.projectId })).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('unrelated chat does not reset an existing ignore streak', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '到点了。', toolCalls: [] }, { text: '天气不错。', toolCalls: [] }]);
    let now = BASE;
    const shell = makeShell(dir, provider, { dream: NO_DREAM }, { now: () => now });
    await shell.start();
    try {
      for (const id of ['seed-a', 'seed-b']) {
        shell.backend.recordSurfacingFeedback({
          projectId: shell.config.projectId,
          candidateId: `surfacing:wake-intention:${id}`,
          outcome: 'ignored',
          now,
        });
      }
      await shell.runCommand('wake', '1 看看烤箱');
      now += 60_000;
      await shell.tick(now);
      now += 60_000;
      await shell.submit('今天天气不错。');

      const wake = shell.backend.surfacingFeedbackState({ projectId: shell.config.projectId, now })
        .types.find((entry) => entry.type === 'wake-intention')!;
      expect(wake.consecutiveIgnored).toBe(2);
      expect(wake.engagedCount).toBe(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a pending surface survives a process restart and is still judged', async () => {
    const dir = makeTempDir();
    let now = BASE;
    const first = makeShell(dir, new ScriptedProvider([{ text: '到点了。', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => now });
    await first.start();
    try {
      await first.runCommand('wake', '1 看看烤箱');
      now += 60_000;
      await first.tick(now);
      expect(first.backend.surfacingPending({ projectId: first.config.projectId })).toHaveLength(1);
    } finally {
      await first.stop();
    }

    const second = makeShell(dir, new ScriptedProvider([{ text: '好。', toolCalls: [] }]), { dream: NO_DREAM }, { now: () => now });
    await second.start();
    try {
      expect(second.backend.surfacingPending({ projectId: second.config.projectId })).toHaveLength(1);
      now += 60_000;
      await second.submit('烤箱我看过了。');
      const audit = second.kernel.surfacingFeedback.audit({ projectId: second.config.projectId });
      expect(audit.at(-1)?.outcome).toBe('engaged');
      expect(second.backend.surfacingPending({ projectId: second.config.projectId })).toHaveLength(0);
    } finally {
      await second.stop();
    }
  }, 30_000);
});

import { describe, expect, test } from 'bun:test';
import { KernelAgentMemoryBackend } from 'cogmem';
import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

/**
 * The F13 register (#167) replayed through the resident's own tick (#230). The kernel suite runs
 * each scenario against the public faces; this one drives the same seed through the shell so the
 * emergence gate is exercised where it actually fires. The 9 surface/withhold scenarios are the
 * gate's real path; the 8 record/correct ones are replayed to show the tick leaves their books
 * alone, not to re-test the kernel.
 */
const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const COOLDOWN = 31 * MINUTE;

function makeReplayShell(dir: string, provider: ScriptedProvider, now = T0) {
  return makeShell(dir, provider, {}, { now: () => now });
}

function turn(
  shell: CompanionShell,
  content: string,
  threadId: string,
  role: 'user' | 'assistant' = 'user',
  occurredAt = T0,
) {
  return shell.kernel.recordRawEvent({
    projectId: shell.config.projectId,
    threadId,
    sessionId: `${threadId}-session`,
    role,
    content,
    occurredAt,
  });
}

function seedPromise(shell: CompanionShell, content: string, threadId: string, at = T0) {
  const event = turn(shell, content, threadId, 'user', at);
  shell.kernel.commitments.compile({ projectId: shell.config.projectId, now: at + 1_000 });
  const entry = shell.kernel.commitments
    .list({ projectId: shell.config.projectId, now: at + 1_000 })
    .find((item) => item.sourceRefs.some((ref) => ref.eventId === event.eventId))!;
  return { event, entry, due: entry.dueAt! };
}

function backendFor(shell: CompanionShell, channelId: string, occasion: 'private' | 'group' | 'public') {
  const binding = shell.kernel.occasionScope.register({ channelId, occasion });
  return new KernelAgentMemoryBackend(shell.kernel, { binding });
}

function emergenceRecords(shell: CompanionShell) {
  return shell.trace.read().filter((record) => record.kind === 'emergence_decision');
}

describe('F13 surface scenarios, tick-driven', () => {
  test('surface-commitment-once: an arrived promise is offered once', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '收到，我提醒你。', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const { due } = seedPromise(shell, '我明天把文件发你', 'promise-turn');
      await shell.tick(due);
      expect(provider.calls).toHaveLength(1);
      expect(shell.kernel.commitments.list({ projectId: shell.config.projectId, now: due + 1 })).toHaveLength(1);
      await shell.tick(due + COOLDOWN);
      expect(provider.calls).toHaveLength(1);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('surface-wake-on-time: the intention fires at its instant, once', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '去看部署。', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const at = T0 + HOUR;
      const reference = turn(shell, '部署还没看。', 'intention-reference');
      const intention = shell.backend.registerWakeIntention({
        projectId: shell.config.projectId,
        agentId: shell.config.agentId,
        at,
        reason: 'check the deploy',
        sourceRefs: [{ eventId: reference.eventId }],
        now: T0,
      });

      await shell.tick(at - 1);
      expect(provider.calls).toHaveLength(0);
      await shell.tick(at);
      expect(provider.calls).toHaveLength(1);
      expect(shell.kernel.wakeIntentions.audit({ projectId: shell.config.projectId, intentionId: intention.intentionId })
        .filter((row) => row.eventType === 'WAKE_INTENTION_FIRED')).toHaveLength(1);
      await shell.tick(at + COOLDOWN);
      expect(provider.calls).toHaveLength(1);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('surface-commitment-snooze: a deferred promise speaks at the chosen resume instant only', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: '我会记得。', toolCalls: [] },
      { text: '现在提醒你。', toolCalls: [] },
    ]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const { entry, due } = seedPromise(shell, '我明天把文件发你', 'promise-turn');
      await shell.tick(due);
      expect(provider.calls).toHaveLength(1);
      const resume = Date.UTC(2026, 10, 17, 8);
      shell.kernel.commitments.snooze({
        projectId: shell.config.projectId,
        commitmentId: entry.commitmentId,
        resumeAt: resume,
        reason: '用户说等会',
        now: due + MINUTE,
      });
      await shell.tick(resume - MINUTE);
      expect(provider.calls).toHaveLength(1);
      await shell.tick(resume);
      expect(provider.calls).toHaveLength(2);
      await shell.tick(resume + COOLDOWN);
      expect(provider.calls).toHaveLength(2);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('surface-prospective-once: a confirmed reminder is announced once', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '该检查 CI 了。', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const request = turn(shell, '提醒我检查 CI。', 'reminder-thread', 'user', T0 - 10 * MINUTE);
      const confirmation = turn(shell, '是的，确认这个提醒。', 'reminder-thread', 'user', T0 - 9 * MINUTE);
      const candidate = shell.kernel.prospectiveMemoryService.propose({
        projectId: shell.config.projectId,
        candidateType: 'reminder',
        canonicalKey: 'behavior-eval:check-ci',
        title: '检查 CI',
        evidenceEventIds: [request.eventId],
        proposedBy: 'operator',
        dueAt: T0 - MINUTE,
      });
      shell.kernel.prospectiveMemoryService.resolve(
        candidate.candidateId,
        { action: 'confirm', confirmationEvidenceEventId: confirmation.eventId },
        shell.config.projectId,
      );

      await shell.tick(T0);
      expect(provider.calls).toHaveLength(1);
      await shell.tick(T0 + COOLDOWN);
      expect(provider.calls).toHaveLength(1);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('surface-task-preference: the assembled task still carries the procedure and preference under a tick', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      await shell.kernel.ingest({ projectId: shell.config.projectId, content: '我喜欢在发布前先跑一遍测试。' });
      for (const [index, threadId] of ['task-1', 'task-2'].entries()) {
        shell.kernel.recordTaskEvent({
          projectId: shell.config.projectId,
          threadId,
          role: 'system',
          content: 'task completed',
          occurredAt: T0 + index * 1_000,
          metadata: {
            procedure: {
              domain: '发布',
              key: 'publish',
              title: '发布 npm 包',
              steps: ['跑测试', 'bun run build'],
              tools: ['bun'],
              outcome: 'succeeded',
            },
          },
        });
      }
      shell.kernel.profile.compile({ projectId: shell.config.projectId, now: T0 + 2_000 });
      shell.kernel.procedures.compile({ projectId: shell.config.projectId, now: T0 + 3_000 });
      await shell.tick(T0 + 4_000);

      const assembly = shell.kernel.procedures.assembleTask({ projectId: shell.config.projectId, task: '帮我发布 npm 包', now: T0 + 5_000 });
      const procedure = assembly.items.find((item) => item.kind === 'procedure');
      const preference = assembly.items.find((item) => item.kind === 'preference');
      expect(procedure?.text).toContain('bun run build');
      expect(procedure?.text).toContain('tools: bun');
      expect(preference?.text).toContain('发布前先跑一遍测试');
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

describe('F13 withhold scenarios, tick-driven', () => {
  test('withhold-life-default: a life-marked turn never becomes an emergence candidate', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      turn(shell, '医生给我开了处方，诊断是高血压，zephyrmark。', 'life-turn');
      const backend = backendFor(shell, 'life-default', 'private');
      const normal = backend.recall({ query: 'zephyrmark', projectId: shell.config.projectId, agentId: 'hermes' });
      expect(normal.items.map((item) => item.text).join('\n')).not.toContain('处方');
      const forensic = backend.recall({ query: 'zephyrmark', projectId: shell.config.projectId, agentId: 'hermes', intent: 'forensic_quote' });
      expect(forensic.items.some((item) => item.text.includes('处方'))).toBe(true);

      await shell.tick(T0 + MINUTE);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('withhold-life-occasion: group/public withhold the life candidate, private asked may show it', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const event = turn(shell, '我的工资这个月晚发了，lifeoccasionmark。', 'life-occasion-turn');
      for (const occasion of ['group', 'public'] as const) {
        const backend = backendFor(shell, `life-${occasion}`, occasion);
        const asked = backend.surfacingCandidates({
          projectId: shell.config.projectId,
          channel: 'asked',
          now: T0 + 1_000,
          query: 'lifeoccasionmark',
        });
        const withheld = asked.withheld.find((item) => item.candidateId.endsWith(event.eventId));
        expect(withheld).toBeDefined();
        const step = withheld!.decisionTrace.steps.find((entry) => entry.rule === 'occasion');
        expect(step?.detail).toMatchObject({ decision: 'withheld', reason: 'occasion_private_tier' });
      }
      const privateBackend = backendFor(shell, 'life-private', 'private');
      const shown = privateBackend.surfacingCandidates({
        projectId: shell.config.projectId,
        channel: 'asked',
        now: T0 + 1_000,
        query: 'lifeoccasionmark',
      });
      expect(shown.candidates.some((item) => item.candidateId.endsWith(event.eventId))).toBe(true);

      await shell.tick(T0 + MINUTE);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('withhold-secret-all-channels: a secret-marked promise is hard-withheld', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const { due } = seedPromise(shell, '我明天把令牌 ghp_abcdefghijklmnopqrstuvwx 发你', 'secret-turn');
      const backend = backendFor(shell, 'secret-surfacing', 'private');
      for (const channel of ['proactive', 'asked'] as const) {
        const result = backend.surfacingCandidates({ projectId: shell.config.projectId, channel, now: T0 + 1_000, query: '令牌' });
        const withheld = result.withheld.find((item) => item.sensitivity === 'high');
        expect(withheld).toBeDefined();
        expect(withheld!.decisionTrace.steps.find((step) => step.rule === 'channel')?.detail).toMatchObject({ hardWithhold: true });
      }
      await shell.tick(due);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('withhold-pause: nothing written during a pause can surface later', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const paused = shell.kernel.sovereignty.pause(shell.config.projectId, 'behavior-eval');
      const since = paused.since!;
      let refused = false;
      try {
        shell.kernel.recordRawEvent({
          projectId: shell.config.projectId,
          threadId: 'pause-thread',
          sessionId: 'pause-session',
          role: 'user',
          content: '暂停期不该落账 pausemarker。',
          occurredAt: since,
        });
      } catch (error) {
        refused = String(error).includes('recording_paused');
      }
      expect(refused).toBe(true);
      shell.kernel.sovereignty.resume(shell.config.projectId);
      const during = shell.kernel.eventStore.queryEvents(1, 100, {
        projectId: [shell.config.projectId],
        startTime: since,
        endTime: since + 60_000,
        order: 'asc',
      });
      expect(during.total).toBe(0);
      await shell.tick(since + 60_000);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the old substring list is gone: 家庭 and 药 are not suppressed by themselves', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '好。', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const { due } = seedPromise(shell, '我明天把家庭照片发你', 'family-turn');
      await shell.tick(due);
      expect(provider.calls).toHaveLength(1);
      const last = emergenceRecords(shell).pop()!;
      const candidate = (last.candidates as Array<Record<string, unknown>>)[0]!;
      expect(candidate.sensitivity).toBe('daily');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

describe('F13 feedback, correction and the other books under a tick', () => {
  test('F7: three ignores withhold the commitment type on the real path', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const { entry, due } = seedPromise(shell, '我明天把文件发你', 'promise-turn');
      for (let index = 0; index < 3; index += 1) {
        shell.backend.recordSurfacingFeedback({
          projectId: shell.config.projectId,
          candidateId: `surfacing:commitment:${entry.commitmentId}`,
          outcome: 'ignored',
          sourceRefs: entry.sourceRefs,
          now: due - (3 - index) * 1_000,
        });
      }
      await shell.tick(due);
      expect(provider.calls).toHaveLength(0);
      const withheld = (emergenceRecords(shell).pop()!.withheld as Array<Record<string, unknown>>)[0]!;
      expect(withheld.reason).toContain('channel=withheld:modulation');
      expect((withheld.steps as Array<Record<string, unknown>>).find((step) => step.rule === 'modulation')?.outcome).toBe('throttled');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('/why shows the F10 grade, the F8 occasion and the F7 feedback step', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '收到。', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const { due } = seedPromise(shell, '我明天把文件发你', 'promise-turn');
      await shell.tick(due);
      const report = shell.whyReport();
      expect(report).toContain('分级：daily');
      expect(report).toContain('场合闸：bound');
      expect(report).toContain('反馈：none');
      expect(report).toContain('来源：commitment');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('correct-life-tier: correcting the mark releases the promise, restoring it withholds again', async () => {
    const releaseDir = makeTempDir();
    const releaseProvider = new ScriptedProvider([{ text: '好。', toolCalls: [] }]);
    const release = makeReplayShell(releaseDir, releaseProvider);
    await release.start();
    try {
      const promise = seedPromise(release, '我明天把病历发你', 'life-correction-1');
      release.kernel.correctLifeSensitivity(promise.event.eventId, 'daily');
      await release.tick(promise.due);
      expect(releaseProvider.calls).toHaveLength(1);
    } finally {
      await release.stop();
    }

    const restoreDir = makeTempDir();
    const restoreProvider = new ScriptedProvider([{ text: '好。', toolCalls: [] }]);
    const restore = makeReplayShell(restoreDir, restoreProvider);
    await restore.start();
    try {
      const promise = seedPromise(restore, '我明天把处方发你', 'life-correction-2');
      restore.kernel.correctLifeSensitivity(promise.event.eventId, 'daily');
      restore.kernel.correctLifeSensitivity(promise.event.eventId, null);
      await restore.tick(promise.due);
      expect(restoreProvider.calls).toHaveLength(0);
      expect(emergenceRecords(restore).pop()!.withheld).toBeDefined();
    } finally {
      await restore.stop();
    }
  }, 30_000);

  test('record-profile-books: the profile books survive a tick', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const said = turn(shell, '我用 vim，喜欢喝乌龙茶。', 'profile-turn');
      for (const [predicate, value, reason] of [['uses', 'vim', 'explicit_user_statement'], ['likes', '乌龙茶', 'preference_signal']] as const) {
        shell.kernel.beliefStore.upsert({
          projectId: shell.config.projectId,
          scope: 'project',
          subject: 'owner',
          predicate,
          objectValue: { raw: value, type: 'string' },
          confidence: 0.9,
          sourceType: 'user_input',
          extractionReason: reason,
          sourceEventId: said.eventId,
          validFrom: T0,
        });
      }
      shell.kernel.profile.compile({ projectId: shell.config.projectId, now: T0 + 1_000 });
      await shell.tick(T0 + 2_000);
      expect(shell.kernel.profile.entries({ projectId: shell.config.projectId, ledger: 'facts' })[0]?.value).toBe('vim');
      expect(shell.kernel.profile.entries({ projectId: shell.config.projectId, ledger: 'preferences' })[0]?.value).toBe('乌龙茶');
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('record-procedure-book: two task attempts stay one established practice under a tick', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const descriptor = {
        domain: '发布', key: 'publish', title: '发布 npm 包',
        steps: ['跑测试', 'bun run build', 'bun publish'], tools: ['bun'], outcome: 'succeeded',
      };
      for (const [index, threadId] of ['task-1', 'task-2'].entries()) {
        shell.kernel.recordTaskEvent({
          projectId: shell.config.projectId, threadId, role: 'system', content: 'task completed',
          occurredAt: T0 + index * 1_000, metadata: { procedure: descriptor },
        });
      }
      shell.kernel.procedures.compile({ projectId: shell.config.projectId, now: T0 + 2_000 });
      await shell.tick(T0 + 3_000);
      const entries = shell.kernel.procedures.entries({ projectId: shell.config.projectId });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.grade).toBe('established');
      expect(entries[0]!.steps).toEqual(descriptor.steps);
      expect(entries[0]!.tools).toEqual(descriptor.tools);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('record-commitment-book: the promise keeps owner, content and due under a tick', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const { entry, due } = seedPromise(shell, '我明天把文件发你', 'promise-turn');
      await shell.tick(T0 + 2_000);
      expect(entry.owner).toBe('user');
      expect(entry.content).toContain('文件');
      expect(entry.dueAt).toBe(due);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('record-intention-book: an agent plan stays active under a tick', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const plan = turn(shell, '我准备把报告整理一下。', 'plan-turn', 'assistant');
      shell.kernel.intentions.compile({ projectId: shell.config.projectId, now: T0 + 1_000 });
      await shell.tick(T0 + 2_000);
      const entries = shell.kernel.intentions.list({ projectId: shell.config.projectId, now: T0 + 3_000 });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.origin).toBe('conversation');
      expect(entries[0]!.status).toBe('active');
      expect(entries[0]!.content).toContain('报告');
      expect(entries[0]!.sourceRefs.some((ref) => ref.eventId === plan.eventId)).toBe(true);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('correct-profile-preference: every later read carries the correction', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const original = turn(shell, '我喜欢喝乌龙茶。', 'preference-original');
      shell.kernel.beliefStore.upsert({
        projectId: shell.config.projectId, scope: 'project', subject: 'owner', predicate: 'likes',
        objectValue: { raw: '乌龙茶', type: 'string' }, confidence: 0.9, sourceType: 'user_input',
        extractionReason: 'preference_signal', sourceEventId: original.eventId, validFrom: T0,
      });
      shell.kernel.profile.compile({ projectId: shell.config.projectId, now: T0 + 1_000 });
      const before = shell.kernel.profile.entries({ projectId: shell.config.projectId, ledger: 'preferences' })[0]!;
      const correction = turn(shell, '其实我不喝乌龙茶了，现在喜欢红茶。', 'preference-correction', 'user', T0 + 2_000);
      shell.kernel.profile.correct({
        projectId: shell.config.projectId, ledger: 'preferences', key: before.key,
        value: '红茶', correctionEventId: correction.eventId, now: T0 + 3_000,
      });
      await shell.tick(T0 + 4_000);
      const backend = backendFor(shell, 'correct-preference-recall', 'private');
      const recalled = backend.recall({ projectId: shell.config.projectId, agentId: 'hermes', query: '红茶 乌龙茶', limit: 8 });
      const text = recalled.items.filter((item) => item.id.startsWith('profile:')).map((item) => item.text).join(' ');
      expect(text).toContain('红茶');
      expect(text).not.toContain('乌龙茶');
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('correct-profile-fact: a full recompile leaves the correction standing', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeReplayShell(dir, provider);
    await shell.start();
    try {
      const original = turn(shell, '我平时用 vim 写代码。', 'fact-original');
      shell.kernel.beliefStore.upsert({
        projectId: shell.config.projectId, scope: 'project', subject: 'owner', predicate: 'uses',
        objectValue: { raw: 'vim', type: 'string' }, confidence: 0.9, sourceType: 'user_input',
        extractionReason: 'explicit_user_statement', sourceEventId: original.eventId, validFrom: T0,
      });
      shell.kernel.profile.compile({ projectId: shell.config.projectId, now: T0 + 1_000 });
      const before = shell.kernel.profile.entries({ projectId: shell.config.projectId, ledger: 'facts' })[0]!;
      const correction = turn(shell, '我现在改用 emacs 了。', 'fact-correction', 'user', T0 + 2_000);
      shell.kernel.profile.correct({
        projectId: shell.config.projectId, ledger: 'facts', key: before.key,
        value: 'emacs', correctionEventId: correction.eventId, now: T0 + 3_000,
      });
      shell.kernel.profile.compile({ projectId: shell.config.projectId, now: T0 + 4_000 });
      await shell.tick(T0 + 5_000);
      const backend = backendFor(shell, 'correct-fact-recall', 'private');
      const recalled = backend.recall({ projectId: shell.config.projectId, agentId: 'hermes', query: 'vim emacs', limit: 8 });
      const text = recalled.items.filter((item) => item.id.startsWith('profile:')).map((item) => item.text).join(' ');
      expect(text).toContain('emacs');
      expect(text).not.toContain('vim');
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('correct-intention-veto: a restarted shell still sees the plan abandoned', async () => {
    const dir = makeTempDir();
    const first = makeReplayShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]));
    await first.start();
    await first.stop();

    const second = makeReplayShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]));
    await second.start();
    try {
      const reference = turn(second, '复盘时提到日志太多。', 'intention-reference', 'assistant');
      const proposed = second.kernel.intentions.propose({
        projectId: second.config.projectId,
        agentId: 'hermes',
        content: '我准备把这批日志清掉。',
        sourceRefs: [{ eventId: reference.eventId }],
        now: T0 + 1_000,
      });
      const ownerTurn = turn(second, '这个计划我不同意。', 'intention-veto', 'user', T0 + 3_000);
      second.kernel.intentions.veto({
        projectId: second.config.projectId,
        intentionId: proposed.intentionId,
        evidenceEventId: ownerTurn.eventId,
        now: T0 + 4_000,
      });
      await second.tick(T0 + 5_000);
      expect(second.kernel.intentions.activeForAgent({ projectId: second.config.projectId, agentId: 'hermes', now: T0 + 6_000 })).toHaveLength(0);
    } finally {
      await second.stop();
    }

    const third = makeReplayShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]));
    await third.start();
    try {
      expect(third.kernel.intentions.activeForAgent({ projectId: third.config.projectId, agentId: 'hermes', now: T0 + 7_000 })).toHaveLength(0);
      const abandoned = third.kernel.intentions.list({ projectId: third.config.projectId, statuses: ['abandoned'], now: T0 + 7_000 });
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]!.closeReason).toBe('vetoed');
    } finally {
      await third.stop();
    }
  }, 30_000);
});

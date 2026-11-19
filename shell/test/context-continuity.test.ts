/**
 * Context continuity (#245 A1, #247 A3, #246 A2).
 *
 * A1: a new run's request carries the recent verbatim turns of the session (the kernel's `tail`
 * lane), so a follow-up like "继续" can still see what the previous run was about.
 * A3: the recall block is part of every provider call of the run, not only the first one.
 * A2: a new message attaches to the open assignment unless the model explicitly declares a task
 * boundary.
 */
import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir, seedOpenAssignment } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

/** One lane's rendered bytes: its `[lane]` header up to the next lane header. */
const laneBlock = (text: string, lane: string): string => {
  const start = text.indexOf(`[${lane}]`);
  if (start < 0) return '';
  const rest = text.slice(start + lane.length + 2);
  const next = rest.search(/\n\[[a-z_]+\]/);
  return next < 0 ? rest : rest.slice(0, next);
};

describe('context continuity', () => {
  test('a plain message never renders an assignment block', async () => {
    const provider = new ScriptedProvider([
      { text: '一句。', toolCalls: [] },
      { text: '两句。', toolCalls: [] },
      { text: '三句。', toolCalls: [] },
      { text: '四句。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('continuity-no-assignment-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('一句话聊天');
      await shell.submit('第二句闲聊');
      await shell.submit('第三句闲聊');
      await shell.submit('第四句闲聊');
      expect(provider.calls).toHaveLength(4);
      for (const call of provider.calls) {
        expect(call.systemPrompt ?? '').not.toContain('<open-assignment>');
        expect(asText(call.messages)).not.toContain('<open-assignment>');
      }
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an open assignment renders once in working_set, never in the system prompt', async () => {
    const provider = new ScriptedProvider([
      { text: '第一句。', toolCalls: [] },
      () => {
        throw new Error('provider down');
      },
    ]);
    const shell = makeShell(makeTempDir('continuity-one-assignment-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('要做的任务');
      seedOpenAssignment(shell, '要做的任务');
      await shell.submit('继续');
      expect(provider.calls).toHaveLength(2);
      expect(shell.machine.runtime.openAssignment).toBeDefined();
      expect(shell.state).toBe('IDLE');
      for (const call of provider.calls) {
        expect((call.systemPrompt ?? '').match(/<open-assignment>/g) ?? []).toHaveLength(0);
      }
      const second = asText(provider.calls[1].messages);
      expect((provider.calls[1].systemPrompt ?? '').match(/<open-assignment>/g) ?? []).toHaveLength(0);
      expect(second.match(/<open-assignment>/g) ?? []).toHaveLength(1);
      const workingSet = laneBlock(second, 'working_set');
      expect(workingSet).toContain('<open-assignment>');
      expect(workingSet).toContain('user-assigned task: 要做的任务');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A1: a second run carries the recent turns of the first (tail lane)', async () => {
    const provider = new ScriptedProvider([{ text: '好的，我先看回滚逻辑。', toolCalls: [] }, { text: '继续。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('continuity-a1-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('帮我把部署脚本里的回滚逻辑重写一下');
      await shell.submit('继续');
      expect(asText(provider.calls[1].messages)).toContain('[tail]');
      expect(asText(provider.calls[1].messages)).toContain('回滚逻辑');
      expect(asText(provider.calls[1].messages)).toContain('我先看回滚逻辑');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A1: tailTurns bounds the verbatim tail and the cut is browsable', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('continuity-a1-bound-'), provider, { dream: NO_DREAM, tailTurns: 2 });
    await shell.start();
    try {
      await shell.submit('第一轮：回滚逻辑要看旧版本');
      await shell.submit('第二轮：部署窗口是周二');
      await shell.submit('第三轮：继续');
      const third = asText(provider.calls[2].messages);
      expect(third).toContain('第二轮：部署窗口是周二');
      expect(third).toContain('收到二。');
      // Ruling on #249 (comment 6910745618): with tailTurns=2 the first turn leaves the verbatim
      // tail and lands in the digest. docs/session-context.md freezes the digest entry's `text` as
      // the ledger row's exact text, never a summary, so the cut is carried verbatim instead of
      // silently disappearing. The old assertion ("the whole request excludes round 1") had encoded
      // the stopgap's silent loss as the contract; A1's real guarantee is that the tail stays
      // bounded *and* the evicted turn remains readable, verbatim, in the digest.
      expect(laneBlock(third, 'tail')).not.toContain('第一轮：回滚逻辑要看旧版本');
      expect(laneBlock(third, 'tail')).not.toContain('收到一。');
      expect(laneBlock(third, 'digest')).toContain('第一轮：回滚逻辑要看旧版本');
      expect(laneBlock(third, 'digest')).toContain('收到一。');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A1: the tail lane is bounded by the F14 budget and collapses to a browse-only stub', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('continuity-a1-budget-'), provider, { dream: NO_DREAM, contextSweetSpot: 10 });
    await shell.start();
    try {
      await shell.submit('第一轮：回滚逻辑要看旧版本');
      await shell.submit('第二轮：部署窗口是周二');
      await shell.submit('第三轮：继续');
      const third = asText(provider.calls[2].messages);
      expect(third).toContain('[tail: browse-only, 4 item(s); keys: newest 4 of 4]');
      expect(third).not.toContain('第二轮：部署窗口是周二');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A3: the recall block is still in the context after a tool call in the same run', async () => {
    const provider = new ScriptedProvider([
      { text: '先看一下。', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'echo hi' } }] },
      { text: '看完了。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('continuity-a3-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: 'seeded-elsewhere',
        turnId: 'seed-1',
        userText: '部署窗口是周二凌晨两点，周五绝对不能部署',
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      await shell.submit('帮我看看部署窗口是什么时候');
      expect(provider.calls.length).toBeGreaterThanOrEqual(2);
      expect(asText(provider.calls[0].messages)).toContain('<COGMEM_RECALL_CONTEXT');
      expect(asText(provider.calls[0].messages)).toContain('周五绝对不能部署');
      expect(asText(provider.calls[1].messages)).toContain('<COGMEM_RECALL_CONTEXT');
      expect(asText(provider.calls[1].messages)).toContain('周五绝对不能部署');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  const seedAssignment = (shell: Awaited<ReturnType<typeof makeShell>>, text: string) => {
    shell.machine.updateRuntime({
      openAssignment: {
        id: 'assignment-seed',
        origin: 'user_message',
        text,
        latestUserText: text,
        startedAt: 1,
      },
    });
  };

  test('A2: a new message attaches to the open assignment and keeps its handoff', async () => {
    const provider = new ScriptedProvider([
      { text: '结论：迁移脚本从 step 3 开始改。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
      { text: '继续处理。', toolCalls: [{ toolCallId: 'c2', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
    ]);
    const shell = makeShell(makeTempDir('continuity-a2-'), provider, {
      dream: NO_DREAM,
      budgets: { maxTurnsPerRun: 6, maxTokensPerRun: 20_000, toolWhitelist: null },
      workBudget: { maxTurnsPerRun: 4, maxTokensPerRun: 1_000 },
    });
    await shell.start();
    try {
      seedAssignment(shell, '迁移脚本改到 step 3');
      await shell.submit('迁移脚本改到 step 3');
      const before = shell.machine.runtime.openAssignment!;
      expect(before.stoppedStep).toBeDefined();
      expect(before.findings).toContain('step 3');
      await shell.submit('继续');
      expect(shell.state).toBe('SUSPENDED');
      const prompt = asText(provider.calls[1].messages);
      const workingSet = laneBlock(prompt, 'working_set');
      expect(workingSet).toContain('user-assigned task: 迁移脚本改到 step 3');
      expect(workingSet).toContain('stopped at:');
      expect(workingSet).toContain('confirmed findings: 结论：迁移脚本从 step 3 开始改。');
      const after = shell.machine.runtime.openAssignment!;
      expect(after.id).toBe(before.id);
      expect(after.text).toBe('迁移脚本改到 step 3');
      expect(after.latestUserText).toBe('继续');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A2: declare_task start settles the old assignment and does not carry its findings', async () => {
    const provider = new ScriptedProvider([
      { text: '结论：迁移脚本从 step 3 开始改。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
      { text: '开始处理发布清单。', toolCalls: [{ toolCallId: 'c2', toolName: 'declare_task', input: { action: 'start' } }] },
      { text: 'B 结论：发布清单已整理。', toolCalls: [{ toolCallId: 'c3', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
    ]);
    const shell = makeShell(makeTempDir('continuity-a2-start-'), provider, {
      dream: NO_DREAM,
      budgets: { maxTurnsPerRun: 6, maxTokensPerRun: 20_000, toolWhitelist: null },
      workBudget: { maxTurnsPerRun: 4, maxTokensPerRun: 1_000 },
    });
    await shell.start();
    try {
      seedAssignment(shell, '迁移脚本改到 step 3');
      await shell.submit('迁移脚本改到 step 3');
      const before = shell.machine.runtime.openAssignment!;
      await shell.submit('换成任务 B：整理发布清单');
      expect(shell.state).toBe('SUSPENDED');
      const thirdPrompt = asText(provider.calls[2].messages);
      const workingSet = laneBlock(thirdPrompt, 'working_set');
      expect(workingSet).toContain('user-assigned task: 换成任务 B：整理发布清单');
      expect(workingSet).not.toContain('迁移脚本改到 step 3');
      expect(workingSet).not.toContain('结论：迁移脚本从 step 3 开始改。');
      const after = shell.machine.runtime.openAssignment!;
      expect(after.id).not.toBe(before.id);
      expect(after.text).toBe('换成任务 B：整理发布清单');
      expect(after.findings).toBe('B 结论：发布清单已整理。');
      const declared = shell.trace.read().find((record) => record.kind === 'assignment_declared' && record.action === 'start');
      expect(declared?.previousAssignmentId).toBe(before.id);
      expect(declared?.assignmentId).toBe(after.id);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A2: declare_task end closes the assignment before the run ends', async () => {
    const provider = new ScriptedProvider([
      { text: '结论：迁移脚本从 step 3 开始改。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
      { text: '做完了。', toolCalls: [{ toolCallId: 'c2', toolName: 'declare_task', input: { action: 'end' } }] },
      { text: '收尾。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('continuity-a2-end-'), provider, {
      dream: NO_DREAM,
      budgets: { maxTurnsPerRun: 6, maxTokensPerRun: 20_000, toolWhitelist: null },
      workBudget: { maxTurnsPerRun: 4, maxTokensPerRun: 1_000 },
    });
    await shell.start();
    try {
      seedAssignment(shell, '迁移脚本改到 step 3');
      await shell.submit('迁移脚本改到 step 3');
      await shell.submit('继续');
      expect(shell.state).toBe('IDLE');
      expect(asText(provider.calls[1].messages)).toContain('<open-assignment>');
      expect(provider.calls[2].systemPrompt).not.toContain('<open-assignment>');
      expect(shell.machine.runtime.openAssignment).toBeUndefined();
      expect(shell.trace.read().some((record) => record.kind === 'assignment_declared' && record.action === 'end')).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

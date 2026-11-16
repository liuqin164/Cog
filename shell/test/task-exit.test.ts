/**
 * #263 D3: a declared task end exits the working set and leaves one digest stub.
 *
 * The discriminator is the ticket's: after A ends and B starts, B's working set has none of A's
 * material, the digest lane has one A stub, and the stub's key drills back to the ledger row
 * verbatim. A run without the explicit declaration must leave the working set alone, and a
 * protected constraint in the working set must survive the exit (#255).
 */
import { describe, expect, test } from 'bun:test';
import type { SessionContextAssembly } from 'cogmem';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

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

const lastAssembly = (shell: ReturnType<typeof makeShell>): SessionContextAssembly | undefined =>
  (shell as unknown as { lastLaneAssembly?: SessionContextAssembly }).lastLaneAssembly;

const budgetShell = (prefix: string, provider: ScriptedProvider) =>
  makeShell(makeTempDir(prefix), provider, {
    dream: NO_DREAM,
    budgets: { maxTurnsPerRun: 6, maxTokensPerRun: 20_000, toolWhitelist: null },
    workBudget: { maxTurnsPerRun: 4, maxTokensPerRun: 1_000 },
  });

/** A is left open by a budget stop, with a conclusion the next run can hand off. */
const openTaskA = async (shell: ReturnType<typeof makeShell>, text = '迁移脚本改到 step 3') => {
  await shell.submit(text);
  expect(shell.state).toBe('SUSPENDED');
  expect(shell.machine.runtime.openAssignment).toBeDefined();
};

describe('a declared task end exits the working set (#263)', () => {
  test('B has none of A in working_set, one stub in digest, and its key opens the original', async () => {
    const provider = new ScriptedProvider([
      { text: '结论：迁移脚本从 step 3 开始改。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
      { text: '做完了。', toolCalls: [{ toolCallId: 'c2', toolName: 'declare_task', input: { action: 'end' } }] },
      { text: '收尾。', toolCalls: [] },
      { text: 'B 结论：发布清单已整理。', toolCalls: [] },
    ]);
    const shell = budgetShell('task-exit-', provider);
    await shell.start();
    try {
      await openTaskA(shell);
      await shell.submit('继续');
      expect(shell.state).toBe('IDLE');
      expect(shell.machine.runtime.openAssignment).toBeUndefined();

      await shell.submit('换成任务 B：整理发布清单');
      const request = asText(provider.calls.at(-1)!.messages);
      const working = laneBlock(request, 'working_set');
      const digest = laneBlock(request, 'digest');

      // A's practice and material are gone from the working set; B's own assignment is there.
      expect(working).toContain('user-assigned task: 换成任务 B：整理发布清单');
      expect(working).not.toContain('迁移脚本');
      expect(working).not.toContain('step 3');
      // One stub remains, quoting A's ledger rows rather than a model summary.
      expect(digest).toContain('任务：迁移脚本改到 step 3');
      expect(digest).toContain('结论：迁移脚本从 step 3 开始改。');
      expect(digest).toContain('收束：做完了。');

      const key = digest.match(/anchorEvent=(evt-[A-Za-z0-9-]+)/u)?.[1];
      expect(key).toBeDefined();
      const drilled = await shell.host.tools.invoke('read', { toolCallId: 'c3', input: { path: `mem:${key}` } }, { runId: 'r' });
      expect(drilled.isError).toBe(false);
      expect(drilled.output).toBe('结论：迁移脚本从 step 3 开始改。');

      const written = shell.trace.read().find((record) => record.kind === 'task_stub_written');
      expect(written?.entryId).toBe(`digest:${key}`);
      expect(written?.sourceRefs).toContain(key!);
      expect((written?.sourceRefs as string[]).length).toBeGreaterThanOrEqual(2);
      // The stub quotes the end declaration's own row, so it cannot be written before `agent_end`
      // captured that run — the timing bug this guards against.
      const trace = shell.trace.read();
      const endRunId = trace.find((record) => record.kind === 'assignment_declared' && record.action === 'end')?.runId;
      const captureIndex = trace.findIndex((record) => record.kind === 'capture_run' && record.runId === endRunId);
      const stubIndex = trace.findIndex((record) => record.kind === 'task_stub_written');
      expect(captureIndex).toBeGreaterThan(-1);
      expect(stubIndex).toBeGreaterThan(captureIndex);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('without an end declaration the working set is unchanged', async () => {
    const provider = new ScriptedProvider([
      { text: '结论：迁移脚本从 step 3 开始改。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
      { text: '还没做完。', toolCalls: [{ toolCallId: 'c2', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
    ]);
    const shell = budgetShell('task-exit-counter-', provider);
    await shell.start();
    try {
      await openTaskA(shell);
      await shell.submit('继续');
      expect(shell.state).toBe('SUSPENDED');
      const request = asText(provider.calls.at(-1)!.messages);
      expect(laneBlock(request, 'working_set')).toContain('user-assigned task: 迁移脚本改到 step 3');
      expect(laneBlock(request, 'working_set')).toContain('confirmed findings: 结论：迁移脚本从 step 3 开始改。');
      expect(laneBlock(request, 'digest')).not.toContain('任务：迁移脚本改到 step 3');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a protected constraint survives the exit; the stub that quotes it is protected too', async () => {
    const task = '迁移脚本改到 step 3，周五绝对不能部署';
    const provider = new ScriptedProvider([
      { text: '结论：迁移脚本从 step 3 开始改。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }], usage: { input: 25_000, output: 1 } },
      { text: '做完了。', toolCalls: [{ toolCallId: 'c2', toolName: 'declare_task', input: { action: 'end' } }] },
      { text: '收尾。', toolCalls: [] },
      { text: 'B 结论：发布清单已整理。', toolCalls: [] },
    ]);
    const shell = budgetShell('task-exit-protected-', provider);
    await shell.start();
    try {
      await openTaskA(shell, task);
      await shell.submit('继续');
      expect(shell.state).toBe('IDLE');
      await shell.submit('换成任务 B：整理发布清单');
      const request = asText(provider.calls.at(-1)!.messages);
      expect(laneBlock(request, 'working_set')).toContain('周五绝对不能部署');
      expect(laneBlock(request, 'digest')).toContain('周五绝对不能部署');
      const assembly = lastAssembly(shell);
      const stub = assembly?.lanes
        .find((lane) => lane.lane === 'digest')!
        .items.find((item) => item.text.includes('迁移脚本'));
      expect(stub?.protected).toBe(true);
      const retained = shell.trace.read().find((record) => record.kind === 'assignment_declared' && record.action === 'end');
      expect(retained?.protectedRetained).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

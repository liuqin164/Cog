/**
 * #268: the projection actions a turn took are counted on `context_assembled`, and `/context`
 * reads the same numbers. A round with a fold and a `mem:` drill must trace exactly those actions;
 * a zero is reported as zero rather than omitted.
 */
import { describe, expect, test } from 'bun:test';
import type { LaneAssemblyView, ContextMetrics } from '../src/state/session-lanes.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';
const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };
const EVENT_TEXT = '账本原文：部署窗口是周二凌晨两点。';
describe('context projection metrics (#268)', () => {
  test('a fold and a mem: drill are counted on the trace, and /context shows the same numbers', async () => {
    let eventId = '';
    const provider = new ScriptedProvider([
      () => ({
        text: '',
        toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: `mem:${eventId}` } }],
      }),
      { text: '读完了。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir(), provider, { dream: NO_DREAM, contextSweetSpot: 10 });
    await shell.start();
    try {
      eventId = shell.kernel.recordRawEvent({
        projectId: shell.config.projectId,
        threadId: 'drill',
        role: 'user',
        content: EVENT_TEXT,
      }).eventId;
      const summary = await shell.submit('第一轮：读一下账本原文');
      expect(summary!.toolResults[0]!.isError).toBe(false);
      expect(summary!.toolResults[0]!.output).toBe(EVENT_TEXT);
      const traces = shell.trace.read().filter((record) => record.kind === 'context_assembled');
      const traced = traces.at(-1)!;
      const metrics = traced.metrics as ContextMetrics;
      const lanes = traced.lanes as LaneAssemblyView;
      // Every count is present, even at zero.
      expect(Object.keys(metrics).sort()).toEqual(['autoExpands', 'drills', 'folds']);
      // Folds are the assembly's own decision trace, action for action.
      expect(metrics.folds).toBe(lanes.decisionTrace.length);
      expect(metrics.folds).toBeGreaterThan(0);
      expect(metrics.drills).toBe(1);
      expect(metrics.autoExpands).toBe(0);
      const text = (await shell.runCommand('context')).text;
      expect(text).toContain(`本轮折叠 ${metrics.folds} 次`);
      expect(text).toContain('下钻 1 次');
      expect(text).toContain('自动展开 0 次');
      // The tool lane is its own line, and the whole request states the budget it is fitted to (#319).
      expect(text).toMatch(/本轮工具输出 \d+ token（占请求 \d+%(?:；折叠 \d+ 条)?）/u);
      expect(text).toContain('整请求预算 10 token');
      // A scripted provider reports no cache fields; the line says so instead of claiming 0% (#320).
      expect(text).toContain('上游未回报缓存字段');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});
describe('autoExpands in /context reflects assembly (#352)', () => {
  test('a raw fact arrives whole in the recall lane, so nothing is auto-expanded', async () => {
    const ORIGINAL = '团队把「上传失败」的重试上限定为 12,500 次，由「小明」负责。';
    const provider = new ScriptedProvider([{ text: '重试上限是 12,500 次。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir(), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: 'seeded-elsewhere',
        turnId: 'seed-auto-expand',
        userText: ORIGINAL,
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      await shell.submit('上传失败的重试上限是多少？');
      const recalled = shell.backend.recall({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        query: '上传失败的重试上限是多少？',
        excludeSessionId: shell.config.sessionId,
        limit: 5,
      });
      expect(recalled.items.some((item) => item.text === ORIGINAL)).toBe(true);
      const ctxText = (await shell.runCommand('context')).text;
      expect(ctxText).toMatch(/自动展开 \d+ 次/u);
      const firstMatch = ctxText.match(/自动展开 (\d+) 次/u);
      expect(firstMatch).not.toBeNull();
      expect(Number(firstMatch![1])).toBe(0);
      await shell.submit('把那个上限再说一遍');
      const secondCtxText = (await shell.runCommand('context')).text;
      expect(secondCtxText).toContain('自动展开 0 次');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});
describe('tools load full set, independent of message content (#333)', () => {
  test('casual message and task-like message both load the same 13 tools', async () => {
    const provider = new ScriptedProvider([{ text: '收到。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir(), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('你好，今天天气怎么样？');
      const casualCtx = (await shell.runCommand('context')).text;
      const casualTools = casualCtx.match(/已装载工具：(.+)/);
      expect(casualTools).not.toBeNull();
      const casualToolList = casualTools![1].split('、').sort().join('、');
      await shell.submit('请帮我写一个 bash 脚本来备份文件');
      const taskCtx = (await shell.runCommand('context')).text;
      const taskTools = taskCtx.match(/已装载工具：(.+)/);
      expect(taskTools).not.toBeNull();
      const taskToolList = taskTools![1].split('、').sort().join('、');
      expect(taskToolList).toBe(casualToolList);
      expect(casualToolList).toContain('read');
      expect(casualToolList).toContain('write');
      expect(casualToolList).toContain('edit');
      expect(casualToolList).toContain('bash');
      expect(casualToolList).toContain('propose_command');
      expect(casualToolList).toContain('ask_user');
      expect(casualToolList).toContain('declare_task');
      expect(casualToolList).toContain('propose_soul_edit');
      expect(casualToolList).toContain('memory');
    } finally {
      await shell.stop();
    }
  }, 30_000);
  test('no tools-by-task module exists in codebase', async () => {
    const provider = new ScriptedProvider([{ text: '收到。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir(), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('任意消息');
      const ctx = (await shell.runCommand('context')).text;
      const toolsLine = ctx.match(/已装载工具：(.+)/);
      expect(toolsLine).not.toBeNull();
    expect(toolsLine![1].split('、')).toHaveLength(13);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

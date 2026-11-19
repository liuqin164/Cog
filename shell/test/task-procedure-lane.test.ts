/**
 * #261 D1: the practice book at the start of work. The open task's own text recalls a practice into
 * `working_set`; a checklist entry is delivered whole and protected, a miss leaves the lane alone.
 * The practice fed here is produced by a real task end (#262), so this is the loop end to end.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionContextAssembly } from 'cogmem';
import { ScriptedProvider, makeShell, makeTempDir, seedOpenAssignment } from './helpers.ts';
import type { ModelTurn } from '../src/state/agent-loop.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

const laneBlock = (text: string, lane: string): string => {
  const start = text.indexOf(`[${lane}]`);
  if (start < 0) return '';
  const rest = text.slice(start + lane.length + 2);
  const next = rest.search(/\n\[[a-z_]+\]/);
  return next < 0 ? rest : rest.slice(0, next);
};

const lastAssembly = (shell: ReturnType<typeof makeShell>): SessionContextAssembly | undefined =>
  (shell as unknown as { lastLaneAssembly?: SessionContextAssembly }).lastLaneAssembly;

const shellFor = (prefix: string, provider: ScriptedProvider, contextSweetSpot = 6_000) =>
  makeShell(makeTempDir(prefix), provider, {
    dream: NO_DREAM,
    contextSweetSpot,
    budgets: { maxTurnsPerRun: 8, maxTokensPerRun: 40_000, toolWhitelist: null },
    workBudget: { maxTurnsPerRun: 8, maxTokensPerRun: 40_000 },
  });

/** Task A, completed twice with the same declared practice, so the book holds it as established. */
const completeTaskA = async (shell: ReturnType<typeof makeShell>) => {
  seedOpenAssignment(shell, '把发布脚本改好');
  await shell.submit('把发布脚本改好');
  seedOpenAssignment(shell, '把发布脚本改好');
  await shell.submit('再把发布脚本核一遍');
};

const taskAScript: ModelTurn[] = [
  {
    text: '先写发布脚本。',
    toolCalls: [
      { toolCallId: 'c1', toolName: 'write', input: { path: 'release.txt', content: 'ship' } },
      { toolCallId: 'c2', toolName: 'read', input: { path: 'release.txt' } },
    ],
  },
  {
    text: '做完了。',
    toolCalls: [{
      toolCallId: 'c3',
      toolName: 'declare_task',
      input: { action: 'end', domain: '发布', key: 'npm-publish', checklist: true },
    }],
  },
  { text: '顺手看一眼。', toolCalls: [{ toolCallId: 'c4', toolName: 'read', input: { path: 'notes.txt' } }] },
  { text: '收尾。', toolCalls: [] },
  {
    text: '再核一遍。',
    toolCalls: [{ toolCallId: 'c5', toolName: 'read', input: { path: 'release.txt' } }],
  },
  {
    text: '这次真的做完了。',
    toolCalls: [{
      toolCallId: 'c6',
      toolName: 'declare_task',
      input: { action: 'end', domain: '发布', key: 'npm-publish', checklist: true },
    }],
  },
  { text: '收尾。', toolCalls: [] },
];

describe('the start-of-task lane carries a produced practice (#261)', () => {
  test('B hits A\'s established practice whole; an unrelated task carries none of it', async () => {
    const provider = new ScriptedProvider([
      ...taskAScript,
      { text: 'B 任务开始。', toolCalls: [{ toolCallId: 'c7', toolName: 'declare_task', input: { action: 'start' } }] },
      { text: '按做法做。', toolCalls: [] },
      { text: '整理读书笔记。', toolCalls: [] },
    ]);
    const shell = shellFor('task-procedure-lane-', provider);
    await shell.start();
    try {
      await completeTaskA(shell);
      expect(shell.kernel.procedures.entries({ projectId: shell.config.projectId })
        .find((candidate) => candidate.key === 'npm-publish')?.grade).toBe('established');

      await shell.submit('帮我把 npm 包发布出去');
      const hit = laneBlock(asText(provider.calls.at(-1)!.messages), 'working_set');
      expect(hit).toContain('npm-publish: write: {"path":"release.txt","content":"ship"} → read: {"path":"release.txt"}');
      expect(hit).toContain('(tools: write, read)');
      // Checklist policy: the working_set item is protected, never downgraded or excerpted.
      expect(lastAssembly(shell)?.lanes.find((lane) => lane.lane === 'working_set')?.items
        .find((item) => item.id.startsWith('procedure:'))?.protected).toBe(true);

      await shell.submit('整理读书笔记');
      const miss = laneBlock(asText(provider.calls.at(-1)!.messages), 'working_set');
      expect(miss).not.toContain('npm-publish');
      expect(miss).not.toContain('release.txt');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('under budget the checklist stays verbatim; the recall-tier practice is the pointer', async () => {
    const provider = new ScriptedProvider([{ text: '好的。', toolCalls: [] }]);
    const shell = shellFor('task-procedure-lane-budget-', provider, 400);
    await shell.start();
    try {
      seedOpenAssignment(shell, '发布之前做一次回滚演练');
      for (const [index, descriptor] of [
        { domain: '发布', key: 'npm-publish', title: '发布 npm 包', steps: ['跑测试', 'bun run build'], tools: ['bun'], checklist: true },
        { domain: '回滚', key: 'rollback', title: '回滚一次发布', steps: ['取上一版', '重新部署'], tools: ['bash'] },
      ].entries()) {
        shell.kernel.recordTaskEvent({
          projectId: shell.config.projectId,
          threadId: 'seed',
          role: 'system',
          content: 'task completed',
          occurredAt: Date.now() + index,
          metadata: { procedure: { ...descriptor, outcome: 'succeeded' } },
        });
      }
      shell.kernel.procedures.compile({ projectId: shell.config.projectId });

      await shell.submit('发布之前做一次回滚演练');
      const working = laneBlock(asText(provider.calls.at(-1)!.messages), 'working_set');
      // The checklist is delivered whole, not excerpted and not replaced by a pointer.
      expect(working).toContain('发布 npm 包: 跑测试 → bun run build (tools: bun)');
      expect(working).not.toContain('rollback');
      const lane = lastAssembly(shell)!.lanes.find((candidate) => candidate.lane === 'working_set')!;
      expect(lane.items.some((item) => item.id.startsWith('procedure:'))).toBe(true);
      expect(lane.browseIds.some((id) => id.startsWith('procedure:'))).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

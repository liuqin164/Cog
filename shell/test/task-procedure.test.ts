/**
 * #262 D2 producer: at `declare_task end` the model fills domain and key; steps and tools come only
 * from the task's captured `tool_call` rows. The book never records a step the trace does not show.
 */
import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };

const shellFor = (prefix: string, provider: ScriptedProvider, contextSweetSpot = 6_000) =>
  makeShell(makeTempDir(prefix), provider, {
    dream: NO_DREAM,
    contextSweetSpot,
    budgets: { maxTurnsPerRun: 8, maxTokensPerRun: 40_000, toolWhitelist: null },
    workBudget: { maxTurnsPerRun: 8, maxTokensPerRun: 40_000 },
  });

describe('the task-end producer leaves only the real trajectory (#262)', () => {
  test('two completed attempts establish the practice from captured calls only', async () => {
    const provider = new ScriptedProvider([
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
      { text: '收尾。', toolCalls: [] },
      {
        text: '再核一遍。',
        toolCalls: [{ toolCallId: 'c4', toolName: 'read', input: { path: 'release.txt' } }],
      },
      {
        text: '这次真的做完了。',
        toolCalls: [{
          toolCallId: 'c5',
          toolName: 'declare_task',
          // A model that tries to write its own steps: the input is ignored past domain/key/checklist.
          input: {
            action: 'end',
            domain: '发布',
            key: 'npm-publish',
            checklist: true,
            steps: ['编造的步骤'],
            tools: ['fabricated-tool'],
          },
        }],
      },
      { text: '收尾。', toolCalls: [] },
    ]);
    const shell = shellFor('task-procedure-', provider);
    await shell.start();
    try {
      await shell.submit('把发布脚本改好');
      await shell.submit('再把发布脚本核一遍');

      const entry = shell.kernel.procedures.entries({ projectId: shell.config.projectId })
        .find((candidate) => candidate.domain === '发布' && candidate.key === 'npm-publish');
      expect(entry).toBeDefined();
      expect(entry!.grade).toBe('established');
      expect(entry!.support.successes).toBe(2);
      // Every step is a captured call; the invented step and tool never landed.
      expect(entry!.steps).toEqual([
        'write: {"path":"release.txt","content":"ship"}',
        'read: {"path":"release.txt"}',
      ]);
      expect(entry!.tools).toEqual(['write', 'read']);
      expect(entry!.steps.join('\n')).not.toContain('编造的步骤');
      expect(entry!.tools).not.toContain('fabricated-tool');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an end without domain/key writes no descriptor', async () => {
    const provider = new ScriptedProvider([
      { text: '读一下。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'notes.txt' } }] },
      { text: '做完了。', toolCalls: [{ toolCallId: 'c2', toolName: 'declare_task', input: { action: 'end' } }] },
      { text: '收尾。', toolCalls: [] },
    ]);
    const shell = shellFor('task-procedure-empty-', provider);
    await shell.start();
    try {
      await shell.submit('读一下笔记');
      expect(shell.kernel.procedures.entries({ projectId: shell.config.projectId })).toEqual([]);
      expect(shell.trace.read().some((record) => record.kind === 'task_procedure_written')).toBe(false);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

/**
 * #262 D2 producer: at `declare_task end` the model fills domain and key; steps and tools come only
 * from the task's captured `tool_call` rows. The book never records a step the trace does not show.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CheckpointStore } from '../src/state/checkpoint.ts';
import { ScriptedProvider, makeShell, makeTempDir, seedOpenAssignment } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };

const shellAt = (dir: string, provider: ScriptedProvider, contextSweetSpot = 6_000) =>
  makeShell(dir, provider, {
    dream: NO_DREAM,
    contextSweetSpot,
    budgets: { maxTurnsPerRun: 8, maxTokensPerRun: 40_000, toolWhitelist: null },
    workBudget: { maxTurnsPerRun: 8, maxTokensPerRun: 40_000 },
  });

const shellFor = (prefix: string, provider: ScriptedProvider, contextSweetSpot = 6_000) =>
  shellAt(makeTempDir(prefix), provider, contextSweetSpot);

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
      // After the declaration the run continues; this call is not a step of the task it ended.
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
      seedOpenAssignment(shell, '把发布脚本改好');
      await shell.submit('把发布脚本改好');
      seedOpenAssignment(shell, '把发布脚本改好');
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
      expect(entry!.steps.join('\n')).not.toContain('notes.txt');
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
      seedOpenAssignment(shell, '读一下笔记');
      await shell.submit('读一下笔记');
      expect(shell.kernel.procedures.entries({ projectId: shell.config.projectId })).toEqual([]);
      expect(shell.trace.read().some((record) => record.kind === 'task_procedure_written')).toBe(false);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a replay of the same task end leaves one descriptor (#279)', async () => {
    const dir = makeTempDir('task-procedure-replay-');
    const first = shellAt(dir, new ScriptedProvider([
      { text: '读一下。', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'notes.txt' } }] },
      {
        text: '做完了。',
        toolCalls: [{
          toolCallId: 'c2',
          toolName: 'declare_task',
          input: { action: 'end', domain: '发布', key: 'npm-publish' },
        }],
      },
      { text: '收尾。', toolCalls: [] },
    ]));
    await first.start();
    try {
      seedOpenAssignment(first, '读一下笔记');
      await first.submit('读一下笔记');
      const before = first.kernel.procedures.entries({ projectId: first.config.projectId })
        .filter((entry) => entry.origin !== 'imported');
      expect(before).toHaveLength(1);
      expect(before[0]!.support.successes).toBe(1);
    } finally {
      await first.stop();
    }

    // The crash state: the task_event is committed but the checkpoint still carries the pending
    // end, as a kill between the append and the clear would leave it.
    const store = new CheckpointStore(join(dir, 'data'));
    const state = store.load()!;
    state.runtime.lastEndedTask = {
      assignmentId: 'assignment-replay',
      startedAt: 0,
      endedAt: Date.now(),
      procedure: { domain: '发布', key: 'npm-publish', checklist: false },
    };
    store.save(state);

    const second = shellAt(dir, new ScriptedProvider([{ text: '在。', toolCalls: [] }]));
    await second.start();
    try {
      await second.submit('还在吗');
      const after = second.kernel.procedures.entries({ projectId: second.config.projectId })
        .filter((entry) => entry.origin !== 'imported');
      expect(after).toHaveLength(1);
      expect(after[0]!.support.successes).toBe(1);
      expect(second.trace.read().some((record) => record.kind === 'task_procedure_duplicate_skipped')).toBe(true);
    } finally {
      await second.stop();
    }
  }, 30_000);
});

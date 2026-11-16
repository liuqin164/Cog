/**
 * #264 through the resident's real `/correct`. The compiler already read
 * `metadata.procedureCorrection`; this pins the shell path that writes it, and the rule that a
 * proposal is not a correction until the owner confirms it.
 */
import { describe, expect, test } from 'bun:test';

import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const OLD = '发布前先跑测试';
const NEW = '发布前不跑测试';

async function seededShell() {
  const shell = makeShell(makeTempDir(), new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
  await shell.start();
  const projectId = shell.config.projectId;
  // `/correct` books its turn at the real clock, so the practice evidence has to be in the past.
  const base = Date.now() - 60_000;
  for (let index = 0; index < 5; index += 1) {
    shell.kernel.recordTaskEvent({
      projectId,
      threadId: `release-task-${index}`,
      role: 'system',
      content: 'task completed',
      occurredAt: base + 10 + index,
      metadata: {
        procedure: {
          domain: '发布',
          key: 'publish',
          title: '发布 npm 包',
          steps: [OLD, 'bun run build'],
          tools: ['bun'],
          outcome: 'succeeded',
        },
      },
    });
  }
  shell.kernel.procedures.compile({ projectId, now: base + 100 });
  return { shell, projectId, base };
}

describe('/correct on a practice', () => {
  test('an unconfirmed proposal leaves the book untouched, and confirm replaces the practice', async () => {
    const { shell, projectId } = await seededShell();
    try {
      const proposed = await shell.runCommand('correct', `publish ${NEW}`);
      expect(proposed.text).toContain('提议');
      expect(proposed.text).toContain('尚未生效');

      const before = shell.kernel.procedures.entries({ projectId }).filter((entry) => entry.origin !== 'imported');
      expect(before).toHaveLength(1);
      expect(before[0]!.steps).toContain(OLD);
      expect(before[0]!.status).toBe('current');
      expect(shell.kernel.procedures.recall({ projectId, task: '帮我发布 npm 包' })
        .some((entry) => entry.steps.includes(NEW))).toBe(false);

      const confirmed = await shell.runCommand('correct', 'confirm');
      expect(confirmed.text).toContain('已纠正做法');

      const after = shell.kernel.procedures.entries({ projectId }).filter((entry) => entry.origin !== 'imported');
      expect(after).toHaveLength(1);
      expect(after[0]!.steps).toEqual([NEW]);
      expect(after[0]!.origin).toBe('correction');
      expect(after[0]!.grade).toBe('established');
      expect(after[0]!.status).toBe('current');

      const recalled = shell.kernel.procedures.recall({ projectId, task: '帮我发布 npm 包' });
      expect(recalled[0]!.steps).toEqual([NEW]);
      expect(recalled.some((entry) => entry.steps.includes(OLD))).toBe(false);

      const assembly = shell.kernel.procedures.assembleTask({ projectId, task: '帮我发布 npm 包' });
      expect(assembly.text).toContain(NEW);
      expect(assembly.text).not.toContain(OLD);

      // The old practice is not rewritten out of the ledger: it stays as the entry's first version.
      const versions = shell.kernel.procedures.audit({ projectId })
        .filter((row) => row.eventType === 'PROCEDURE_ENTRY_COMPILED' && row.entryId === after[0]!.entryId);
      expect(versions.length).toBe(2);
      expect((versions[0]!.payload as { steps: string[] }).steps).toContain(OLD);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('confirm without a proposal changes nothing and says why', async () => {
    const { shell, projectId } = await seededShell();
    try {
      const reply = await shell.runCommand('correct', 'confirm');
      expect(reply.text).toContain('还没有做法提议');
      expect(shell.kernel.procedures.entries({ projectId }).filter((entry) => entry.origin !== 'imported')[0]!.steps)
        .toContain(OLD);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

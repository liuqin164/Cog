/**
 * #242 through the resident's real `/correct` command. The kernel contract test covers the derived
 * books; this one pins the path the owner actually uses and the default recall that follows it.
 */
import { describe, expect, test } from 'bun:test';

import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 16, 9);

async function startedShell(dir: string) {
  const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
  await shell.start();
  return shell;
}

function preference(
  shell: Awaited<ReturnType<typeof startedShell>>,
  content: string,
  value: string,
  projectId: string,
  occurredAt = T0,
) {
  const turn = shell.kernel.recordRawEvent({
    projectId,
    threadId: `${projectId}-preference`,
    role: 'user',
    content,
    occurredAt,
  });
  shell.kernel.beliefStore.upsert({
    projectId,
    scope: 'project',
    subject: 'owner',
    predicate: 'prefers',
    objectValue: { raw: value, normalized: value, type: 'string' },
    confidence: 0.9,
    sourceType: 'user_input',
    extractionReason: 'preference_signal',
    sourceEventId: turn.eventId,
    validFrom: occurredAt,
  });
}

describe('/correct propagates through the system triggers', () => {
  test('tea: the next default recall has the new value and no old raw statement', async () => {
    const shell = await startedShell(makeTempDir());
    const projectId = shell.config.projectId;
    try {
      preference(shell, '我喜欢喝乌龙茶。', '乌龙茶', projectId);
      shell.kernel.profile.compile({ projectId, now: T0 + 1_000 });
      const entry = shell.kernel.profile.entries({ projectId, ledger: 'preferences' })[0]!;

      const reply = await shell.runCommand('correct', `${entry.key} 红茶`);
      expect(reply.text).toContain('已纠正');

      const recalled = shell.backend.recall({ agentId: shell.config.agentId, projectId, query: '乌龙茶 红茶', limit: 8 });
      const text = recalled.items.map((item) => item.text).join('\n');
      expect(text).toContain('红茶');
      expect(text).not.toContain('乌龙茶');
    } finally {
      await shell.stop();
    }
  });

  test('release: procedure and intention are new or stale after /correct', async () => {
    const shell = await startedShell(makeTempDir());
    const projectId = shell.config.projectId;
    const oldValue = '发布前先跑测试';
    const newValue = '发布前不跑测试';
    // `/correct` books the owner's turn at the real clock, so all prior evidence must be in the
    // past. The kernel test pins both sides; this one has to use wall-clock time.
    const base = Date.now() - 60_000;
    try {
      preference(shell, `${oldValue}。`, oldValue, projectId, base);
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
              steps: [oldValue, 'bun run build'],
              tools: ['bun'],
              outcome: 'succeeded',
            },
          },
        });
      }
      shell.kernel.profile.compile({ projectId, now: base + 100 });
      shell.kernel.procedures.compile({ projectId, now: base + 200 });
      const procedure = shell.kernel.procedures.entries({ projectId })[0]!;
      shell.kernel.recordRawEvent({
        projectId,
        threadId: 'release-intention',
        role: 'assistant',
        content: '我准备下次发布先跑测试再 publish。',
        occurredAt: base + 400,
      });
      shell.kernel.intentions.compile({ projectId, now: base + 500 });

      const entry = shell.kernel.profile.entries({ projectId, ledger: 'preferences' })[0]!;
      const reply = await shell.runCommand('correct', `${entry.key} ${newValue}`);
      expect(reply.text).toContain('已纠正');

      shell.kernel.procedures.compile({ projectId, now: base + 600 });
      shell.kernel.intentions.compile({ projectId, now: base + 610 });
      shell.kernel.runMaintenanceTick({ projectId, now: base + 700 });

      expect(shell.kernel.procedures.entries({ projectId })[0]!.status).toBe('stale');
      expect(shell.kernel.intentions.list({ projectId })[0]!.status).toBe('stale');
      const assembly = shell.kernel.procedures.assembleTask({ projectId, task: '帮我发布 npm 包', now: base + 800 });
      expect(assembly.text).not.toContain(oldValue);
      expect(assembly.text).toContain(newValue);
    } finally {
      await shell.stop();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * #242: one correction is global. The probe found the profile book updated while the procedure book,
 * workflow, intention, Atlas and default recall kept presenting the replaced value as current.
 *
 * Both cases below correct through the same kernel face the shell's `/correct` calls
 * (`kernel.profile.correct`), then run the system's own triggers. The assertions name each derived
 * face: new value, or an explicit stale row — never a silent old value.
 */

const scratch = makeTempDir('cogmem-correction-propagation-');
const dbPath = join(scratch, 'memory.db');
let kernel: MemoryKernel;
let backend: KernelAgentMemoryBackend;

const T0 = Date.UTC(2026, 10, 16, 9);

beforeAll(() => {
  kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  backend = new KernelAgentMemoryBackend(kernel);
});

afterAll(() => {
  kernel.close();
});

function rememberPreference(projectId: string, content: string, value: string, occurredAt: number) {
  const turn = kernel.recordRawEvent({
    projectId,
    threadId: `${projectId}-preference`,
    role: 'user',
    content,
    occurredAt,
  });
  kernel.beliefStore.upsert({
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
  return turn;
}

function recallText(projectId: string, query: string): string {
  return backend.recall({ projectId, agentId: 'hermes', query, limit: 8 }).items
    .map((item) => item.text)
    .join('\n');
}

describe('a corrected preference reaches every subsequent read', () => {
  test('tea: profile, source belief, Atlas and default recall all stop presenting 乌龙茶 as current', () => {
    const projectId = 'correction-tea';
    rememberPreference(projectId, '我喜欢喝乌龙茶。', '乌龙茶', T0);
    kernel.profile.compile({ projectId, now: T0 + 1_000 });
    const entry = kernel.profile.entries({ projectId, ledger: 'preferences' })
      .find((candidate) => candidate.value === '乌龙茶');
    expect(entry).toBeDefined();

    const correction = kernel.recordRawEvent({
      projectId,
      threadId: `${projectId}-correction`,
      role: 'user',
      content: '现在喜欢红茶。',
      occurredAt: T0 + 2_000,
    });
    kernel.profile.correct({
      projectId,
      ledger: 'preferences',
      key: entry!.key,
      value: '红茶',
      correctionEventId: correction.eventId,
      now: T0 + 3_000,
    });

    expect(kernel.profile.entries({ projectId, ledger: 'preferences' }).map((candidate) => candidate.value))
      .toEqual(['红茶']);
    expect(kernel.profile.history({ projectId, entryId: entry!.entryId }).map((version) => version.status))
      .toEqual(['current', 'superseded']);

    const beliefs = kernel.beliefStore.findByCanonicalKey(entry!.key, projectId);
    expect(beliefs.some((belief) => belief.status === 'active' && String(belief.objectValue.raw) === '红茶')).toBe(true);
    expect(beliefs.some((belief) => belief.status === 'superseded' && String(belief.objectValue.raw) === '乌龙茶')).toBe(true);

    kernel.runMaintenanceTick({ projectId, now: T0 + 4_000 });
    const atlas = kernel.factStore.getDatabase().prepare(
      `SELECT label, status FROM memory_atlas_documents WHERE project_id=? AND node_type='belief'`,
    ).all(projectId) as Array<{ label: string; status: string }>;
    expect(atlas.some((row) => row.status === 'active' && row.label.includes('红茶'))).toBe(true);
    expect(atlas.some((row) => row.status === 'active' && row.label.includes('乌龙茶'))).toBe(false);

    const text = recallText(projectId, '乌龙茶 红茶');
    expect(text).toContain('红茶');
    expect(text).not.toContain('乌龙茶');
  });
});

describe('a corrected practice cannot leave an old plan current', () => {
  test('release: procedure, workflow, intention, Atlas and assembly are new or explicitly stale', () => {
    const projectId = 'correction-release';
    const oldValue = '发布前先跑测试';
    const newValue = '发布前不跑测试';
    const preferenceTurn = rememberPreference(projectId, `${oldValue}。`, oldValue, T0);

    for (let index = 0; index < 5; index += 1) {
      kernel.recordTaskEvent({
        projectId,
        threadId: `release-task-${index}`,
        role: 'system',
        content: 'task completed',
        occurredAt: T0 + 10 + index,
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
    kernel.profile.compile({ projectId, now: T0 + 100 });
    kernel.procedures.compile({ projectId, now: T0 + 200 });
    const procedure = kernel.procedures.entries({ projectId })[0]!;
    expect(procedure.status).toBe('current');

    const workflow = kernel.workflows.propose({
      projectId,
      entryId: procedure.entryId,
      steps: [{ tool: 'bash', args: { command: 'bun test' }, success: { type: 'not_error' } }],
      now: T0 + 300,
    });
    kernel.workflows.dryRun({ projectId, entryId: workflow.entryId, passed: true, reason: 'rehearsed', now: T0 + 310 });
    expect(kernel.workflows.activate({ projectId, entryId: workflow.entryId, now: T0 + 320 }).status).toBe('active');

    kernel.recordRawEvent({
      projectId,
      threadId: 'release-intention',
      role: 'assistant',
      content: '我准备下次发布先跑测试再 publish。',
      occurredAt: T0 + 400,
    });
    kernel.intentions.compile({ projectId, now: T0 + 500 });
    expect(kernel.intentions.list({ projectId })[0]?.status).toBe('active');

    const correction = kernel.recordRawEvent({
      projectId,
      threadId: 'release-correction',
      role: 'user',
      content: newValue,
      occurredAt: T0 + 600,
    });
    const entry = kernel.profile.entries({ projectId, ledger: 'preferences' })
      .find((candidate) => candidate.value === oldValue)!;
    kernel.profile.correct({
      projectId,
      ledger: 'preferences',
      key: entry.key,
      value: newValue,
      correctionEventId: correction.eventId,
      now: T0 + 700,
    });

    // The system's own triggers, the same ones the probe ran.
    kernel.procedures.compile({ projectId, now: T0 + 800 });
    kernel.intentions.compile({ projectId, now: T0 + 810 });
    const tick = kernel.runMaintenanceTick({ projectId, now: T0 + 900 });

    const staleProcedure = kernel.procedures.entries({ projectId })[0]!;
    expect(staleProcedure.status).toBe('stale');
    expect(staleProcedure.steps).toContain(oldValue);
    expect(kernel.procedures.recall({ projectId, task: '帮我发布 npm 包', now: T0 + 1_000 })).toEqual([]);

    const assembly = kernel.procedures.assembleTask({ projectId, task: '帮我发布 npm 包', now: T0 + 1_000 });
    expect(assembly.items.some((item) => item.kind === 'procedure')).toBe(false);
    expect(assembly.items.some((item) => item.kind === 'preference' && item.text.includes(newValue))).toBe(true);
    expect(assembly.text).not.toContain(oldValue);

    const staleWorkflow = kernel.workflows.list({ projectId })[0]!;
    expect(staleWorkflow.status).toBe('stale');
    expect(staleWorkflow.staleReason).toBe('source_corrected');
    expect(staleWorkflow.steps).toEqual(workflow.steps);
    expect(kernel.workflows.match({ projectId, task: '帮我发布 npm 包' })).toBeUndefined();
    expect(tick.executed.workflowsMarkedStale).toBe(1);
    expect(kernel.workflows.audit({ projectId }).some((row) => row.eventType === 'PROCEDURE_WORKFLOW_STALE')).toBe(true);

    const intention = kernel.intentions.list({ projectId })[0]!;
    expect(intention.status).toBe('stale');
    expect(kernel.intentions.activeForAgent({ projectId, agentId: 'hermes', now: T0 + 1_000 })).toEqual([]);

    const beliefs = kernel.beliefStore.findByCanonicalKey(entry.key, projectId);
    expect(beliefs.some((belief) => belief.status === 'active' && String(belief.objectValue.raw) === newValue)).toBe(true);
    expect(beliefs.some((belief) => belief.status === 'superseded' && String(belief.objectValue.raw) === oldValue)).toBe(true);
    const atlas = kernel.factStore.getDatabase().prepare(
      `SELECT label, status FROM memory_atlas_documents WHERE project_id=? AND node_type='belief'`,
    ).all(projectId) as Array<{ label: string; status: string }>;
    expect(atlas.some((row) => row.status === 'active' && row.label.includes(newValue))).toBe(true);
    expect(atlas.some((row) => row.status === 'active' && row.label.includes(oldValue))).toBe(false);

    const text = recallText(projectId, oldValue);
    expect(text).toContain(newValue);
    expect(text).not.toContain('我准备下次发布先跑测试');
    expect(text).not.toContain(preferenceTurn.eventId);
  });
});

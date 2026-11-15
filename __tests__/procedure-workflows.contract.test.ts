import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { startObservatoryServer } from '../src/observatory/HttpServer.js';
import {
  WORKFLOW_API_METHODS,
  WORKFLOW_CONTRACT_VERSION,
  WORKFLOW_ERROR_CODES,
  WORKFLOW_EVENT_TYPES,
  WORKFLOW_FAILURE_DEMOTION_THRESHOLD,
  WORKFLOW_PROMOTION_EXTRA_SUCCESSES,
  WORKFLOW_STATUSES,
  WORKFLOW_SUCCESS_TYPES,
  WORKFLOW_TEMPLATE_SLOTS,
  validateWorkflowSteps,
  workflowDraftHash,
  type WorkflowStep,
} from '../src/procedure/index.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * The procedure-workflow contract (#228, item 4), asserted against the document it claims to
 * implement.
 *
 * The acceptance is structural and behavioural: a workflow is a literal-only step sequence, the
 * dry-run is a gate, the owner can veto one draft without vetoing every future one, consecutive
 * execution failures demote it, and the procedure entry it came from is never edited.
 */

const scratch = makeTempDir('cogmem-workflow-contract-');
const dbPath = join(scratch, 'memory.db');
let kernel: MemoryKernel;

beforeAll(() => {
  kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
});

afterAll(() => {
  kernel.close();
});

const markdown = readFileSync(fileURLToPath(new URL('../docs/procedure-workflows.md', import.meta.url)), 'utf8');

function sectionAfter(heading: string): string {
  return markdown.split(heading)[1]?.split(/\n#{2,3} /)[0] ?? '';
}

function backtickedFirstColumn(section: string): string[] {
  return [...section.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9_.-]*)`/gmu)].map((match) => match[1]!);
}

function experience(input: {
  projectId: string;
  threadId: string;
  domain?: string;
  key?: string;
  title?: string;
  steps?: string[];
  tools?: string[];
  outcome?: 'succeeded' | 'failed';
  occurredAt?: number;
}) {
  return kernel.recordTaskEvent({
    projectId: input.projectId,
    threadId: input.threadId,
    role: 'system',
    content: 'task completed',
    occurredAt: input.occurredAt,
    metadata: {
      procedure: {
        domain: input.domain ?? '发布',
        key: input.key ?? 'publish',
        title: input.title ?? '发布 npm 包',
        steps: input.steps ?? ['跑测试', 'bun run build', 'npm publish'],
        tools: input.tools ?? ['bun', 'npm'],
        outcome: input.outcome ?? 'succeeded',
      },
    },
  });
}

function establish(projectId: string, successes = 5): string {
  for (let index = 0; index < successes; index += 1) {
    experience({ projectId, threadId: `t-${index}`, occurredAt: 1_000 + index });
  }
  kernel.procedures.compile({ projectId, now: 2_000 });
  const entry = kernel.procedures.entries({ projectId })[0];
  expect(entry).toBeDefined();
  return entry!.entryId;
}

const steps: WorkflowStep[] = [
  { tool: 'read', args: { path: 'README.md' }, success: { type: 'not_error' } },
  { tool: 'bash', args: { command: 'bun test' }, success: { type: 'output_contains', text: 'pass' } },
];

function propose(projectId: string, entryId: string, draft: unknown = steps) {
  return kernel.workflows.propose({ projectId, entryId, steps: draft, now: 3_000 });
}

function passDryRun(projectId: string, entryId: string) {
  return kernel.workflows.dryRun({ projectId, entryId, passed: true, reason: 'rehearsed', now: 3_100 });
}

function activate(projectId: string, entryId: string) {
  return kernel.workflows.activate({ projectId, entryId, now: 3_200 });
}

describe('the contract document and the frozen lists agree', () => {
  test('the status, success-type and slot tables are exactly their frozen lists, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## Statuses (frozen)'))).toEqual([...WORKFLOW_STATUSES]);
    expect(backtickedFirstColumn(sectionAfter('## Success criteria (frozen)'))).toEqual([...WORKFLOW_SUCCESS_TYPES]);
    expect(backtickedFirstColumn(sectionAfter('## Template slots (frozen)'))).toEqual([...WORKFLOW_TEMPLATE_SLOTS]);
  });

  test('the face table is exactly WORKFLOW_API_METHODS, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## The face (frozen)'))).toEqual([...WORKFLOW_API_METHODS]);
  });

  test('the event table is exactly WORKFLOW_EVENT_TYPES, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## Book events (frozen)'))).toEqual([...WORKFLOW_EVENT_TYPES]);
  });

  test('the error table is exactly WORKFLOW_ERROR_CODES, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## Errors (frozen)'))).toEqual([...WORKFLOW_ERROR_CODES]);
  });

  test('every frozen method exists, the version is 1, and the thresholds are the documented ones', () => {
    expect(WORKFLOW_CONTRACT_VERSION).toBe(1);
    for (const method of WORKFLOW_API_METHODS) {
      expect(typeof (kernel.workflows as unknown as Record<string, unknown>)[method]).toBe('function');
    }
    expect(WORKFLOW_PROMOTION_EXTRA_SUCCESSES).toBe(3);
    expect(WORKFLOW_FAILURE_DEMOTION_THRESHOLD).toBe(2);
    expect(markdown).toContain('WORKFLOW_PROMOTION_EXTRA_SUCCESSES');
    expect(markdown).toContain('WORKFLOW_FAILURE_DEMOTION_THRESHOLD');
  });
});

describe('eligibility is the book\'s, not the caller\'s', () => {
  test('a tentative practice is refused before its steps are even read', () => {
    const projectId = 'workflow-tentative';
    experience({ projectId, threadId: 't-1', occurredAt: 1_000 });
    kernel.procedures.compile({ projectId, now: 1_100 });
    const entryId = kernel.procedures.entries({ projectId })[0]!.entryId;
    expect(() => propose(projectId, entryId)).toThrow('workflow_not_established');
  });

  test('established is not enough: the practice must be reproduced three more times', () => {
    const projectId = 'workflow-not-enough';
    const entryId = establish(projectId, 2);
    expect(() => propose(projectId, entryId)).toThrow('workflow_not_enough_executions');
    experience({ projectId, threadId: 't-extra-1', occurredAt: 1_500 });
    experience({ projectId, threadId: 't-extra-2', occurredAt: 1_600 });
    experience({ projectId, threadId: 't-extra-3', occurredAt: 1_700 });
    kernel.procedures.compile({ projectId, now: 1_800 });
    expect(propose(projectId, entryId).status).toBe('proposed');
  });

  test('the owner\'s correction is established but is not an own practice to freeze', () => {
    const projectId = 'workflow-correction';
    kernel.recordRawEvent({
      threadId: 't-correct',
      projectId,
      role: 'user',
      content: '不要直接 npm publish，先跑 bun run build。',
      metadata: { procedureCorrection: { domain: '发布', key: 'publish' } },
    });
    kernel.procedures.compile({ projectId, now: 1_000 });
    const entry = kernel.procedures.entries({ projectId })[0]!;
    expect(entry.origin).toBe('correction');
    expect(entry.grade).toBe('established');
    expect(() => propose(projectId, entry.entryId)).toThrow('workflow_not_promotable');
  });

  test('a proposal quotes the entry\'s evidence and starts at version 1', () => {
    const projectId = 'workflow-proposal';
    const entryId = establish(projectId);
    const entry = kernel.procedures.entries({ projectId })[0]!;
    const proposed = propose(projectId, entryId);
    expect(proposed.status).toBe('proposed');
    expect(proposed.version).toBe(1);
    expect(proposed.sourceRefs).toEqual(entry.sourceRefs);
    expect(proposed.draftHash).toBe(workflowDraftHash(steps));
  });

  test('a second proposal while one is pending is refused; an active one cannot be proposed over', () => {
    const projectId = 'workflow-pending';
    const entryId = establish(projectId);
    propose(projectId, entryId);
    expect(() => propose(projectId, entryId)).toThrow('workflow_proposal_pending');
    passDryRun(projectId, entryId);
    activate(projectId, entryId);
    expect(() => propose(projectId, entryId)).toThrow('workflow_already_active');
  });
});

describe('the red line is machine-checked', () => {
  const valid = (overrides: Record<string, unknown>) => [{ tool: 'read', args: { path: 'README.md' }, success: { type: 'not_error' }, ...overrides }];

  test('a branch field is not a step field, so it is refused', () => {
    expect(() => validateWorkflowSteps(valid({ branch: { if: 'x', then: 'y' } }))).toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps(valid({ if: 'x' }))).toThrow('workflow_invalid_steps');
  });

  test('only the two frozen slots resolve; a model-computed argument cannot be expressed', () => {
    expect(validateWorkflowSteps([{ tool: 'read', args: { path: '{{task}}', workspace: '{{workspace}}' }, success: { type: 'not_error' } }]))
      .toHaveLength(1);
    expect(() => validateWorkflowSteps([{ tool: 'read', args: { path: '{{model}}' }, success: { type: 'not_error' } }]))
      .toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps([{ tool: 'read', args: { path: '{{task' }, success: { type: 'not_error' } }]))
      .toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps([{ tool: 'read', args: { path: { from: 'model' } }, success: { type: 'not_error' } }]))
      .toThrow('workflow_invalid_steps');
  });

  test('a success criterion is literal-only and takes exactly its own fields', () => {
    expect(() => validateWorkflowSteps([{ tool: 'bash', args: {}, success: { type: 'output_contains', text: '{{task}}' } }]))
      .toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps([{ tool: 'bash', args: {}, success: { type: 'not_error', text: 'x' } }]))
      .toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps([{ tool: 'bash', args: {}, success: { type: 'exit_code', value: 0 } }]))
      .toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps([{ tool: 'bash', args: {}, success: { type: 'output_contains' } }]))
      .toThrow('workflow_invalid_steps');
  });

  test('the step count and the step fields are bounded', () => {
    const thirteen = Array.from({ length: 13 }, () => ({ tool: 'read', args: {}, success: { type: 'not_error' } }));
    expect(() => validateWorkflowSteps(thirteen)).toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps([])).toThrow('workflow_steps_required');
    expect(() => validateWorkflowSteps([{ tool: 'read', args: {} }])).toThrow('workflow_invalid_steps');
    expect(() => validateWorkflowSteps([{ tool: '', args: {}, success: { type: 'not_error' } }])).toThrow('workflow_invalid_steps');
  });

  test('the draft hash ignores argument key order and changes when the draft changes', () => {
    const left: WorkflowStep[] = [{ tool: 'write', args: { path: 'a', content: 'b' }, success: { type: 'not_error' } }];
    const right: WorkflowStep[] = [{ tool: 'write', args: { content: 'b', path: 'a' }, success: { type: 'not_error' } }];
    const changed: WorkflowStep[] = [{ tool: 'write', args: { path: 'a', content: 'c' }, success: { type: 'not_error' } }];
    expect(workflowDraftHash(left)).toBe(workflowDraftHash(right));
    expect(workflowDraftHash(left)).not.toBe(workflowDraftHash(changed));
  });
});

describe('the dry-run gates activation', () => {
  test('activation without a verdict, and with a failed verdict, is refused', () => {
    const projectId = 'workflow-dry-run';
    const entryId = establish(projectId);
    propose(projectId, entryId);
    expect(() => activate(projectId, entryId)).toThrow('workflow_dry_run_required');
    kernel.workflows.dryRun({ projectId, entryId, passed: false, reason: 'step 1: unknown_tool', now: 3_100 });
    expect(() => activate(projectId, entryId)).toThrow('workflow_dry_run_failed');
    passDryRun(projectId, entryId);
    const active = activate(projectId, entryId);
    expect(active.status).toBe('active');
    expect(active.dryRun?.passed).toBe(true);
  });

  test('a verdict is recorded against the current proposal only', () => {
    const projectId = 'workflow-dry-run-missing';
    expect(() => kernel.workflows.dryRun({ projectId, entryId: 'missing', passed: true })).toThrow('workflow_not_proposed');
  });
});

describe('the owner can veto one draft without vetoing the practice', () => {
  test('a veto names an owner turn, refuses the same draft, and allows a materially different one', () => {
    const projectId = 'workflow-veto';
    const entryId = establish(projectId);
    const ownerTurn = kernel.recordRawEvent({ projectId, threadId: 't-veto', role: 'user', content: '这个工作流不要。', occurredAt: 2_500 });
    propose(projectId, entryId);
    const vetoed = kernel.workflows.veto({ projectId, entryId, vetoEventId: ownerTurn.eventId, now: 3_000 });
    expect(vetoed.status).toBe('vetoed');
    expect(vetoed.vetoEventId).toBe(ownerTurn.eventId);
    expect(() => propose(projectId, entryId)).toThrow('workflow_version_refused');
    const revised = propose(projectId, entryId, [{ tool: 'read', args: { path: 'package.json' }, success: { type: 'not_error' } }]);
    expect(revised.version).toBe(2);
    expect(revised.status).toBe('proposed');
  });

  test('a veto needs real evidence in the same project', () => {
    const projectId = 'workflow-veto-evidence';
    const entryId = establish(projectId);
    propose(projectId, entryId);
    expect(() => kernel.workflows.veto({ projectId, entryId, vetoEventId: 'no-such-event' })).toThrow('invalid_workflow_evidence');
    const elsewhere = kernel.recordRawEvent({ projectId: 'another-project', threadId: 't-x', role: 'user', content: 'no' });
    expect(() => kernel.workflows.veto({ projectId, entryId, vetoEventId: elsewhere.eventId })).toThrow('invalid_workflow_evidence');
  });
});

describe('consecutive failures demote and propose revocation', () => {
  test('one failure keeps it active, a success resets the streak, two failures demote it', () => {
    const projectId = 'workflow-demotion';
    const entryId = establish(projectId);
    propose(projectId, entryId);
    passDryRun(projectId, entryId);
    activate(projectId, entryId);
    const evidence = kernel.recordRawEvent({ projectId, threadId: 't-run', role: 'system', content: 'workflow ran', occurredAt: 4_000 });
    const ref = {
      eventId: evidence.eventId,
      eventType: evidence.rawEventType || evidence.eventType,
      role: evidence.role,
      threadId: evidence.threadId,
      sessionId: evidence.sessionId,
      turnId: evidence.turnId,
    };
    const first = kernel.workflows.recordExecution({ projectId, entryId, outcome: 'failed', failedStep: 2, sourceRefs: [ref], now: 4_100 });
    expect(first.status).toBe('active');
    expect(first.consecutiveFailures).toBe(1);
    expect(first.lastExecutionRefs).toEqual([ref]);
    const recovered = kernel.workflows.recordExecution({ projectId, entryId, outcome: 'succeeded', sourceRefs: [ref], now: 4_200 });
    expect(recovered.consecutiveFailures).toBe(0);
    kernel.workflows.recordExecution({ projectId, entryId, outcome: 'failed', sourceRefs: [ref], now: 4_300 });
    const demoted = kernel.workflows.recordExecution({ projectId, entryId, outcome: 'failed', sourceRefs: [ref], now: 4_400 });
    expect(demoted.status).toBe('downgraded');
    expect(demoted.consecutiveFailures).toBe(2);
    expect(demoted.demotedAt).toBe(4_400);
    expect(demoted.revocationProposedAt).toBe(4_400);
    expect(() => kernel.workflows.recordExecution({ projectId, entryId, outcome: 'failed', sourceRefs: [ref] })).toThrow('workflow_not_active');
  });

  test('the demoted draft is refused and a different draft becomes version 2', () => {
    const projectId = 'workflow-demotion-redraft';
    const entryId = establish(projectId);
    propose(projectId, entryId);
    passDryRun(projectId, entryId);
    activate(projectId, entryId);
    kernel.workflows.recordExecution({ projectId, entryId, outcome: 'failed', sourceRefs: [], now: 4_100 });
    kernel.workflows.recordExecution({ projectId, entryId, outcome: 'failed', sourceRefs: [], now: 4_200 });
    expect(() => propose(projectId, entryId)).toThrow('workflow_version_refused');
    const revised = propose(projectId, entryId, [{ tool: 'read', args: { path: 'package.json' }, success: { type: 'not_error' } }]);
    expect(revised.version).toBe(2);
  });
});

describe('match and audit read the same ledger', () => {
  test('an active workflow matches its domain and an unrelated task matches nothing', () => {
    const projectId = 'workflow-match';
    const entryId = establish(projectId);
    propose(projectId, entryId);
    passDryRun(projectId, entryId);
    activate(projectId, entryId);
    expect(kernel.workflows.match({ projectId, task: '帮我发布 npm 包' })?.entryId).toBe(entryId);
    expect(kernel.workflows.match({ projectId, task: '今天天气怎么样' })).toBeUndefined();
    expect(kernel.workflows.list({ projectId, status: 'active' }).map((workflow) => workflow.entryId)).toEqual([entryId]);
    expect(kernel.workflows.list({ projectId, status: 'vetoed' })).toEqual([]);
  });

  test('the audit is the workflow rows, oldest first, and the entry is untouched', () => {
    const projectId = 'workflow-audit';
    const entryId = establish(projectId);
    const before = kernel.procedures.entries({ projectId })[0]!;
    propose(projectId, entryId);
    passDryRun(projectId, entryId);
    activate(projectId, entryId);
    kernel.workflows.recordExecution({ projectId, entryId, outcome: 'failed', failedStep: 1, sourceRefs: [], now: 4_000 });
    const audit = kernel.workflows.audit({ projectId });
    expect(audit.map((row) => row.eventType)).toEqual([
      'PROCEDURE_WORKFLOW_PROPOSED',
      'PROCEDURE_WORKFLOW_DRY_RUN',
      'PROCEDURE_WORKFLOW_ACTIVATED',
      'PROCEDURE_WORKFLOW_EXECUTED',
    ]);
    expect(audit.every((row) => (WORKFLOW_EVENT_TYPES as readonly string[]).includes(row.eventType))).toBe(true);
    const after = kernel.procedures.entries({ projectId })[0]!;
    expect(after).toEqual(before);
    expect(kernel.procedures.audit({ projectId }).every((row) => !row.eventType.startsWith('PROCEDURE_WORKFLOW_'))).toBe(true);
  });
});

describe('the book survives a restart', () => {
  test('a second kernel on the same file reads the same status and history', () => {
    const dir = makeTempDir('cogmem-workflow-restart-');
    const file = join(dir, 'memory.db');
    const projectId = 'workflow-restart';
    const first = createMemoryKernel({ dbPath: file, projectTimeZone: 'UTC' });
    try {
      for (let index = 0; index < 5; index += 1) {
        first.recordTaskEvent({
          projectId,
          threadId: `t-${index}`,
          role: 'system',
          content: 'task completed',
          occurredAt: 1_000 + index,
          metadata: { procedure: { domain: '发布', key: 'publish', title: '发布 npm 包', steps: ['跑测试'], tools: ['bun'], outcome: 'succeeded' } },
        });
      }
      first.procedures.compile({ projectId, now: 2_000 });
      const entryId = first.procedures.entries({ projectId })[0]!.entryId;
      first.workflows.propose({ projectId, entryId, steps, now: 3_000 });
      first.workflows.dryRun({ projectId, entryId, passed: true, now: 3_100 });
      first.workflows.activate({ projectId, entryId, now: 3_200 });
    } finally {
      first.close();
    }
    const second = createMemoryKernel({ dbPath: file, projectTimeZone: 'UTC' });
    try {
      const [workflow] = second.workflows.list({ projectId });
      expect(workflow?.status).toBe('active');
      expect(workflow?.steps).toEqual(steps);
      expect(second.workflows.audit({ projectId })).toHaveLength(3);
    } finally {
      second.close();
    }
  });
});

describe('the observatory reads the same ledger', () => {
  test('the workflow page and its JSON are served from the kernel rows and write nothing', async () => {
    const projectId = 'workflow-observatory';
    const entryId = establish(projectId);
    propose(projectId, entryId);
    passDryRun(projectId, entryId);
    activate(projectId, entryId);
    const handle = await startObservatoryServer({ kernel, port: 0 });
    try {
      const base = handle.url.replace(/\/$/u, '');
      const json = await (await fetch(`${base}/workflows.json?project=${projectId}`)).json() as {
        projectId: string;
        workflows: Array<{ eventType: string }>;
      };
      expect(json.projectId).toBe(projectId);
      expect(json.workflows.map((row) => row.eventType)).toEqual([
        'PROCEDURE_WORKFLOW_PROPOSED',
        'PROCEDURE_WORKFLOW_DRY_RUN',
        'PROCEDURE_WORKFLOW_ACTIVATED',
      ]);
      const page = await fetch(`${base}/workflows`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('工作流观测台');
    } finally {
      handle.stop();
    }
  });
});

/**
 * Procedure promotion (#228, item 4): an established practice may be promoted into a deterministic
 * workflow — a fixed sequence of tool calls — and executed without a model deciding each step.
 *
 * This is the execution layer, not the compiler. `ProcedureCompiler` keeps deriving entries from the
 * same evidence and its frozen contract is untouched; this book writes its own `PROCEDURE_WORKFLOW_*`
 * rows on `procedure-workflow:<entryId>` and never a `PROCEDURE_ENTRY_*` row. The procedure entry
 * stays: a workflow is one execution form of the practice, not a replacement for it.
 *
 * Promotion is proposed, never automatic. A proposal needs an `experience` entry that is
 * `established` and has `PROCEDURE_ESTABLISHED_SUCCESSES + WORKFLOW_PROMOTION_EXTRA_SUCCESSES`
 * successes, so the practice has been reproduced after it was established. The owner may veto it;
 * a vetoed draft is never proposed again, though a materially different draft may be.
 *
 * The red line is structural and machine-checked in {@link validateWorkflowSteps}: a step is exactly
 * `{ tool, args, success }`, every argument is a literal or a frozen `{{task}}` / `{{workspace}}`
 * slot, and a success criterion is `not_error` or a literal `output_contains`. There is nowhere to
 * put a branch and no way to make a step depend on text the model computed at run time.
 *
 * The dry-run is recorded, not performed here: the shell owns the tools and rehearses the steps with
 * no side effects, then records the verdict. `activate` refuses without a passed dry-run for the
 * current version, and a failed one keeps its reason in the ledger.
 */
import { createHash } from 'node:crypto';

import { profileCues } from '../profile/ProfileCompiler.js';
import type { EventStore } from '../store/EventStore.js';
import type { MemoryEvent, MemorySourceRef } from '../types/index.js';
import {
  PROCEDURE_ESTABLISHED_SUCCESSES,
  type ProcedureCompiler,
  type ProcedureEntry,
} from './ProcedureCompiler.js';

export const WORKFLOW_CONTRACT_VERSION = 1;

/**
 * The N in "established, then successful N more times". Establishment is two successes; three
 * further successful executions (five in total) is the point where the steps have survived enough
 * independent tasks to be worth freezing. Two more would promote on one repeated streak, four more
 * would delay the token saving past the useful life of most practices.
 */
export const WORKFLOW_PROMOTION_EXTRA_SUCCESSES = 3;

/** Consecutive workflow execution failures before it is demoted and revocation is proposed. */
export const WORKFLOW_FAILURE_DEMOTION_THRESHOLD = 2;

/** The values a step argument may take from the run's frozen context. Nothing else is resolvable. */
export const WORKFLOW_TEMPLATE_SLOTS = ['task', 'workspace'] as const;
export type WorkflowTemplateSlot = (typeof WORKFLOW_TEMPLATE_SLOTS)[number];

export const WORKFLOW_STATUSES = ['proposed', 'active', 'vetoed', 'downgraded', 'stale'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_SUCCESS_TYPES = ['not_error', 'output_contains'] as const;
export type WorkflowSuccessType = (typeof WORKFLOW_SUCCESS_TYPES)[number];

/** The ledger event types this book writes. Frozen. */
export const WORKFLOW_EVENT_TYPES = [
  'PROCEDURE_WORKFLOW_PROPOSED',
  'PROCEDURE_WORKFLOW_DRY_RUN',
  'PROCEDURE_WORKFLOW_ACTIVATED',
  'PROCEDURE_WORKFLOW_VETOED',
  'PROCEDURE_WORKFLOW_EXECUTED',
  'PROCEDURE_WORKFLOW_DEMOTED',
  'PROCEDURE_WORKFLOW_STALE',
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/** The book's methods. Frozen; adding one is additive, removing or renaming one is not. */
export const WORKFLOW_API_METHODS = [
  'propose',
  'dryRun',
  'activate',
  'veto',
  'recordExecution',
  'reconcileStale',
  'match',
  'list',
  'audit',
] as const;

export const WORKFLOW_ERROR_CODES = [
  'project_id_required',
  'workflow_entry_required',
  'workflow_entry_unknown',
  'workflow_not_established',
  'workflow_not_promotable',
  'workflow_not_enough_executions',
  'workflow_steps_required',
  'workflow_invalid_steps',
  'workflow_already_active',
  'workflow_proposal_pending',
  'workflow_version_refused',
  'workflow_not_proposed',
  'workflow_dry_run_required',
  'workflow_dry_run_failed',
  'workflow_not_active',
  'workflow_evidence_required',
  'invalid_workflow_evidence',
  'workflow_task_required',
] as const;
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];

export type WorkflowArgument = string | number | boolean;

export interface WorkflowSuccessCriterion {
  type: WorkflowSuccessType;
  /** Required by `output_contains`; a literal, never a template. */
  text?: string;
}

export interface WorkflowStep {
  tool: string;
  args: Record<string, WorkflowArgument>;
  success: WorkflowSuccessCriterion;
}

export interface WorkflowDryRun {
  passed: boolean;
  reason?: string;
  at: number;
}

export interface ProcedureWorkflow {
  workflowId: string;
  projectId: string;
  /** The procedure entry this workflow executes. The entry itself is never edited. */
  entryId: string;
  /** The entry version the draft was written from. */
  procedureVersion: number;
  /** The workflow's own version: +1 per materially different draft. */
  version: number;
  domain: string;
  key: string;
  title: string;
  steps: WorkflowStep[];
  status: WorkflowStatus;
  /** The executions that qualified the proposal, quoted from the procedure entry. */
  sourceRefs: MemorySourceRef[];
  /** The draft's canonical hash; a veto or demotion refuses this exact draft again. */
  draftHash: string;
  proposedAt: number;
  activatedAt?: number;
  vetoedAt?: number;
  vetoEventId?: string;
  demotedAt?: number;
  /** Set together with `demotedAt`: the demotion also proposes revoking the workflow. */
  revocationProposedAt?: number;
  /** Set when the procedure entry this workflow executes was corrected out from under it. */
  staleAt?: number;
  staleReason?: 'source_corrected';
  dryRun?: WorkflowDryRun;
  executions: number;
  consecutiveFailures: number;
  lastOutcome?: 'succeeded' | 'failed';
  lastExecutedAt?: number;
  /** The evidence of the latest execution; `sourceRefs` stays the promotion evidence. */
  lastExecutionRefs?: MemorySourceRef[];
}

export interface WorkflowProposeInput {
  projectId: string;
  entryId: string;
  steps: unknown;
  now?: number;
}

export interface WorkflowDryRunInput {
  projectId: string;
  entryId: string;
  passed: boolean;
  reason?: string;
  now?: number;
}

export interface WorkflowActivateInput {
  projectId: string;
  entryId: string;
  now?: number;
}

export interface WorkflowVetoInput {
  projectId: string;
  entryId: string;
  /** The owner's turn that carries the veto. */
  vetoEventId: string;
  now?: number;
}

export interface WorkflowExecutionInput {
  projectId: string;
  entryId: string;
  outcome: 'succeeded' | 'failed';
  failedStep?: number;
  sourceRefs: MemorySourceRef[];
  now?: number;
}

export interface WorkflowMatchInput {
  projectId: string;
  task: string;
}

export interface WorkflowListInput {
  projectId: string;
  status?: WorkflowStatus;
}

export interface WorkflowAuditEntry {
  entryId: string;
  eventType: WorkflowEventType;
  payload: Record<string, unknown>;
  occurredAt: number;
}

export interface ProcedureWorkflowPorts {
  events: EventStore;
  procedures: ProcedureCompiler;
}

const MAX_WORKFLOW_STEPS = 12;
const MAX_WORKFLOW_ROWS = 2000;
const LEDGER_PAGE_SIZE = 500;
const STEP_FIELDS = ['tool', 'args', 'success'] as const;
const SLOT_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/gu;

function workflowError(code: WorkflowErrorCode, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code);
}

function requiredText(value: string | undefined, code: WorkflowErrorCode): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw workflowError(code);
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The red line, machine-checked: the field whitelist leaves no place for a branch, every argument is
 * a literal or a frozen slot, and a success criterion is one of two literal-only shapes.
 */
export function validateWorkflowSteps(input: unknown): WorkflowStep[] {
  if (!Array.isArray(input) || input.length === 0) throw workflowError('workflow_steps_required');
  if (input.length > MAX_WORKFLOW_STEPS) {
    throw workflowError('workflow_invalid_steps', `${input.length} steps (max ${MAX_WORKFLOW_STEPS})`);
  }
  return input.map((raw, index) => {
    if (!isPlainObject(raw)) throw workflowError('workflow_invalid_steps', `step ${index} is not an object`);
    const keys = Object.keys(raw).sort();
    const allowed = [...STEP_FIELDS].sort();
    if (keys.length !== allowed.length || keys.some((key, position) => key !== allowed[position])) {
      throw workflowError('workflow_invalid_steps', `step ${index} must have exactly tool, args and success (no branch fields)`);
    }
    const tool = typeof raw.tool === 'string' ? raw.tool.trim() : '';
    if (!tool) throw workflowError('workflow_invalid_steps', `step ${index} names no tool`);
    if (!isPlainObject(raw.args)) throw workflowError('workflow_invalid_steps', `step ${index} args must be an object`);
    const args: Record<string, WorkflowArgument> = {};
    for (const [name, value] of Object.entries(raw.args)) {
      args[name] = validateArgument(value, index, name);
    }
    return { tool, args, success: validateSuccess(raw.success, index) };
  });
}

function validateArgument(value: unknown, step: number, name: string): WorkflowArgument {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw workflowError('workflow_invalid_steps', `step ${step} arg "${name}" is not finite`);
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw workflowError('workflow_invalid_steps', `step ${step} arg "${name}" must be a literal string, number or boolean`);
  }
  let rest = value;
  for (const match of value.matchAll(SLOT_PATTERN)) {
    const slot = match[1]!;
    if (!(WORKFLOW_TEMPLATE_SLOTS as readonly string[]).includes(slot)) {
      throw workflowError('workflow_invalid_steps', `step ${step} arg "${name}" uses unknown slot {{${slot}}}`);
    }
    rest = rest.replace(match[0], '');
  }
  if (rest.includes('{{') || rest.includes('}}')) {
    throw workflowError('workflow_invalid_steps', `step ${step} arg "${name}" has an unclosed template slot`);
  }
  return value;
}

function validateSuccess(value: unknown, step: number): WorkflowSuccessCriterion {
  if (!isPlainObject(value)) throw workflowError('workflow_invalid_steps', `step ${step} success must be an object`);
  const type = value.type;
  if (type === 'not_error') {
    if (Object.keys(value).some((key) => key !== 'type')) {
      throw workflowError('workflow_invalid_steps', `step ${step} not_error takes no other field`);
    }
    return { type: 'not_error' };
  }
  if (type === 'output_contains') {
    const text = typeof value.text === 'string' ? value.text : '';
    if (!text) throw workflowError('workflow_invalid_steps', `step ${step} output_contains needs literal text`);
    if (text.includes('{{') || text.includes('}}')) {
      throw workflowError('workflow_invalid_steps', `step ${step} output_contains text must be literal, not a slot`);
    }
    if (Object.keys(value).some((key) => key !== 'type' && key !== 'text')) {
      throw workflowError('workflow_invalid_steps', `step ${step} output_contains takes only text`);
    }
    return { type: 'output_contains', text };
  }
  throw workflowError('workflow_invalid_steps', `step ${step} success type is not ${WORKFLOW_SUCCESS_TYPES.join(' or ')}`);
}

/** A stable hash of the draft: a veto refuses this exact draft, not every future one. */
export function workflowDraftHash(steps: WorkflowStep[]): string {
  const canonical = steps.map((step) => ({
    tool: step.tool,
    args: Object.fromEntries(Object.keys(step.args).sort().map((key) => [key, step.args[key]])),
    success: step.success.type === 'output_contains'
      ? { type: step.success.type, text: step.success.text }
      : { type: step.success.type },
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export class ProcedureWorkflows {
  private readonly events: EventStore;
  private readonly procedures: ProcedureCompiler;

  constructor(ports: ProcedureWorkflowPorts) {
    this.events = ports.events;
    this.procedures = ports.procedures;
  }

  /**
   * Propose a workflow draft for an entry. Eligibility is the point: a tentative entry, an entry
   * without the extra successes, a pending/active proposal, or a draft this entry already had vetoed
   * or demoted is refused.
   */
  propose(input: WorkflowProposeInput): ProcedureWorkflow {
    const projectId = requiredText(input.projectId, 'project_id_required');
    const entryId = requiredText(input.entryId, 'workflow_entry_required');
    const now = input.now ?? Date.now();
    const entry = this.entryOf(projectId, entryId);
    if (entry.grade !== 'established') {
      throw workflowError('workflow_not_established', `${entryId} is ${entry.grade}`);
    }
    if (entry.origin !== 'experience') {
      throw workflowError('workflow_not_promotable', `${entryId} is ${entry.origin}, not an own practice`);
    }
    if (entry.status === 'stale') {
      throw workflowError('workflow_not_promotable', `${entryId} is stale; its claim was corrected`);
    }
    const required = PROCEDURE_ESTABLISHED_SUCCESSES + WORKFLOW_PROMOTION_EXTRA_SUCCESSES;
    if (entry.support.successes < required) {
      throw workflowError(
        'workflow_not_enough_executions',
        `${entry.support.successes} successes, ${required} required (established at ${PROCEDURE_ESTABLISHED_SUCCESSES} + ${WORKFLOW_PROMOTION_EXTRA_SUCCESSES} more)`,
      );
    }
    const steps = validateWorkflowSteps(input.steps);
    const draftHash = workflowDraftHash(steps);
    const latest = this.latestOf(projectId, entryId);
    if (latest?.status === 'active') throw workflowError('workflow_already_active', entryId);
    if (latest?.status === 'proposed') throw workflowError('workflow_proposal_pending', entryId);
    if (latest && (latest.status === 'vetoed' || latest.status === 'downgraded') && latest.draftHash === draftHash) {
      throw workflowError('workflow_version_refused', `${entryId} v${latest.version} was ${latest.status}`);
    }
    const workflow: ProcedureWorkflow = {
      workflowId: entryId,
      projectId,
      entryId,
      procedureVersion: entry.version,
      version: latest ? latest.version + 1 : 1,
      domain: entry.domain,
      key: entry.key,
      title: entry.title,
      steps,
      status: 'proposed',
      sourceRefs: entry.sourceRefs,
      draftHash,
      proposedAt: now,
      executions: 0,
      consecutiveFailures: 0,
    };
    this.append(workflow, 'PROCEDURE_WORKFLOW_PROPOSED', now);
    return workflow;
  }

  /** Record the shell's no-side-effect rehearsal verdict for the current proposal. */
  dryRun(input: WorkflowDryRunInput): ProcedureWorkflow {
    const projectId = requiredText(input.projectId, 'project_id_required');
    const entryId = requiredText(input.entryId, 'workflow_entry_required');
    const current = this.currentProposal(projectId, entryId);
    const workflow: ProcedureWorkflow = {
      ...current,
      dryRun: { passed: input.passed === true, ...(input.reason ? { reason: input.reason } : {}), at: input.now ?? Date.now() },
    };
    this.append(workflow, 'PROCEDURE_WORKFLOW_DRY_RUN', workflow.dryRun!.at);
    return workflow;
  }

  /** Activate only a proposal whose current version passed its dry-run. */
  activate(input: WorkflowActivateInput): ProcedureWorkflow {
    const projectId = requiredText(input.projectId, 'project_id_required');
    const entryId = requiredText(input.entryId, 'workflow_entry_required');
    const current = this.currentProposal(projectId, entryId);
    if (!current.dryRun) throw workflowError('workflow_dry_run_required', entryId);
    if (!current.dryRun.passed) {
      throw workflowError('workflow_dry_run_failed', current.dryRun.reason ?? 'the rehearsal did not pass');
    }
    const workflow: ProcedureWorkflow = {
      ...current,
      status: 'active',
      activatedAt: input.now ?? Date.now(),
      consecutiveFailures: 0,
    };
    this.append(workflow, 'PROCEDURE_WORKFLOW_ACTIVATED', workflow.activatedAt!);
    return workflow;
  }

  /** The owner's veto, in F22's shape: a kernel method naming the owner's turn, no write route. */
  veto(input: WorkflowVetoInput): ProcedureWorkflow {
    const projectId = requiredText(input.projectId, 'project_id_required');
    const entryId = requiredText(input.entryId, 'workflow_entry_required');
    const vetoEventId = requiredText(input.vetoEventId, 'workflow_evidence_required');
    const event = this.events.getEvent(vetoEventId);
    if (!event || event.projectId !== projectId) {
      throw workflowError('invalid_workflow_evidence', vetoEventId);
    }
    const latest = this.latestOf(projectId, entryId);
    if (!latest || (latest.status !== 'proposed' && latest.status !== 'active')) {
      throw workflowError('workflow_not_proposed', entryId);
    }
    const workflow: ProcedureWorkflow = {
      ...latest,
      status: 'vetoed',
      vetoedAt: input.now ?? Date.now(),
      vetoEventId,
    };
    this.append(workflow, 'PROCEDURE_WORKFLOW_VETOED', workflow.vetoedAt!);
    return workflow;
  }

  /**
   * Record one workflow execution. A failure increments the consecutive counter; reaching the
   * threshold demotes the workflow and proposes its revocation in the same row.
   */
  recordExecution(input: WorkflowExecutionInput): ProcedureWorkflow {
    const projectId = requiredText(input.projectId, 'project_id_required');
    const entryId = requiredText(input.entryId, 'workflow_entry_required');
    const current = this.latestOf(projectId, entryId);
    if (!current || current.status !== 'active') throw workflowError('workflow_not_active', entryId);
    const now = input.now ?? Date.now();
    const failed = input.outcome === 'failed';
    const consecutiveFailures = failed ? current.consecutiveFailures + 1 : 0;
    const demoted = failed && consecutiveFailures >= WORKFLOW_FAILURE_DEMOTION_THRESHOLD;
    const workflow: ProcedureWorkflow = {
      ...current,
      status: demoted ? 'downgraded' : 'active',
      executions: current.executions + 1,
      consecutiveFailures,
      lastOutcome: input.outcome,
      lastExecutedAt: now,
      ...(input.sourceRefs.length > 0 ? { lastExecutionRefs: input.sourceRefs } : {}),
      ...(demoted ? { demotedAt: now, revocationProposedAt: now } : {}),
    };
    this.append(workflow, 'PROCEDURE_WORKFLOW_EXECUTED', now);
    if (demoted) this.append(workflow, 'PROCEDURE_WORKFLOW_DEMOTED', now);
    return workflow;
  }

  /**
   * Mark workflows whose source practice was corrected out from under them.
   *
   * The workflow's steps are a frozen literal draft and are never rewritten. The invalidation is
   * its own auditable row (`PROCEDURE_WORKFLOW_STALE`), and `match` stops returning it, so an old
   * plan cannot execute silently. `runMaintenanceTick` calls this; a read also derives the stale
   * status from the procedure entry so the gap between the correction and the tick is not a leak.
   */
  reconcileStale(input: { projectId: string; now?: number }): number {
    const projectId = requiredText(input.projectId, 'project_id_required');
    const now = input.now ?? Date.now();
    const staleEntryIds = this.staleEntryIds(projectId);
    let marked = 0;
    for (const workflow of this.storedLatestAll(projectId)) {
      if ((workflow.status !== 'active' && workflow.status !== 'proposed') || !staleEntryIds.has(workflow.entryId)) continue;
      this.append({ ...workflow, status: 'stale', staleAt: now, staleReason: 'source_corrected' }, 'PROCEDURE_WORKFLOW_STALE', now);
      marked += 1;
    }
    return marked;
  }

  /** The active workflow whose domain the task hits; the caller executes it without a model. */
  match(input: WorkflowMatchInput): ProcedureWorkflow | undefined {
    const projectId = requiredText(input.projectId, 'project_id_required');
    const task = requiredText(input.task, 'workflow_task_required');
    const lowered = task.toLowerCase();
    const cues = profileCues(task);
    return this.latestAll(projectId)
      .filter((workflow) => workflow.status === 'active')
      .filter((workflow) => {
        const domain = workflow.domain.toLowerCase();
        return lowered.includes(domain) || cues.includes(domain);
      })
      .sort((a, b) => b.domain.length - a.domain.length || b.version - a.version || a.entryId.localeCompare(b.entryId))[0];
  }

  /** The current workflow per entry, newest version first. */
  list(input: WorkflowListInput): ProcedureWorkflow[] {
    const projectId = requiredText(input.projectId, 'project_id_required');
    return this.latestAll(projectId)
      .filter((workflow) => !input.status || workflow.status === input.status)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.key.localeCompare(b.key) || b.version - a.version);
  }

  /** Every workflow row for the project, oldest first. The ledger is the audit. */
  audit(input: { projectId: string }): WorkflowAuditEntry[] {
    const projectId = requiredText(input.projectId, 'project_id_required');
    return this.loadRows(projectId).map((row) => ({
      entryId: String(row.payload.entryId ?? ''),
      eventType: row.event.eventType as WorkflowEventType,
      payload: row.payload,
      occurredAt: row.event.occurredAt,
    }));
  }

  private entryOf(projectId: string, entryId: string): ProcedureEntry {
    const entry = this.procedures.entries({ projectId }).find((candidate) => candidate.entryId === entryId);
    if (!entry) throw workflowError('workflow_entry_unknown', entryId);
    return entry;
  }

  private currentProposal(projectId: string, entryId: string): ProcedureWorkflow {
    const latest = this.latestOf(projectId, entryId);
    if (!latest || latest.status !== 'proposed') throw workflowError('workflow_not_proposed', entryId);
    return latest;
  }

  private latestOf(projectId: string, entryId: string): ProcedureWorkflow | undefined {
    return this.latestAll(projectId).find((workflow) => workflow.entryId === entryId);
  }

  private latestAll(projectId: string): ProcedureWorkflow[] {
    const stale = this.staleEntryIds(projectId);
    return this.storedLatestAll(projectId).map((workflow) => (
      (workflow.status === 'active' || workflow.status === 'proposed') && stale.has(workflow.entryId)
        ? { ...workflow, status: 'stale' as const, staleReason: 'source_corrected' as const }
        : workflow
    ));
  }

  private staleEntryIds(projectId: string): Set<string> {
    return new Set(this.procedures.entries({ projectId })
      .filter((entry) => entry.status === 'stale')
      .map((entry) => entry.entryId));
  }

  private storedLatestAll(projectId: string): ProcedureWorkflow[] {
    const latest = new Map<string, ProcedureWorkflow>();
    for (const row of this.loadRows(projectId)) {
      const workflow = workflowFromPayload(row.payload, row.event);
      if (!workflow) continue;
      latest.set(workflow.workflowId, workflow);
    }
    return [...latest.values()];
  }

  private loadRows(projectId: string): Array<{ event: MemoryEvent; payload: Record<string, unknown> }> {
    const rows: Array<{ event: MemoryEvent; payload: Record<string, unknown> }> = [];
    const filters = { projectId: [projectId], eventType: [...WORKFLOW_EVENT_TYPES], order: 'asc' as const };
    for (let page = 1; rows.length < MAX_WORKFLOW_ROWS; page += 1) {
      const result = this.events.queryEvents(page, LEDGER_PAGE_SIZE, filters);
      if (result.records.length === 0) break;
      for (const event of result.records) rows.push({ event, payload: (event.payload ?? {}) as Record<string, unknown> });
      if (rows.length >= result.total) break;
    }
    return rows.slice(0, MAX_WORKFLOW_ROWS);
  }

  private append(workflow: ProcedureWorkflow, eventType: WorkflowEventType, at: number): void {
    this.events.append({
      streamId: `procedure-workflow:${workflow.entryId}`,
      streamType: 'system',
      eventType,
      projectId: workflow.projectId,
      sourceId: 'procedure-workflow',
      occurredAt: at,
      payload: { ...workflow },
    });
  }
}

function workflowFromPayload(payload: Record<string, unknown>, event: MemoryEvent): ProcedureWorkflow | null {
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : '';
  const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
  const domain = typeof payload.domain === 'string' ? payload.domain : '';
  const key = typeof payload.key === 'string' ? payload.key : '';
  if (!workflowId || !entryId || !domain || !key) return null;
  const status = (WORKFLOW_STATUSES as readonly string[]).includes(String(payload.status))
    ? payload.status as WorkflowStatus : 'proposed';
  const dryRun = isPlainObject(payload.dryRun) && typeof payload.dryRun.passed === 'boolean'
    ? {
        passed: payload.dryRun.passed,
        ...(typeof payload.dryRun.reason === 'string' ? { reason: payload.dryRun.reason } : {}),
        at: Number(payload.dryRun.at ?? event.occurredAt),
      }
    : undefined;
  return {
    workflowId,
    projectId: String(payload.projectId ?? event.projectId ?? ''),
    entryId,
    procedureVersion: Number(payload.procedureVersion ?? 1),
    version: Number(payload.version ?? 1),
    domain,
    key,
    title: typeof payload.title === 'string' ? payload.title : key,
    steps: Array.isArray(payload.steps) ? payload.steps as WorkflowStep[] : [],
    status,
    sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs as MemorySourceRef[] : [],
    draftHash: typeof payload.draftHash === 'string' ? payload.draftHash : '',
    proposedAt: Number(payload.proposedAt ?? event.occurredAt),
    ...(payload.activatedAt !== undefined ? { activatedAt: Number(payload.activatedAt) } : {}),
    ...(payload.vetoedAt !== undefined ? { vetoedAt: Number(payload.vetoedAt) } : {}),
    ...(typeof payload.vetoEventId === 'string' ? { vetoEventId: payload.vetoEventId } : {}),
    ...(payload.demotedAt !== undefined ? { demotedAt: Number(payload.demotedAt) } : {}),
    ...(payload.revocationProposedAt !== undefined ? { revocationProposedAt: Number(payload.revocationProposedAt) } : {}),
    ...(payload.staleAt !== undefined ? { staleAt: Number(payload.staleAt) } : {}),
    ...(payload.staleReason === 'source_corrected' ? { staleReason: 'source_corrected' as const } : {}),
    ...(dryRun ? { dryRun } : {}),
    executions: Number(payload.executions ?? 0),
    consecutiveFailures: Number(payload.consecutiveFailures ?? 0),
    ...(payload.lastOutcome === 'succeeded' || payload.lastOutcome === 'failed' ? { lastOutcome: payload.lastOutcome } : {}),
    ...(payload.lastExecutedAt !== undefined ? { lastExecutedAt: Number(payload.lastExecutedAt) } : {}),
    ...(Array.isArray(payload.lastExecutionRefs) ? { lastExecutionRefs: payload.lastExecutionRefs as MemorySourceRef[] } : {}),
  };
}

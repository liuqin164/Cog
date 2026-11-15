/**
 * The shell half of procedure promotion (#228, item 4).
 *
 * The kernel's `ProcedureWorkflows` book owns eligibility, the veto, the dry-run verdict, activation
 * and demotion. This service owns the two things the kernel cannot do: rehearse a draft against the
 * real tool registry without side effects, and execute an active workflow without asking the model
 * to decide the next step.
 *
 * Execution deliberately goes through `executeToolCall`, the same pipeline the model's calls take,
 * so `beforeToolCall` — and therefore the cage's whitelist — still sees every step. The run is a
 * normal run: it emits the same agent/message/tool events, capture writes the same account, and a
 * failure ends it at the failed step and hands the task back to the model loop.
 */
import type { KernelAgentMemoryBackend, MemoryKernel, ProcedureWorkflow, WorkflowStep } from 'cogmem';

import type { EventBus } from '../bus.ts';
import {
  executeToolCall,
  type RunBudget,
  type RunOrigin,
  type RunSummary,
  type ToolCall,
  type ToolCallPipelineContext,
  type ToolInvoker,
  type ToolResult,
} from '../state/agent-loop.ts';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin, ToolExecuteInput, ToolOutcome, ToolRegistry } from './host.ts';

export interface WorkflowServiceOptions {
  kernel: MemoryKernel;
  backend: KernelAgentMemoryBackend;
  bus: EventBus;
  tools: ToolRegistry;
  trace: TraceLog;
  projectId: string;
  sessionId: string;
  agentId: string;
  workspaceRoot: string;
  now?: () => number;
  threadId?: () => string;
  /** The same per-run cage the model loop uses. */
  budget?: RunBudget;
  /** The durable prompt log the model loop writes; a workflow run is a run too. */
  prompt?: (input: { runId: string; sessionId: string; text: string }) => void;
}

export interface WorkflowDryRunResult {
  passed: boolean;
  reason?: string;
}

export interface WorkflowExecutionResult {
  ok: boolean;
  summary: RunSummary;
  workflow: ProcedureWorkflow;
  failedStep?: number;
  reason?: string;
}

interface WorkflowExecutionContext {
  task: string;
  workspace: string;
}

const SLOT_PATTERN = /\{\{\s*(task|workspace)\s*\}\}/gu;

function resolveArgument(value: WorkflowStep['args'][string], context: WorkflowExecutionContext): WorkflowStep['args'][string] {
  if (typeof value !== 'string') return value;
  return value.replace(SLOT_PATTERN, (_match, slot: 'task' | 'workspace') => context[slot]);
}

function resolveStep(step: WorkflowStep, context: WorkflowExecutionContext): ToolCall['input'] {
  const args: Record<string, WorkflowStep['args'][string]> = {};
  for (const [name, value] of Object.entries(step.args)) args[name] = resolveArgument(value, context);
  return args;
}

function criterionMet(step: WorkflowStep, result: ToolResult): boolean {
  if (result.isError) return false;
  return step.success.type !== 'output_contains' || result.output.includes(step.success.text ?? '');
}

function field(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkflowService {
  private readonly kernel: MemoryKernel;
  private readonly backend: KernelAgentMemoryBackend;
  private readonly bus: EventBus;
  private readonly tools: ToolRegistry;
  private readonly trace: TraceLog;
  private readonly projectId: string;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly workspaceRoot: string;
  private readonly clock: () => number;
  private readonly threadId: () => string;
  private readonly budget?: RunBudget;
  private readonly prompt?: WorkflowServiceOptions['prompt'];

  constructor(options: WorkflowServiceOptions) {
    this.kernel = options.kernel;
    this.backend = options.backend;
    this.bus = options.bus;
    this.tools = options.tools;
    this.trace = options.trace;
    this.projectId = options.projectId;
    this.sessionId = options.sessionId;
    this.agentId = options.agentId;
    this.workspaceRoot = options.workspaceRoot;
    this.clock = options.now ?? Date.now;
    this.threadId = options.threadId ?? (() => `companion-day:${new Date(this.clock()).toISOString().slice(0, 10)}`);
    this.budget = options.budget;
    this.prompt = options.prompt;
  }

  /**
   * Compile first, then ask the book. The book's eligibility check is the authority; compiling here
   * only makes sure a proposal is not refused because a caller forgot the step.
   */
  propose(entryId: string, steps: unknown): ProcedureWorkflow {
    const now = this.clock();
    this.kernel.procedures.compile({ projectId: this.projectId, now });
    return this.kernel.workflows.propose({ projectId: this.projectId, entryId, steps, now });
  }

  /**
   * Walk the draft in rehearsal mode: every tool must exist, be rehearsable and pass the whitelist.
   * `output_contains` is a real-execution criterion; a rehearsal cannot know the world's answer, so
   * it is recorded as unverified rather than pretended to pass or fail.
   */
  async dryRun(entryId: string, sampleTask?: string): Promise<WorkflowDryRunResult> {
    const workflow = this.kernel.workflows.list({ projectId: this.projectId, status: 'proposed' })
      .find((candidate) => candidate.entryId === entryId);
    if (!workflow) {
      // Nothing to record the verdict against; the book's `dryRun` refuses an entry it has no
      // proposal for, so this is a plain answer rather than a second refusal.
      return { passed: false, reason: `workflow_not_proposed: ${entryId}` };
    }
    const entry = this.kernel.procedures.entries({ projectId: this.projectId }).find((candidate) => candidate.entryId === entryId);
    const context: WorkflowExecutionContext = {
      task: sampleTask?.trim() || `${entry?.title ?? workflow.title} ${(entry?.steps ?? []).join(' ')}`.trim(),
      workspace: this.workspaceRoot,
    };
    const rehearsal = this.rehearsalInvoker();
    const pipeline: ToolCallPipelineContext = {
      bus: this.bus,
      tools: rehearsal,
      trace: this.trace,
      clock: this.clock,
      runId: `workflow-dry-run:${entryId}`,
      signal: new AbortController().signal,
    };
    const unverified: number[] = [];
    let failure: string | undefined;
    for (const [index, step] of workflow.steps.entries()) {
      const call: ToolCall = {
        toolCallId: `${pipeline.runId}:step-${index}`,
        toolName: step.tool,
        input: resolveStep(step, context),
      };
      const executed = await executeToolCall(pipeline, call, { emitEvents: false });
      if (executed.result.isError) {
        failure = `step ${index + 1} (${step.tool}): ${executed.result.output}`;
        break;
      }
      if (step.success.type === 'output_contains') unverified.push(index + 1);
    }
    const passed = failure === undefined;
    const reason = passed
      ? unverified.length > 0
        ? `rehearsed; output_contains not exercisable without side effects (steps ${unverified.join(', ')})`
        : 'rehearsed'
      : failure;
    this.kernel.workflows.dryRun({ projectId: this.projectId, entryId, passed, ...(reason ? { reason } : {}), now: this.clock() });
    this.trace.append('workflow_dry_run', { entryId, passed, reason, steps: workflow.steps.length });
    return { passed, ...(reason ? { reason } : {}) };
  }

  /** Dry-run if the current version has no verdict, then activate. A failed verdict blocks. */
  async promote(entryId: string): Promise<ProcedureWorkflow> {
    const workflow = this.kernel.workflows.list({ projectId: this.projectId, status: 'proposed' })
      .find((candidate) => candidate.entryId === entryId);
    if (!workflow) throw new Error(`workflow_not_proposed: ${entryId}`);
    if (!workflow.dryRun?.passed) await this.dryRun(entryId);
    return this.kernel.workflows.activate({ projectId: this.projectId, entryId, now: this.clock() });
  }

  veto(entryId: string, vetoEventId: string): ProcedureWorkflow {
    return this.kernel.workflows.veto({ projectId: this.projectId, entryId, vetoEventId, now: this.clock() });
  }

  /**
   * The owner's latest turn, which is the evidence a veto names. A veto is an owner act; the shell
   * never invents a turn, and a tool call with no owner turn behind it is refused rather than
   * attached to an arbitrary event.
   */
  latestOwnerEventId(): string | undefined {
    const recent = this.kernel.eventStore.queryEvents(1, 200, { projectId: [this.projectId], order: 'desc' }).records;
    return recent.find((event) => event.role === 'user')?.eventId;
  }

  list(): ProcedureWorkflow[] {
    return this.kernel.workflows.list({ projectId: this.projectId });
  }

  match(task: string): ProcedureWorkflow | undefined {
    return this.kernel.workflows.match({ projectId: this.projectId, task });
  }

  /**
   * The presentation a model reads before proposing: established own practices with their support,
   * and the current workflow per entry. The kernel's `propose` remains the authority on eligibility;
   * this only puts the book in front of the caller.
   */
  presentation(): string {
    const practices = this.kernel.procedures.entries({ projectId: this.projectId })
      .filter((entry) => entry.grade === 'established' && entry.origin === 'experience');
    const workflows = this.list();
    const lines = ['<workflows>', 'established practices:'];
    if (practices.length === 0) lines.push('- none');
    for (const entry of practices) {
      const workflow = workflows.find((candidate) => candidate.entryId === entry.entryId);
      lines.push(
        `- ${entry.entryId} (${entry.domain}/${entry.key}) "${entry.title}" — ${entry.support.successes} successes`
        + `, steps: ${entry.steps.join(' → ')}`
        + (workflow ? `; workflow v${workflow.version} ${workflow.status}` : ''),
      );
    }
    lines.push('workflows:');
    if (workflows.length === 0) lines.push('- none');
    for (const workflow of workflows) {
      const dryRun = workflow.dryRun
        ? `dryRun=${workflow.dryRun.passed ? 'passed' : `failed(${workflow.dryRun.reason ?? 'no reason'})`}`
        : 'dryRun=pending';
      lines.push(
        `- ${workflow.entryId} ${workflow.domain}/${workflow.key} v${workflow.version} ${workflow.status}`
        + ` ${dryRun} executions=${workflow.executions} consecutiveFailures=${workflow.consecutiveFailures}`,
      );
    }
    lines.push('</workflows>');
    return lines.join('\n');
  }

  /**
   * Run an active workflow as a normal run. The steps go through the model's own tool pipeline, so
   * the cage's whitelist and every hook apply. A failure stops at the failed step, records the
   * failure against the workflow, and returns; the caller hands the task back to the model loop.
   */
  async execute(workflow: ProcedureWorkflow, input: { runId: string; userText: string; origin: RunOrigin }): Promise<WorkflowExecutionResult> {
    const runId = input.runId;
    const turnId = `${runId}:0`;
    const userMessage = { role: 'user' as const, content: input.userText };
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let stopReason: RunSummary['stopReason'] = 'run_complete';
    let error: string | undefined;
    let failedStep: number | undefined;
    let reason: string | undefined;

    this.prompt?.({ runId, sessionId: this.sessionId, text: input.userText });
    await this.bus.emit('agent_start', { type: 'agent_start', runId, messages: [userMessage] }, { runId });
    await this.bus.emit('message_start', { type: 'message_start', message: userMessage }, { runId });
    await this.bus.emit('message_end', { type: 'message_end', message: userMessage }, { runId });
    await this.bus.emit('turn_start', { type: 'turn_start', turnIndex: 1 }, { runId });

    const pipeline: ToolCallPipelineContext = {
      bus: this.bus,
      tools: this.tools,
      trace: this.trace,
      clock: this.clock,
      runId,
      signal: new AbortController().signal,
    };
    const context: WorkflowExecutionContext = { task: input.userText, workspace: this.workspaceRoot };
    for (const [index, step] of workflow.steps.entries()) {
      const budgetCheck = this.budget?.checkTurn(index + 1);
      if (budgetCheck?.exceeded) {
        stopReason = 'budget_exceeded';
        error = budgetCheck.reason;
        reason = budgetCheck.reason;
        failedStep = index + 1;
        break;
      }
      const call: ToolCall = {
        toolCallId: `${runId}:step-${index}`,
        toolName: step.tool,
        input: resolveStep(step, context),
      };
      toolCalls.push(call);
      const executed = await executeToolCall(pipeline, call, { emitEvents: true });
      toolResults.push(executed.result);
      if (!criterionMet(step, executed.result)) {
        failedStep = index + 1;
        reason = executed.result.isError
          ? `step ${index + 1} (${step.tool}): ${executed.result.output}`
          : `step ${index + 1} (${step.tool}): output_contains ${JSON.stringify(step.success.text)} not met`;
        stopReason = 'run_error';
        error = reason;
        break;
      }
    }

    const succeeded = failedStep === undefined && stopReason === 'run_complete';
    const assistantText = succeeded
      ? `workflow ${workflow.domain}/${workflow.key} v${workflow.version}: ${workflow.steps.length} steps completed`
      : `workflow ${workflow.domain}/${workflow.key} v${workflow.version} failed at step ${failedStep ?? '?'}: ${reason ?? 'unknown'}`;
    const assistantMessage = { role: 'assistant' as const, content: assistantText };
    await this.bus.emit('finishTurn', {
      type: 'finishTurn',
      turnIndex: 1,
      message: assistantMessage,
      toolResults,
    }, { runId });
    await this.bus.emit('message_start', { type: 'message_start', message: assistantMessage }, { runId });
    await this.bus.emit('message_end', { type: 'message_end', message: assistantMessage }, { runId });
    await this.bus.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: assistantMessage,
      toolResults,
    }, { runId });

    const summary: RunSummary = {
      runId,
      origin: input.origin,
      sessionId: this.sessionId,
      turnId,
      userText: input.userText,
      assistantText,
      lastAssistantText: assistantText,
      toolCalls,
      toolResults,
      turns: 1,
      tokens: 0,
      stopReason,
      ...(error ? { error } : {}),
    };
    const endResult = await this.bus.emit('agent_end', { type: 'agent_end', runId, messages: [userMessage, assistantMessage], summary }, { runId });
    if (endResult && typeof endResult === 'object' && 'hookFailed' in endResult && endResult.hookFailed) {
      summary.stopReason = 'run_error';
      summary.error = `agent_end_hook_failed: ${String(endResult.reason ?? 'hook failed')}`;
    }
    await this.bus.emit('agent_settled', {
      type: 'agent_settled',
      runId,
      aborted: summary.stopReason === 'run_aborted',
      stopReason: summary.stopReason,
    }, { runId });

    await this.recordExecution(workflow, {
      outcome: succeeded ? 'succeeded' : 'failed',
      failedStep,
      runId,
    });
    this.trace.append('workflow_executed', {
      entryId: workflow.entryId,
      workflowVersion: workflow.version,
      runId,
      steps: workflow.steps.length,
      failedStep,
      stopReason: summary.stopReason,
    });
    return { ok: succeeded, summary, workflow, ...(failedStep !== undefined ? { failedStep } : {}), ...(reason ? { reason } : {}) };
  }

  /**
   * The procedure book's own accounting: a task event with the descriptor it compiles from, so the
   * execution counts as support exactly like a model-followed attempt. The event id is the
   * workflow row's `lastExecutionRefs`, which is what makes the execution auditable back to the
   * ledger.
   */
  private async recordExecution(
    workflow: ProcedureWorkflow,
    input: { outcome: 'succeeded' | 'failed'; failedStep?: number; runId: string },
  ): Promise<void> {
    const entry = this.kernel.procedures.entries({ projectId: this.projectId }).find((candidate) => candidate.entryId === workflow.entryId);
    const event = await this.backend.ingestTaskEvent({
      agentId: this.agentId,
      projectId: this.projectId,
      workspaceId: this.projectId,
      sessionId: this.sessionId,
      threadId: this.threadId(),
      title: `workflow ${workflow.domain}/${workflow.key} v${workflow.version}`,
      content: `workflow ${input.outcome}${input.failedStep ? ` at step ${input.failedStep}` : ''}`,
      metadata: {
        sourceAgent: this.agentId,
        source: 'companion-shell',
        kind: 'workflow-execution',
        workflow: {
          entryId: workflow.entryId,
          version: workflow.version,
          runId: input.runId,
          ...(input.failedStep !== undefined ? { failedStep: input.failedStep } : {}),
        },
        procedure: {
          domain: workflow.domain,
          key: workflow.key,
          title: entry?.title ?? workflow.title,
          steps: entry?.steps ?? workflow.steps.map((step) => step.tool),
          tools: entry?.tools ?? [...new Set(workflow.steps.map((step) => step.tool))],
          outcome: input.outcome,
        },
      },
    });
    this.kernel.workflows.recordExecution({
      projectId: this.projectId,
      entryId: workflow.entryId,
      outcome: input.outcome,
      ...(input.failedStep !== undefined ? { failedStep: input.failedStep } : {}),
      sourceRefs: [{
        eventId: event.eventId,
        eventType: event.rawEventType || event.eventType,
        role: event.role,
        threadId: event.threadId,
        sessionId: event.sessionId,
        turnId: event.turnId,
      }],
      now: this.clock(),
    });
  }

  /** A tool invoker that calls `rehearse` instead of `execute`; the hooks still see every call. */
  private rehearsalInvoker(): ToolInvoker {
    return {
      list: () => this.tools.list(),
      invoke: async (name, call, ctx): Promise<ToolResult> => {
        const tool = this.tools.get(name);
        if (!tool) {
          return { toolCallId: call.toolCallId, toolName: name, output: `unknown_tool: ${name} is not registered`, isError: true };
        }
        if (!tool.rehearse) {
          return {
            toolCallId: call.toolCallId,
            toolName: name,
            output: `tool_not_rehearsable: "${name}" has no rehearsal mode, so it cannot be dry-run`,
            isError: true,
          };
        }
        try {
          const raw = await tool.rehearse({
            toolCallId: call.toolCallId,
            args: call.input,
            signal: ctx.signal,
            ctx,
            dryRun: true,
          } satisfies ToolExecuteInput);
          if (typeof raw === 'string') return { toolCallId: call.toolCallId, toolName: name, output: raw, isError: false };
          const outcome = raw as ToolOutcome;
          return { ...outcome, toolCallId: call.toolCallId, toolName: name, isError: outcome.isError === true };
        } catch (caught) {
          return {
            toolCallId: call.toolCallId,
            toolName: name,
            output: `tool_error: ${errorText(caught)}`,
            isError: true,
          };
        }
      },
    };
  }
}

export interface WorkflowsPluginConfig {
  agentId: string;
  projectId: string;
  sessionId: string;
  workspaceRoot: string;
  /** The host's live registry; execution and rehearsal both go through it. */
  tools: ToolRegistry;
  prompt?: (input: { runId: string; sessionId: string; text: string }) => void;
}

/**
 * The model-facing half: one read tool that presents the book, one write tool that proposes and
 * dry-runs a draft, and one owner-veto tool. There is no model-facing activate: a draft becomes
 * active only after its rehearsal passes, and the owner's veto is the override.
 */
export function workflowsPlugin(config: WorkflowsPluginConfig): NativePlugin {
  return {
    name: 'workflows',
    inject: ['kernel', 'memory', 'eventBus', 'trace', 'cage'],
    provide: ['workflows'],
    apply(ctx) {
      const service = new WorkflowService({
        kernel: ctx.getService<MemoryKernel>('kernel'),
        backend: ctx.getService<KernelAgentMemoryBackend>('memory'),
        bus: ctx.getService<EventBus>('eventBus'),
        tools: config.tools,
        trace: ctx.getService<TraceLog>('trace'),
        projectId: config.projectId,
        sessionId: config.sessionId,
        agentId: config.agentId,
        workspaceRoot: config.workspaceRoot,
        budget: ctx.getService<RunBudget>('cage'),
        ...(config.prompt ? { prompt: config.prompt } : {}),
      });
      ctx.provide('workflows', service);
      ctx.registerTool({
        name: 'list_workflows',
        description:
          'Show the procedure book: established practices and the current workflow per entry, with support, status, dry-run verdict and execution counts. Use it before offering to promote a practice, and to tell the owner what is active.',
        replay: 'safe',
        parameters: { type: 'object', properties: {} },
        execute(): ToolOutcome {
          return { output: service.presentation(), isError: false };
        },
      });
      ctx.registerTool({
        name: 'propose_workflow',
        description:
          'Offer a deterministic workflow draft for an established practice: literal tool steps with frozen {{task}}/{{workspace}} slots, each with a success criterion. The draft is rehearsed with no side effects; a passing rehearsal activates it, a failing one leaves it proposed. A draft with a branch or a model-computed argument is refused. The procedure entry itself is never edited.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            entryId: { type: 'string', description: 'The established procedure entry to promote' },
            steps: {
              type: 'array',
              description: 'Ordered steps: { tool, args, success: { type: "not_error" | "output_contains", text? } }',
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string' },
                  args: { type: 'object' },
                  success: { type: 'object' },
                },
                required: ['tool', 'args', 'success'],
              },
            },
          },
          required: ['entryId', 'steps'],
        },
        async execute({ args }): Promise<ToolOutcome> {
          const entryId = field(args, 'entryId');
          if (!entryId) return { output: 'workflow_refused: entryId is required', isError: true };
          try {
            const proposed = service.propose(entryId, (args as Record<string, unknown>).steps);
            const dryRun = await service.dryRun(entryId);
            if (!dryRun.passed) {
              return {
                output: `workflow_proposed: ${entryId} v${proposed.version} — dry-run failed: ${dryRun.reason ?? 'no reason'}\n`
                  + 'It stays proposed and will not execute. The procedure entry is unchanged. '
                  + 'A corrected draft is refused while this one is pending; the owner must veto it first.',
                isError: true,
              };
            }
            const active = await service.promote(entryId);
            return {
              output: `workflow_active: ${entryId} ${active.domain}/${active.key} v${active.version}\n`
                + `steps: ${active.steps.map((step, index) => `${index + 1}. ${step.tool} (${step.success.type}${step.success.text ? `: ${step.success.text}` : ''})`).join('; ')}\n`
                + `dry-run: ${dryRun.reason ?? 'passed'}\n`
                + 'The owner may veto it. The procedure entry is unchanged.',
              isError: false,
            };
          } catch (caught) {
            return { output: `workflow_refused: ${errorText(caught)}`, isError: true };
          }
        },
      });
      ctx.registerTool({
        name: 'veto_workflow',
        description:
          'Veto a proposed or active workflow when the owner asks. The veto is attached to the owner\'s latest turn, and that draft is never proposed again; a materially different draft may be.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            entryId: { type: 'string', description: 'The workflow entry to veto' },
            reason: { type: 'string', description: 'One line from the owner\'s instruction' },
          },
          required: ['entryId'],
        },
        execute({ args }): ToolOutcome {
          const entryId = field(args, 'entryId');
          if (!entryId) return { output: 'workflow_refused: entryId is required', isError: true };
          const vetoEventId = service.latestOwnerEventId();
          if (!vetoEventId) {
            return { output: 'workflow_refused: no owner turn is on the ledger to carry the veto', isError: true };
          }
          try {
            const vetoed = service.veto(entryId, vetoEventId);
            return {
              output: `workflow_vetoed: ${entryId} ${vetoed.domain}/${vetoed.key} v${vetoed.version}`
                + `${field(args, 'reason') ? ` — ${field(args, 'reason')}` : ''}. The procedure entry is unchanged.`,
              isError: false,
            };
          } catch (caught) {
            return { output: `workflow_refused: ${errorText(caught)}`, isError: true };
          }
        },
      });
    },
  };
}

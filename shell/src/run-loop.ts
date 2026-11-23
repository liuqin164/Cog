import { randomUUID } from 'node:crypto';
import type { CompanionShell } from './app.ts';
import { estimateBudgetGrant, type CageTier } from './plugins/cage.ts';
import type { RunSummary } from './state/agent-loop.ts';
import type { Suspension } from './state/checkpoint.ts';
import { classifyEndpointFailure } from './state/retry.ts';
import type { Trigger } from './state/table.ts';

const MAX_ASSIGNMENT_FINDINGS = 600;

/**
 * Autonomous continuation backoff (#228): 5 min × 2^n, capped at 6 h. The base is the shortest wait
 * that still lets a transient provider failure clear; the cap is what a stuck task costs at most —
 * after the ladder saturates, an unattended assignment is retried about four times a day instead of
 * every wake, which is the repeated-recon burn the ticket names. A user line, an approved budget, or
 * a successful tool result resets the count, so the cap never applies to work that is moving.
 */
const RESUME_BACKOFF_BASE_MS = 5 * 60_000;
const RESUME_BACKOFF_CAP_MS = 6 * 60 * 60_000;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export class RunLoop {
  private readonly inboundResults = new Map<string, RunSummary | Error>();
  private readonly inboundWaiters = new Set<string>();
  private drainPromise?: Promise<void>;
  private activeRun?: Promise<RunSummary>;
  private stopping = false;

  constructor(private readonly shell: CompanionShell) {}

  async submit(text: string, channel = 'terminal'): Promise<RunSummary | undefined> {
    if (!text.trim()) throw new Error('submit_empty_text');
    if (this.shell.machine.state === 'RUNNING') {
      if (this.shell.runtime?.isRunning && channel === this.shell.currentChannel) {
        this.shell.runtime.steer(text);
        this.shell.statusFace.emitSteering();
        return undefined;
      }
      this.shell.clock!.markInteraction(this.shell.now());
      this.shell.residentTick.observeSurfacingReply(text);
      this.enqueueInbound(text, channel, 'queued');
      return undefined;
    }
    if (this.shell.statusFace.dailyBudgetExceeded()) this.shell.statusFace.announceDailyBudget('user_message');
    if (this.shell.machine.state === 'SUSPENDED') return this.submitWhileSuspended(text, channel);
    this.shell.clock!.markInteraction(this.shell.now());
    this.shell.residentTick.observeSurfacingReply(text);
    const id = this.enqueueInbound(text, channel, 'queued');
    this.inboundWaiters.add(id);
    let result: RunSummary | Error | undefined;
    try {
      do {
        await this.drainInbound();
      } while (this.shouldDrain(id));
    } finally {
      result = this.inboundResults.get(id);
      this.inboundResults.delete(id);
      this.inboundWaiters.delete(id);
    }
    if (result instanceof Error) throw result;
    return result;
  }

  /**
   * A line typed while paused (#228). For a question the line is the answer: the same assignment
   * continues, no new assignment record is written, and the object is marked answered so the
   * resumed prompt can still name the question. For a budget request a typed line is a new
   * instruction: the paused task closes as budget_exceeded (traced) and the line starts fresh work.
   * There is no timeout for either kind — see `Suspension`'s comment.
   */
  private async submitWhileSuspended(text: string, channel: string): Promise<RunSummary | undefined> {
    const suspension = this.shell.machine.runtime.suspension;
    this.shell.clock!.markInteraction(this.shell.now());
    this.shell.residentTick.observeSurfacingReply(text);
    if (suspension?.kind === 'question') {
      this.shell.machine.updateRuntime({ suspension: { ...suspension, answeredAt: this.shell.now() } });
      this.shell.trace.append('suspension_answered', { id: suspension.id, assignmentId: suspension.assignmentId, chars: text.trim().length });
      try {
        return await this.executeRun(text, 'message_received', 'question_answered', 'answer_received', undefined, channel);
      } catch (error) {
        this.retainFailed(text, channel, error);
        throw error;
      }
    }
    if (suspension) this.shell.proposalsHandlers.supersedeSuspension('new_input');
    this.beginUserAssignment(text);
    try {
      return await this.executeRun(text, 'message_received', 'user_message', 'message_received', undefined, channel);
    } catch (error) {
      this.retainFailed(text, channel, error);
      throw error;
    }
  }

  async wake(): Promise<void> {
    if (this.shell.machine.state !== 'DREAMING' && this.shell.machine.state !== 'DORMANT') return;
    await this.wakeIfNeeded('message_received');
  }

  async wakeIfNeeded(trigger: 'message_received' | 'wake_intent_due' | 'emergence_due'): Promise<void> {
    if (this.shell.machine.state === 'DORMANT') await this.shell.machine.dispatch('message_received', { reason: 'message_while_dormant' });
    if (this.shell.machine.state === 'DREAMING') await this.shell.machine.dispatch('message_received', { reason: 'message_while_dreaming' });
    if (this.shell.machine.state === 'WAKING') {
      this.shell.residentTick.injectTimeContext(trigger);
      await this.shell.machine.dispatch('context_injected', { reason: `${trigger}_time_context` });
    }
  }

  async settleInFlight(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    return await settleWithin([this.activeRun, this.drainPromise], timeoutMs);
  }

  executeRun(
    text: string,
    trigger: 'message_received' | 'emergence_due',
    reason: string,
    dispatchTrigger: Trigger = trigger,
    grant?: { tokens: number; turns: number },
    channel?: string,
    sourceRefs?: Array<{ eventId?: string; sourceId?: string; contentHash?: string }>,
  ): Promise<RunSummary> {
    if (this.stopping) return Promise.reject(new Error('run_loop_stopping'));
    const run = this.runOnce(text, trigger, reason, dispatchTrigger, grant, channel, sourceRefs);
    if (!this.activeRun) {
      this.activeRun = run;
      const clear = () => {
        if (this.activeRun === run) this.activeRun = undefined;
      };
      void run.then(clear, clear);
    }
    return run;
  }

  private async runOnce(
    text: string,
    trigger: 'message_received' | 'emergence_due',
    reason: string,
    dispatchTrigger: Trigger,
    grant?: { tokens: number; turns: number },
    channel?: string,
    sourceRefs?: Array<{ eventId?: string; sourceId?: string; contentHash?: string }>,
  ): Promise<RunSummary> {
    const runId = `run-${this.shell.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const origin = trigger === 'emergence_due' ? 'emergence' : 'user';
    this.shell.currentChannel = trigger === 'emergence_due' ? '' : channel ?? this.shell.currentChannel;
    const tier = this.budgetTier(trigger);
    this.shell.runTier = tier;
    this.shell.currentRunUserText = text;
    this.shell.cage!.beginRun(runId, tier, tier === 'work' ? (grant ?? this.shell.machine.runtime.openAssignment?.grant) : undefined);
    this.shell.hideAssignmentContext = trigger === 'emergence_due' && tier === 'autonomous' && this.shell.machine.runtime.openAssignment !== undefined;
    if (this.shell.hideAssignmentContext) {
      const assignment = this.shell.machine.runtime.openAssignment!;
      this.shell.trace.append('assignment_resume_deferred', {
        assignmentId: assignment.id,
        attempts: assignment.attempts ?? 0,
        nextResumeAt: assignment.nextResumeAt ?? null,
        now: this.shell.now(),
      });
    }
    await this.shell.machine.dispatch(dispatchTrigger, { runId, reason });

    try {
      let summary: RunSummary;
      try {
        summary = await this.shell.runtime!.run({
          runId,
          sessionId: this.shell.config.sessionId,
          userText: text,
          origin,
          ...(sourceRefs === undefined ? {} : { sourceRefs }),
        });
      } finally {
        this.shell.hideAssignmentContext = false;
      }
      const outcome = this.settleAssignment(summary, tier, trigger);
      this.shell.contextLanes.materializeTaskProcedure(true);
      this.shell.contextLanes.materializeTaskEndStub(summary.turnId, summary.runId);
      if (summary.stopReason === 'run_error' && summary.error?.startsWith('model_timeout:')) this.announceModelTimeout(summary);
      if (summary.stopReason === 'run_error' && summary.error?.startsWith('no_progress:')) this.announceNoProgress(summary);
      if (summary.stopReason === 'run_error' && summary.error?.startsWith('mg_gateway_error:')) this.announceProviderFailure(summary);
      await this.shell.machine.dispatch(outcome, { reason: summary.error ?? reason, runId });
      if (this.shell.machine.state === 'SUSPENDED' && this.shell.machine.runtime.suspension?.kind === 'budget') {
        this.shell.proposalsHandlers.offerResume(this.shell.machine.runtime.suspension.id);
      }
      this.recoverStrandedSteering(this.shell.currentChannel);
      await this.drainInbound(true);
      if (!this.stopping && !this.shell.clock!.nextPendingIntent()) this.shell.clock!.scheduleIdleWake();
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.shell.trace.append('run_execute_failed', { runId, message });
      if (this.shell.machine.state === 'RUNNING') {
        try {
          await this.shell.machine.dispatch('run_error', { reason: `execute_failed:${message}`, runId });
        } catch (dispatchError) {
          this.shell.trace.append('run_execute_failed_leave_failed', {
            runId,
            message: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
          });
        }
      }
      try {
        this.recoverStrandedSteering(this.shell.currentChannel);
        await this.drainInbound(true);
      } catch (drainError) {
        this.shell.trace.append('inbound_drain_failed', {
          runId,
          message: drainError instanceof Error ? drainError.message : String(drainError),
        });
      }
      throw error;
    } finally {
      this.shell.hideAssignmentContext = false;
    }
  }

  private enqueueInbound(text: string, channel: string, status: 'queued' | 'failed', error?: string): string {
    const entry = {
      id: `inbound-${this.shell.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      text,
      channel,
      at: this.shell.now(),
      status,
      ...(error ? { error } : {}),
    };
    this.shell.machine.updateRuntime({ inboundQueue: [...(this.shell.machine.runtime.inboundQueue ?? []), entry] });
    this.shell.trace.append(status === 'failed' ? 'inbound_failed_retained' : 'inbound_queued', {
      id: entry.id,
      channel,
      chars: text.trim().length,
      ...(error ? { message: error } : {}),
    });
    return entry.id;
  }

  private dropInbound(id: string): void {
    const kept = (this.shell.machine.runtime.inboundQueue ?? []).filter((entry) => entry.id !== id);
    this.shell.machine.updateRuntime({ inboundQueue: kept.length > 0 ? kept : undefined });
  }

  private retainFailed(text: string, channel: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.enqueueInbound(text, channel, 'failed', message);
    } catch (nested) {
      this.shell.trace.append('inbound_retention_failed', {
        channel,
        message: nested instanceof Error ? nested.message : String(nested),
      });
    }
  }

  private recoverStrandedSteering(channel: string): void {
    const runtime = this.shell.runtime;
    if (!runtime) return;
    const lines = [...runtime.steeringMessages];
    if (lines.length === 0) return;
    for (let index = 0; index < lines.length; index += 1) runtime.withdrawSteering();
    this.shell.trace.append('steering_recovered_to_inbound', { count: lines.length, channel });
    for (const line of lines) this.enqueueInbound(line, channel, 'queued');
  }

  private async drainInbound(reentrant = false): Promise<void> {
    if (reentrant && this.drainPromise) return;
    const work = this.drainPromise ?? this.runInboundQueue();
    this.drainPromise = work;
    try {
      await work;
    } finally {
      if (this.drainPromise === work) this.drainPromise = undefined;
    }
  }

  private shouldDrain(id: string): boolean {
    return !this.stopping && this.shell.machine.state !== 'RUNNING' && (this.shell.machine.runtime.inboundQueue ?? []).some((entry) => entry.id === id && entry.status === 'queued');
  }

  private async runInboundQueue(): Promise<void> {
    for (;;) {
      if (this.stopping) return;
      const entry = (this.shell.machine.runtime.inboundQueue ?? []).find((item) => item.status === 'queued');
      if (!entry) return;
      const state = this.shell.machine.state;
      if (state === 'RUNNING') return;
      if (state === 'DORMANT' || state === 'WAKING' || state === 'DREAMING') {
        await this.wakeIfNeeded('message_received');
        if (this.shell.machine.state !== 'IDLE') return;
      }
      if (this.shell.machine.state === 'SUSPENDED') this.shell.proposalsHandlers.supersedeSuspension('new_input');
      if (this.stopping) return;
      this.dropInbound(entry.id);
      this.beginUserAssignment(entry.text);
      try {
        const summary = await this.executeRun(entry.text, 'message_received', 'inbound_queue', 'message_received', undefined, entry.channel);
        if (this.inboundWaiters.has(entry.id)) this.inboundResults.set(entry.id, summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = error instanceof Error ? error : new Error(message);
        this.shell.trace.append('inbound_failed', { id: entry.id, channel: entry.channel, message });
        this.retainFailed(entry.text, entry.channel, error);
        if (this.inboundWaiters.has(entry.id)) this.inboundResults.set(entry.id, failure);
        return;
      }
    }
  }

  /**
   * Which cage this run gets. An autonomous wake inherits the work tier only when the ledger still
   * holds an unfinished user-assigned task; the check reads that task's `origin`, never the wake's
   * words.
   */
  private budgetTier(trigger: 'message_received' | 'emergence_due'): CageTier {
    if (trigger === 'message_received') return 'work';
    const assignment = this.shell.machine.runtime.openAssignment;
    if (assignment?.origin !== 'user_message') return 'autonomous';
    if (assignment.nextResumeAt !== undefined && assignment.nextResumeAt > this.shell.now()) return 'autonomous';
    return 'work';
  }

  private beginUserAssignment(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const open = this.shell.machine.runtime.openAssignment;
    if (open) {
      this.shell.machine.updateRuntime({ openAssignment: { ...open, latestUserText: trimmed.slice(0, 500) } });
      this.shell.trace.append('assignment_attached', { assignmentId: open.id, chars: trimmed.length });
    }
  }

  openAssignmentOnToolUse(): void {
    if (this.shell.runTier !== 'work' || this.shell.machine.runtime.openAssignment) return;
    const brief = this.shell.currentRunUserText.trim().slice(0, 500);
    if (!brief) return;
    const assignment = {
      id: `assignment-${this.shell.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      origin: 'user_message' as const,
      text: brief,
      startedAt: this.shell.runStartedAt ?? this.shell.now(),
    };
    this.shell.machine.updateRuntime({ openAssignment: assignment });
    this.shell.trace.append('assignment_opened', { assignmentId: assignment.id, chars: brief.length });
  }

  /**
   * A whole-turn timeout stops the run instead of retrying (#240), so the transcript says why and
   * with which cap; otherwise a stopped turn leaves only the idle status behind.
   */
  private announceModelTimeout(summary: RunSummary): void {
    const seconds = Math.round(this.shell.config.model.timeoutMs / 1_000);
    const reason = (summary.error ?? '').replace(/^model_timeout:\s*/u, '');
    const text = `模型超时（整轮上限 ${seconds} 秒），已停止本轮、不再重试${reason ? `：${reason}` : ''}`;
    void this.shell.host.bus.emit('terminal_print', { text: `${text}\n` });
    void this.shell.host.bus.emit('companion_notice', { text, tone: 'warn' });
  }

  /**
   * The no-progress stop (#241): name the turn it stopped on and the tool call it was repeating, so
   * the stop is not mistaken for the cage's budget or a provider failure.
   */
  private announceNoProgress(summary: RunSummary): void {
    const lastCall = summary.toolCalls.at(-1);
    const where = lastCall
      ? `${lastCall.toolName} ${truncate(JSON.stringify(lastCall.input ?? {}), 120)}`
      : `turn ${summary.turns}`;
    const text = `连续 ${this.shell.config.maxIdleTurns} 回合无用户可见产出，已停止本轮（无进展判据 maxIdleTurns=${this.shell.config.maxIdleTurns}）；停在 ${where}`;
    void this.shell.host.bus.emit('terminal_print', { text: `${text}\n` });
    void this.shell.host.bus.emit('companion_notice', { text, tone: 'warn' });
  }

  /**
   * A run the provider ended (#282): the provider retried 429/5xx within its budget and still failed,
   * so the user gets a line instead of a silently missing answer. The reason is truncated; the trace
   * keeps the same account.
   */
  private announceProviderFailure(summary: RunSummary): void {
    const reason = summary.error ?? 'provider_error';
    const kind = classifyEndpointFailure(reason);
    const retryable = kind === 'rate_limit' || /mg_gateway_error:\s*5\d\d/u.test(reason);
    const head = kind === 'rate_limit'
      ? '模型网关限流（429），壳已按预算重试仍未恢复'
      : retryable
        ? '模型网关临时失败（5xx），壳已按预算重试仍未恢复'
        : `模型调用失败（${kind}）`;
    const tail = retryable
      ? '；这句话可以稍后重发，记忆和已完成的工具结果都还在。'
      : '；这不是可重试的网络抖动，先看原因再发。';
    const text = `${head}${tail} 原因：${truncate(reason, 300)}`;
    void this.shell.host.bus.emit('terminal_print', { text: `${text}\n` });
    void this.shell.host.bus.emit('companion_notice', { text, tone: 'warn' });
    this.shell.trace.append('run_failure_announced', { runId: summary.runId, kind, retryable, reason: truncate(reason, 300) });
  }

  /**
   * A completed run closes the assignment; a budget stop keeps it open and writes the place and the
   * next move. A run without an assignment pauses without one. A run error or abort keeps the
   * assignment open too: the work is unfinished, and the next wake must not mistake it for a fresh
   * autonomous idea.
   */
  private settleAssignment(summary: RunSummary, tier: CageTier, trigger: 'message_received' | 'emergence_due'): Trigger {
    const question = this.shell.pendingQuestion;
    this.shell.pendingQuestion = undefined;
    const assignment = this.shell.machine.runtime.openAssignment;
    // A question can only be waited on by a work run; the tool refuses the autonomous tier, and this
    // is the second half of that guard rather than a second policy.
    if (tier !== 'work') return summary.stopReason;
    if (summary.stopReason === 'run_complete' && question) {
      const suspension: Suspension = {
        id: `suspension-${this.shell.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        kind: 'question',
        assignmentId: assignment?.id ?? '',
        createdAt: this.shell.now(),
        runId: summary.runId,
        question,
      };
      this.shell.machine.updateRuntime({
        suspension,
        ...(assignment ? { openAssignment: { ...assignment, lastRunId: summary.runId, stoppedAt: this.shell.now(), nextStep: 'continue the open task with the answer' } } : {}),
      });
      this.shell.trace.append('assignment_paused', {
        runId: summary.runId,
        assignmentId: assignment?.id ?? '',
        suspensionId: suspension.id,
        kind: 'question',
        questionChars: question.text.length,
      });
      return 'question_paused';
    }
    if (summary.stopReason === 'run_complete') {
      this.shell.machine.updateRuntime({ openAssignment: undefined, suspension: undefined });
      return 'run_complete';
    }
    // The run's own closing words are the handoff: bounded, collapsed to one line, and carried into
    // the next run's prompt so a continuation does not re-read the same sources. A run that ends
    // without text (an abort mid-tool) keeps the earlier findings rather than erasing them.
    const findings = assignment ? this.captureFindings(summary, assignment) : undefined;
    // Only an autonomous continuation counts an attempt, and a successful tool result is the
    // progress that resets it (#228). A user-driven run resets the count: the owner is present.
    const progressed = summary.toolResults.some((result) => !result.isError);
    const attempts = trigger === 'emergence_due' && assignment && !progressed ? (assignment.attempts ?? 0) + 1 : 0;
    const nextResumeAt = attempts > 0 ? this.shell.now() + Math.min(RESUME_BACKOFF_BASE_MS * 2 ** (attempts - 1), RESUME_BACKOFF_CAP_MS) : undefined;
    if (summary.stopReason !== 'budget_exceeded') {
      // A no-progress stop is unfinished work like a budget stop, but it ends through the existing
      // run_error edge. It writes the same handoff fields so the next run knows where it stalled.
      const noProgress = summary.error?.startsWith('no_progress:') === true;
      const lastCall = summary.toolCalls.at(-1);
      const stoppedStep = noProgress
        ? lastCall
          ? `${lastCall.toolName} ${truncate(JSON.stringify(lastCall.input ?? {}), 240)}`
          : `after turn ${summary.turns}`
        : undefined;
      const nextStep = noProgress
        ? `continue the open task, but report user-visible progress before repeating the same tool call (the previous run stopped after ${summary.turns} turns with no output)`
        : undefined;
      this.shell.machine.updateRuntime({
        suspension: undefined,
        ...(assignment ? {
          openAssignment: {
            ...assignment,
            lastRunId: summary.runId,
            grant: undefined,
            attempts,
            nextResumeAt,
            ...(findings ? { findings } : {}),
            ...(stoppedStep ? { stoppedStep, nextStep } : {}),
          },
        } : {}),
      });
      if (noProgress && assignment) this.shell.trace.append('assignment_stopped', { runId: summary.runId, assignmentId: assignment.id, stoppedStep, nextStep, findingsChars: findings?.length ?? 0 });
      if (attempts > 0 && assignment) this.shell.trace.append('assignment_backoff', { assignmentId: assignment.id, attempts, nextResumeAt });
      return summary.stopReason;
    }
    const lastCall = summary.toolCalls.at(-1);
    const stoppedStep = lastCall
      ? `${lastCall.toolName} ${truncate(JSON.stringify(lastCall.input ?? {}), 240)}`
      : `after turn ${summary.turns}`;
    const nextStep = lastCall
      ? `resume from ${lastCall.toolName}: check its last result, then continue the user-assigned task`
      : 'continue the user-assigned task from its next step; the budget stopped this run before it finished';
    const estimate = estimateBudgetGrant({ tokens: summary.tokens, turns: summary.turns, limits: this.shell.config.workBudget });
    const violation = this.shell.cage!.violation;
    const suspension: Suspension = {
      id: `suspension-${this.shell.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      kind: 'budget',
      assignmentId: assignment?.id ?? '',
      userText: assignment?.text ?? this.shell.currentRunUserText,
      createdAt: this.shell.now(),
      runId: summary.runId,
      budget: {
        ...(violation?.violation === 'turn_budget' || violation?.violation === 'token_budget' ? { violation: violation.violation } : {}),
        tokens: summary.tokens,
        turns: summary.turns,
        tokensPerTurn: estimate.tokensPerTurn,
        additionalTokens: estimate.tokens,
        additionalTurns: estimate.turns,
        basis: estimate.basis,
      },
    };
    this.shell.machine.updateRuntime({
      suspension,
      ...(assignment ? {
        openAssignment: {
          ...assignment,
          lastRunId: summary.runId,
          stoppedAt: this.shell.now(),
          stoppedStep,
          nextStep,
          grant: undefined,
          attempts,
          nextResumeAt,
          ...(findings ? { findings } : {}),
        },
      } : {}),
    });
    if (assignment) this.shell.trace.append('assignment_stopped', { runId: summary.runId, assignmentId: assignment.id, stoppedStep, nextStep, findingsChars: findings?.length ?? 0 });
    this.shell.trace.append(assignment ? 'assignment_paused' : 'run_paused', {
      runId: summary.runId,
      assignmentId: assignment?.id ?? null,
      suspensionId: suspension.id,
      kind: 'budget',
      additionalTokens: estimate.tokens,
      additionalTurns: estimate.turns,
      tokensPerTurn: Math.round(estimate.tokensPerTurn),
      basis: estimate.basis,
    });
    return 'budget_paused';
  }

  private captureFindings(summary: RunSummary, assignment: { id: string }): string | undefined {
    // The closing message, not the whole run: the handoff is what the run concluded, and the earlier
    // turns are already in the transcript it can recall.
    const text = (summary.lastAssistantText ?? summary.assistantText).replace(/\s+/gu, ' ').trim();
    if (text === '') return undefined;
    if (text.length <= MAX_ASSIGNMENT_FINDINGS) return text;
    this.shell.trace.append('assignment_findings_truncated', {
      assignmentId: assignment.id,
      runId: summary.runId,
      chars: text.length,
      kept: MAX_ASSIGNMENT_FINDINGS,
    });
    return `${text.slice(0, MAX_ASSIGNMENT_FINDINGS - 1)}…`;
  }

}

export async function settleWithin(work: Array<Promise<unknown> | undefined>, timeoutMs: number): Promise<boolean> {
  const pending = work.filter((item): item is Promise<unknown> => item !== undefined);
  if (pending.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

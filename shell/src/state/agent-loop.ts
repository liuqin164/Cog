/**
 * The inner loop: Pi's turn lifecycle, event names and hook positions reused verbatim.
 *
 * A Pi extension that subscribes to `turn_end` or vetoes in `tool_call` sees the same points here.
 * The loop's contract is Pi 1.5.0's turn-boundary triad — `prepareRequest` before every provider
 * request, `finishTurn` for the turn decision, `prepareNextTurn` at the turn boundary — not the
 * earlier `shouldStopAfterTurn` sketch. What is new is only around it: the steering and follow-up
 * queues are native (guidance §一), and the run leaves through this loop's return value so the outer
 * state machine owns the lifecycle.
 */
import type { EventBus } from '../bus.ts';
import type { TraceLog } from '../trace.ts';
import { DEFAULT_RETRY_POLICY, planFailure, sleepAbortable, type RetryPolicy } from './retry.ts';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  isError?: boolean;
}

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  blocked?: { reason: string };
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
  /**
   * Pi's `AssistantMessage.stopReason`, narrowed to what the loop acts on. `length` means the output
   * was cut off by the token limit, so tool-call arguments may have been silently truncated even
   * when they parse (Pi agent-loop's `failToolCallsFromTruncatedMessage`).
   */
  stopReason?: 'stop' | 'length' | 'error' | 'aborted';
  error?: string;
}

export interface ModelCompletionInput {
  messages: AgentMessage[];
  tools: Array<{ name: string; description: string; parameters: unknown; source: string }>;
  systemPrompt: string;
  model: string;
  signal: AbortSignal;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(input: ModelCompletionInput): Promise<ModelTurn>;
}

export interface ToolInvoker {
  list(): Array<{ name: string; description: string; parameters: unknown; source: string }>;
  invoke(name: string, call: ToolCall, ctx: { runId: string; signal: AbortSignal }): Promise<ToolResult>;
}

export interface RunBudget {
  checkTurn(turnIndex: number): { exceeded: boolean; reason?: string };
  addTokens(tokens: number): { exceeded: boolean; reason?: string };
}

/** Pi's `AgentTurnContext`: the completed turn handed to the boundary hooks. */
export interface TurnContext {
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResult[];
}

/**
 * Pi's `AgentTurnDecision`. `end` stops without polling the queues; `continue` guarantees one more
 * request — satisfied by tool results, steering or follow-ups when any are pending, and otherwise by
 * one context-only turn.
 */
export type TurnDecision = { action: 'end' | 'continue' } | void;

/** Pi's `AgentLoopTurnUpdate`: replacement state for the next turn, applied at `prepareNextTurn`. */
export interface TurnUpdate {
  messages?: AgentMessage[];
  systemPrompt?: string;
  model?: string;
}

/** Pi's `AgentRequestUpdate`: replacement request state, applied at `prepareRequest` (polls no queues). */
export interface RequestUpdate {
  messages?: AgentMessage[];
  tools?: Array<{ name: string; description: string; parameters: unknown; source: string }>;
  systemPrompt?: string;
  model?: string;
}

export interface RunSummary {
  runId: string;
  sessionId: string;
  turnId: string;
  userText: string;
  assistantText: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  turns: number;
  tokens: number;
  stopReason: 'run_complete' | 'run_aborted' | 'run_error' | 'budget_exceeded';
  error?: string;
}

export interface AgentRuntimeOptions {
  bus: EventBus;
  tools: ToolInvoker;
  provider: ModelProvider;
  budget: RunBudget;
  systemPrompt: () => string;
  trace?: TraceLog;
  clock?: () => number;
  /** The failure ladder's budget (Pi's `RetrySettings`); defaults to the mg gateway's real one. */
  retry?: RetryPolicy;
  /** Injectable backoff sleep, so a test never waits a real second. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class AgentRuntime {
  private steering: string[] = [];
  private followUps: string[] = [];
  private running = false;
  private abortController?: AbortController;
  private readonly clock: () => number;
  /** The overflow recovery latch: one attempt per run, so a persistently oversized context cannot loop. */
  private overflowRecoveryUsed = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.clock = options.clock ?? Date.now;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get pendingMessages(): number {
    return this.steering.length + this.followUps.length;
  }

  /** RUNNING steer: injected after the current tool batch, before the next turn. */
  steer(text: string): void {
    this.steering.push(text);
  }

  /** Follow-up: injected only when the loop would otherwise end. */
  followUp(text: string): void {
    this.followUps.push(text);
  }

  abort(reason = 'aborted'): void {
    this.options.trace?.append('run_abort_requested', { reason }, this.clock());
    this.abortController?.abort();
  }

  async run(input: { runId: string; sessionId: string; userText: string; signal?: AbortSignal }): Promise<RunSummary> {
    if (this.running) throw new Error('agent_already_running: at most one RUNNING state exists');
    this.running = true;
    this.overflowRecoveryUsed = false;
    const controller = new AbortController();
    this.abortController = controller;
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const messages: AgentMessage[] = [];
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResult[] = [];
    let turns = 0;
    let tokens = 0;
    let stopReason: RunSummary['stopReason'] = 'run_complete';
    let error: string | undefined;
    const turnId = `${input.runId}:0`;
    const userMessage: AgentMessage = { role: 'user', content: input.userText };
    messages.push(userMessage);
    // Pi fires before_agent_start before agent_start; an extension may hand back one injected message
    // (the shape the Cogmem pi extension uses for recall context).
    const beforeStart = await this.options.bus.emit('before_agent_start', {
      type: 'before_agent_start',
      prompt: input.userText,
      messageType: 'user',
    }, { runId: input.runId });
    const injected = (beforeStart as { message?: { content?: unknown } } | undefined)?.message;
    if (injected && injected.content !== undefined) {
      messages.push({ role: 'system', content: typeof injected.content === 'string' ? injected.content : JSON.stringify(injected.content) });
    }
    await this.options.bus.emit('agent_start', { type: 'agent_start', runId: input.runId, messages }, { runId: input.runId });
    await this.emitUserMessage(userMessage, input.runId);

    try {
      for (;;) {
        if (signal.aborted) {
          stopReason = 'run_aborted';
          break;
        }
        const turnIndex = turns + 1;
        const budgetCheck = this.options.budget.checkTurn(turnIndex);
        if (budgetCheck.exceeded) {
          stopReason = 'budget_exceeded';
          error = budgetCheck.reason;
          // The budget owns the `cage_violation` record; the loop only obeys the verdict.
          break;
        }
        turns = turnIndex;
        await this.options.bus.emit('turn_start', { type: 'turn_start', turnIndex }, { runId: input.runId });

        let assistantDraft: AgentMessage = { role: 'assistant', content: '' };
        let terminateRequested = false;
        // Pi's `prepareRequest`: the last assembly gate before every request, including the first.
        // `transformContext` still owns the message pipeline; this hook owns the request's shape
        // (system prompt, model, tool list) and polls no queues.
        const requestSeed: RequestUpdate & { messages: AgentMessage[]; systemPrompt: string; model: string } = {
          messages,
          tools: this.options.tools.list(),
          systemPrompt: this.options.systemPrompt(),
          model: this.options.provider.model,
        };
        const requestUpdate = (await this.options.bus.pipeline('prepareRequest', requestSeed, { runId: input.runId, turnIndex })) as RequestUpdate | undefined;
        const request = requestUpdate && typeof requestUpdate === 'object' ? { ...requestSeed, ...requestUpdate } : requestSeed;
        const requestMessages = await this.projectMessages([...request.messages], input.runId);
        const policy = this.options.retry ?? DEFAULT_RETRY_POLICY;

        // The failure ladder runs inside the turn: a retry re-requests the same turn, so `turns` — and
        // therefore the cage's turn budget — is charged once however many provider calls it took.
        let turn: ModelTurn = { text: '', toolCalls: [] };
        let failedReason: string | undefined;
        for (let attempt = 0; ; ) {
          const draft: AgentMessage = { role: 'assistant', content: '' };
          await this.options.bus.emit('message_start', { type: 'message_start', message: draft }, { runId: input.runId });
          try {
            turn = await this.options.provider.complete({
              // A copy, so each attempt sees the context as of that call. Handing the live array over
              // let a provider that keeps its input (and this suite's scripted provider) observe
              // messages pushed after the call — steering a later turn consumed looked already sent.
              messages: [...requestMessages],
              tools: request.tools ?? this.options.tools.list(),
              systemPrompt: request.systemPrompt,
              model: request.model,
              signal,
            });
          } catch (caught) {
            // A thrown transport failure is the same failure as a provider that reports one in its
            // turn; normalize it so one ladder classifies both.
            turn = { text: '', toolCalls: [], stopReason: 'error', error: caught instanceof Error ? caught.message : String(caught) };
          }
          draft.content = turn.text;
          draft.toolCalls = turn.toolCalls;
          draft.isError = turn.stopReason === 'error';
          await this.options.bus.emit('message_update', { type: 'message_update', message: draft, delta: turn.text }, { runId: input.runId });
          await this.options.bus.emit('message_end', { type: 'message_end', message: draft }, { runId: input.runId });
          messages.push(draft);
          if (turn.stopReason !== 'error') {
            assistantDraft = draft;
            break;
          }
          const plan = planFailure({ message: turn.error ?? 'provider_error', attempt, policy, overflowRecoveryUsed: this.overflowRecoveryUsed });
          this.options.trace?.append('provider_call_failed', {
            runId: input.runId,
            turnIndex,
            kind: plan.kind,
            next: plan.action,
            attempt: plan.action === 'fail' ? attempt : plan.attempt,
            delayMs: plan.action === 'fail' ? 0 : plan.delayMs,
            message: turn.error,
          }, this.clock());
          if (plan.action === 'fail') {
            failedReason = plan.reason;
            break;
          }
          if (plan.action === 'recover_overflow') this.overflowRecoveryUsed = true;
          attempt = plan.attempt;
          if (plan.delayMs > 0) await (this.options.sleep ?? sleepAbortable)(plan.delayMs, signal);
        }
        if (failedReason !== undefined) {
          stopReason = 'run_error';
          error = failedReason;
          break;
        }

        const toolResults: ToolResult[] = [];
        // Pi: a `length` stop means every tool call in the message may carry truncated arguments —
        // the streamed JSON is finalized by a best-effort salvage parser, so a call can parse and
        // validate while being incomplete. None of them are safe to execute; fail the whole batch
        // and let the model re-issue, rather than run a call with half its arguments.
        const truncated = turn.stopReason === 'length';
        if (truncated) {
          this.options.trace?.append('tool_batch_truncated', { runId: input.runId, turnIndex, toolCalls: turn.toolCalls.map((call) => call.toolName) }, this.clock());
        }
        for (const call of turn.toolCalls) {
          allToolCalls.push(call);
          if (truncated) {
            const refused = await this.refuseTruncatedCall(call, input.runId);
            toolResults.push(refused);
            allToolResults.push(refused);
            continue;
          }
          const before = await this.options.bus.emit('beforeToolCall', {
            type: 'beforeToolCall',
            toolCall: call,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          }, { runId: input.runId });
          if (before?.block) {
            const blocked: ToolResult = { toolCallId: call.toolCallId, toolName: call.toolName, output: before.reason ?? 'blocked', isError: true, blocked: { reason: before.reason ?? 'blocked' } };
            toolResults.push(blocked);
            allToolResults.push(blocked);
            this.options.trace?.append('tool_blocked', { runId: input.runId, toolName: call.toolName, reason: before.reason }, this.clock());
            await this.options.bus.emit('tool_execution_end', { type: 'tool_execution_end', toolCallId: call.toolCallId, toolName: call.toolName, result: blocked, isError: true }, { runId: input.runId });
            continue;
          }
          await this.options.bus.emit('tool_execution_start', { type: 'tool_execution_start', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }, { runId: input.runId });
          let result = await this.options.tools.invoke(call.toolName, call, { runId: input.runId, signal });
          const after = await this.options.bus.emit('afterToolCall', { type: 'afterToolCall', toolCall: call, result }, { runId: input.runId });
          if (after && typeof after === 'object' && 'result' in after) result = after.result as ToolResult;
          if (after && typeof after === 'object' && 'terminate' in after && after.terminate) terminateRequested = true;
          toolResults.push(result);
          allToolResults.push(result);
          await this.options.bus.emit('tool_execution_end', { type: 'tool_execution_end', toolCallId: call.toolCallId, toolName: call.toolName, result, isError: result.isError }, { runId: input.runId });
        }
        // Pi appends one tool message per result before the next provider call; without this the model
        // never sees what its own tool returned.
        for (const toolResult of toolResults) {
          messages.push({
            role: 'tool',
            content: toolResult.output,
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            isError: toolResult.isError,
          });
        }
        // Pi's `finishTurn`: after the assistant message and every tool result are in context, and
        // before `turn_end`. `end` stops without polling the queues; `continue` guarantees one more
        // request. Error and abort remain hard exits (they leave through the `catch`).
        const decision = (await this.options.bus.emit(
          'finishTurn',
          { type: 'finishTurn', turnIndex, message: assistantDraft, toolResults },
          { runId: input.runId },
        )) as TurnDecision;
        await this.options.bus.emit('turn_end', { type: 'turn_end', turnIndex, message: assistantDraft, toolResults }, { runId: input.runId });

        if (turn.usage) {
          const tokenTotal = (turn.usage.input ?? 0) + (turn.usage.output ?? 0);
          tokens += tokenTotal;
          const tokenCheck = this.options.budget.addTokens(tokenTotal);
          if (tokenCheck.exceeded) {
            stopReason = 'budget_exceeded';
            error = tokenCheck.reason;
            break;
          }
        }

        if (terminateRequested || decision?.action === 'end') {
          stopReason = 'run_complete';
          break;
        }

        const steeringPending = this.steering.length > 0;
        const followUpPending = this.followUps.length > 0;
        const explicitContinue = decision?.action === 'continue';
        if (turn.toolCalls.length === 0 && !steeringPending && !followUpPending && !explicitContinue) break;

        // Pi's `prepareNextTurn`: after `turn_end` and before the next turn begins — the formal turn
        // boundary (compaction is its canonical Pi user; here it is also where the steering boundary
        // is settled). A long handler may take new steering while it runs, so the queue is read again
        // after it: the re-poll is what keeps a line typed during a long prepare from being dropped,
        // and it is the reason a steering message's own turn gets a fresh recall (guidance #7) — the
        // next request runs `transformContext` against that new last user line.
        const prepared = (await this.options.bus.emit(
          'prepareNextTurn',
          { type: 'prepareNextTurn', turnIndex, message: assistantDraft, toolResults },
          { runId: input.runId },
        )) as TurnUpdate | undefined;
        for (const message of prepared?.messages ?? []) {
          messages.push(message);
          await this.emitUserMessage(message, input.runId);
        }
        this.options.trace?.append('prepare_next_turn', {
          runId: input.runId,
          afterTurn: turnIndex,
          preparedMessages: prepared?.messages?.length ?? 0,
          steeringPending: this.steering.length,
          followUpPending: this.followUps.length,
          explicitContinue,
        }, this.clock());

        if (this.steering.length > 0) {
          await this.drainSteering(messages, input.runId, turnIndex);
          continue;
        }
        if (turn.toolCalls.length > 0) continue;
        if (this.followUps.length > 0) {
          const text = this.followUps.shift()!;
          const queued: AgentMessage = { role: 'user', content: text };
          messages.push(queued);
          await this.emitUserMessage(queued, input.runId);
          continue;
        }
        // `{ action: 'continue' }` with nothing else to schedule: one context-only turn.
        continue;
      }
    } catch (caught) {
      stopReason = signal.aborted ? 'run_aborted' : 'run_error';
      error = caught instanceof Error ? caught.message : String(caught);
      this.options.trace?.append('run_error', { runId: input.runId, message: error }, this.clock());
    } finally {
      this.running = false;
      this.abortController = undefined;
    }

    const assistantText = messages.filter((message) => message.role === 'assistant').map((message) => message.content).filter(Boolean).join('\n');
    const summary: RunSummary = {
      runId: input.runId,
      sessionId: input.sessionId,
      turnId,
      userText: input.userText,
      assistantText,
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      turns,
      tokens,
      stopReason,
      error,
    };
    try {
      await this.options.bus.emit('agent_end', { type: 'agent_end', runId: input.runId, messages, summary }, { runId: input.runId });
    } catch (caught) {
      // `agent_end` is where capture writes the run's account to the ledger. A handler failing there
      // makes the account incomplete, so the run is reported as `run_error` and the caller leaves
      // RUNNING through the legal edge. Letting the rejection escape `run()` instead is what wedged
      // the machine in RUNNING with its exit transition never dispatched. Nothing is swallowed: the
      // summary carries the message and the trace names the hook.
      const message = caught instanceof Error ? caught.message : String(caught);
      this.options.trace?.append('agent_end_hook_failed', { runId: input.runId, message }, this.clock());
      summary.stopReason = 'run_error';
      summary.error = `agent_end_hook_failed: ${message}`;
    }
    return summary;
  }

  /**
   * Steering drains here: after the turn's tool batch, before the next turn begins. The trace record
   * makes the timing legible — a long tool call is exactly when a user types, and the survival run
   * needs to read back which turn their line landed on.
   */
  private async drainSteering(messages: AgentMessage[], runId: string, afterTurn: number): Promise<void> {
    const count = this.steering.length;
    while (this.steering.length > 0) {
      const queued: AgentMessage = { role: 'user', content: this.steering.shift()! };
      messages.push(queued);
      await this.emitUserMessage(queued, runId);
    }
    this.options.trace?.append('steering_injected', { runId, afterTurn, beforeTurn: afterTurn + 1, count }, this.clock());
  }

  /**
   * Pi's `failToolCallsFromTruncatedMessage`: in a `length`-truncated message every call becomes an
   * error the model can read and correct. `beforeToolCall` does not run because nothing executes, but
   * the start/end pair is still emitted so capture records the call and its refusal.
   */
  private async refuseTruncatedCall(call: ToolCall, runId: string): Promise<ToolResult> {
    await this.options.bus.emit('tool_execution_start', { type: 'tool_execution_start', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }, { runId });
    const result: ToolResult = {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: `tool_not_executed: "${call.toolName}" was not executed because the response hit the output token limit, so its arguments may be truncated. Re-issue the call with complete arguments.`,
      isError: true,
    };
    await this.options.bus.emit('tool_execution_end', { type: 'tool_execution_end', toolCallId: call.toolCallId, toolName: call.toolName, result, isError: true }, { runId });
    return result;
  }

  /** Pi emits the user message on the same start/end pair the assistant uses. */
  private async emitUserMessage(message: AgentMessage, runId: string): Promise<void> {
    await this.options.bus.emit('message_start', { type: 'message_start', message }, { runId });
    await this.options.bus.emit('message_end', { type: 'message_end', message }, { runId });
  }

  /** One context pipeline (`transformContext` in Pi terms), then the messages reach the provider. */
  private async projectMessages(messages: AgentMessage[], runId: string): Promise<AgentMessage[]> {
    const projected = await this.options.bus.pipeline('transformContext', messages, { runId });
    return Array.isArray(projected) ? (projected as AgentMessage[]) : messages;
  }
}

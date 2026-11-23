import { CONVERSATION_CAPTURE_LANE, KernelAgentMemoryBackend, type AgentTurnReceipt, type MemoryEvent, type MemoryKernel } from 'cogmem';
import type { RunSummary } from '../state/agent-loop.ts';
import { SecretRedactor } from '../kernel-host.ts';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin } from './host.ts';

export const MAX_CAPTURED_TOOL_RESULT_CHARS = 48_000;
const MEMORY_REQUEST_RE = /记住|不要忘记|别忘记|remember|don't forget/i;
const TOOL_REFERENCE_RE = /工具|读取|读到|文件|结果|这条|这个|tool|read|result/i;
const TOOL_OBSERVATION_PROMOTED_KEY = 'toolObservationPromoted';

function promotesToolObservations(userText: string): boolean {
  return MEMORY_REQUEST_RE.test(userText) && TOOL_REFERENCE_RE.test(userText);
}

function boundToolResult(text: string): string {
  if (text.length <= MAX_CAPTURED_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_CAPTURED_TOOL_RESULT_CHARS)}\n\n[tool result truncated: ${text.length - MAX_CAPTURED_TOOL_RESULT_CHARS} chars omitted]`;
}

export interface CaptureServiceOptions {
  backend: KernelAgentMemoryBackend;
  kernel: MemoryKernel;
  agentId: string;
  projectId: string;
  sessionId: string;
  channel?: () => string;
  redactor?: SecretRedactor;
  trace?: TraceLog;
  paused?: () => boolean;
}

export interface CaptureResult {
  turnId: string;
  userEventId?: string;
  assistantEventId?: string;
  toolCallEventIds: string[];
  toolResultEventIds: string[];
  redactionCount: number;
  receipt?: AgentTurnReceipt;
}

export interface CapturedTurn {
  userEventId: string;
  assistantEventIds: string[];
  toolCallEventIds: string[];
  toolResultEventIds: string[];
  redactionCount: number;
  userText: string;
}

export class CaptureService {
  private readonly redactor: SecretRedactor;

  constructor(private readonly options: CaptureServiceOptions) {
    this.redactor = options.redactor ?? new SecretRedactor();
  }

  /** The gate the pause command closes; the only predicate every write path in this module reads. */
  paused(): boolean {
    return this.options.paused?.() === true;
  }

  recordMessage(input: {
    threadId: string;
    turnId: string;
    turnSeq?: number;
    role: 'user' | 'assistant';
    content: string;
    eventOrdinal: number;
    parentEventId?: string;
    prevEventId?: string;
    causalityType?: 'replies_to';
  }): { event: MemoryEvent; redactions: number; turnSeq: number } | undefined {
    if (this.paused()) return undefined;
    const { kernel, agentId, projectId, sessionId } = this.options;
    const channel = this.options.channel?.();
    const marked = this.redactor.mark(input.content);
    const turnSeq = input.turnSeq ?? this.options.backend.nextTurnSeq(input.threadId, projectId);
    const event = kernel.recordRawEvent({
      projectId,
      workspaceId: projectId,
      threadId: input.threadId,
      sessionId,
      turnId: input.turnId,
      turnSeq,
      role: input.role,
      content: marked.value,
      eventOrdinal: input.eventOrdinal,
      parentEventId: input.parentEventId,
      prevEventId: input.prevEventId,
      causalityType: input.causalityType,
      sourceId: `${agentId}:${sessionId}`,
      metadata: { sourceAgent: agentId, source: 'companion-shell', kind: 'turn', captureLane: CONVERSATION_CAPTURE_LANE, ...(channel ? { channel } : {}), ...marked.metadata },
    });
    return { event, redactions: markTotal(marked.metadata), turnSeq };
  }

  async recordToolCall(input: {
    threadId: string;
    turnId: string;
    turnSeq: number;
    assistantEventId?: string;
    toolCallId: string;
    toolName: string;
    input?: unknown;
    eventOrdinal: number;
  }): Promise<{ event: MemoryEvent; redactions: number } | undefined> {
    if (this.paused()) return undefined;
    const { backend, agentId, projectId, sessionId } = this.options;
    const marked = this.redactor.mark(input.input);
    const event = await backend.ingestToolCall({
      agentId,
      projectId,
      workspaceId: projectId,
      sessionId,
      threadId: input.threadId,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      assistantEventId: input.assistantEventId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: marked.value,
      eventOrdinal: input.eventOrdinal,
      metadata: { sourceAgent: agentId, ...marked.metadata },
    });
    return { event, redactions: markTotal(marked.metadata) };
  }

  async recordToolResult(input: {
    threadId: string;
    turnId: string;
    turnSeq: number;
    toolCallEventId: string;
    toolCallId: string;
    toolName: string;
    output: string;
    isError: boolean;
    eventOrdinal: number;
    promotesToolObservation?: boolean;
  }): Promise<{ event: MemoryEvent; redactions: number } | undefined> {
    if (this.paused()) return undefined;
    const { backend, agentId, projectId, sessionId } = this.options;
    const marked = this.redactor.mark(input.output);
    const event = await backend.ingestToolObservation({
      agentId,
      projectId,
      workspaceId: projectId,
      sessionId,
      threadId: input.threadId,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      toolCallEventId: input.toolCallEventId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: boundToolResult(marked.value),
      eventOrdinal: input.eventOrdinal,
      metadata: {
        sourceAgent: agentId,
        isError: input.isError,
        ...(input.promotesToolObservation ? { [TOOL_OBSERVATION_PROMOTED_KEY]: true } : {}),
        ...marked.metadata,
      },
    });
    return { event, redactions: markTotal(marked.metadata) };
  }

  async finalizeRun(summary: RunSummary, threadId: string, captured: CapturedTurn): Promise<CaptureResult> {
    if (this.paused()) {
      this.options.trace?.append('capture_paused', {
        kind: 'run',
        runId: summary.runId,
        turnId: summary.turnId,
        toolCalls: summary.toolCalls.length,
        toolResults: summary.toolResults.length,
        userChars: summary.userText.length,
        assistantChars: summary.assistantText.length,
      });
      return { turnId: summary.turnId, toolCallEventIds: [], toolResultEventIds: [], redactionCount: 0 };
    }
    const { backend, agentId, projectId, sessionId } = this.options;
    const channel = this.options.channel?.();
    const assistantEventId = captured.assistantEventIds.at(-1);
    const result = await backend.rememberTurnWithResult({
      agentId,
      projectId,
      workspaceId: projectId,
      sessionId,
      threadId,
      turnId: summary.turnId,
      userText: captured.userText,
      assistantText: summary.assistantText || undefined,
      ingestMode: 'selective_compile',
      metadata: { sourceAgent: agentId, source: 'companion-shell', kind: 'turn', captureLane: CONVERSATION_CAPTURE_LANE, ...(channel ? { channel } : {}) },
      prewritten: { userEventId: captured.userEventId, assistantEventIds: captured.assistantEventIds },
    });
    this.options.trace?.append('capture_run', {
      runId: summary.runId,
      turnId: summary.turnId,
      redactionCount: captured.redactionCount,
      toolCalls: summary.toolCalls.length,
      toolResults: summary.toolResults.length,
    });
    return {
      turnId: summary.turnId,
      userEventId: captured.userEventId,
      assistantEventId,
      toolCallEventIds: captured.toolCallEventIds,
      toolResultEventIds: captured.toolResultEventIds,
      redactionCount: captured.redactionCount,
      ...(result.receipt ? { receipt: result.receipt } : {}),
    };
  }

  async captureRun(summary: RunSummary, threadId: string): Promise<CaptureResult> {
    if (this.paused()) {
      this.options.trace?.append('capture_paused', {
        kind: 'run',
        runId: summary.runId,
        turnId: summary.turnId,
        toolCalls: summary.toolCalls.length,
        toolResults: summary.toolResults.length,
        userChars: summary.userText.length,
        assistantChars: summary.assistantText.length,
      });
      return { turnId: summary.turnId, toolCallEventIds: [], toolResultEventIds: [], redactionCount: 0 };
    }
    if (summary.origin === 'emergence') return this.captureAutonomousRun(summary, threadId);
    const { backend, agentId, projectId, sessionId } = this.options;
    const channel = this.options.channel?.();
    const user = this.redactor.mark(summary.userText);
    const assistant = this.redactor.mark(summary.assistantText);
    const marks = mergeMarks([user.metadata, assistant.metadata]);
    let redactionCount = markTotal(user.metadata) + markTotal(assistant.metadata);
    const result = await backend.rememberTurnWithResult({
      agentId,
      projectId,
      workspaceId: projectId,
      sessionId,
      threadId,
      turnId: summary.turnId,
      userText: user.value,
      assistantText: assistant.value || undefined,
      ingestMode: 'selective_compile',
      metadata: { sourceAgent: agentId, source: 'companion-shell', kind: 'turn', captureLane: CONVERSATION_CAPTURE_LANE, ...(channel ? { channel } : {}), ...marks },
    });
    const assistantEventId = result.rawEventIds[1];
    const toolCallEventIds: string[] = [];
    const toolResultEventIds: string[] = [];
    const byCallId = new Map<string, string>();
    const promotesToolObservation = promotesToolObservations(summary.userText);
    for (const call of summary.toolCalls) {
      const input = this.redactor.mark(call.input);
      redactionCount += markTotal(input.metadata);
      const event = await backend.ingestToolCall({
        agentId,
        projectId,
        workspaceId: projectId,
        sessionId,
        threadId,
        turnId: summary.turnId,
        assistantEventId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: input.value,
        metadata: { sourceAgent: agentId, ...input.metadata },
      });
      toolCallEventIds.push(event.eventId);
      byCallId.set(call.toolCallId, event.eventId);
    }
    for (const resultEntry of summary.toolResults) {
      const toolCallEventId = byCallId.get(resultEntry.toolCallId);
      if (!toolCallEventId) continue;
      const output = this.redactor.mark(resultEntry.output);
      redactionCount += markTotal(output.metadata);
      const event = await backend.ingestToolObservation({
        agentId,
        projectId,
        workspaceId: projectId,
        sessionId,
        threadId,
        turnId: summary.turnId,
        toolCallEventId,
        toolCallId: resultEntry.toolCallId,
        toolName: resultEntry.toolName,
        output: boundToolResult(output.value),
        metadata: {
          sourceAgent: agentId,
          isError: resultEntry.isError,
          ...(promotesToolObservation ? { [TOOL_OBSERVATION_PROMOTED_KEY]: true } : {}),
          ...output.metadata,
        },
      });
      toolResultEventIds.push(event.eventId);
    }

    this.options.trace?.append('capture_run', {
      runId: summary.runId,
      turnId: summary.turnId,
      redactionCount,
      toolCalls: summary.toolCalls.length,
      toolResults: summary.toolResults.length,
    });
    return {
      turnId: summary.turnId,
      userEventId: result.rawEventIds[0],
      assistantEventId,
      toolCallEventIds,
      toolResultEventIds,
      redactionCount,
      ...(result.receipt ? { receipt: result.receipt } : {}),
    };
  }

  private async captureAutonomousRun(summary: RunSummary, threadId: string): Promise<CaptureResult> {
    const { backend, agentId, projectId, sessionId } = this.options;
    const assistant = this.redactor.mark(summary.assistantText || '(no assistant text)');
    let redactionCount = markTotal(assistant.metadata);
    const event = await backend.ingestTaskEvent({
      agentId,
      projectId,
      workspaceId: projectId,
      sessionId,
      threadId,
      turnId: summary.turnId,
      title: 'autonomous run',
      content: assistant.value,
      metadata: {
        sourceAgent: agentId,
        source: 'companion-shell',
        kind: 'autonomous-run',
        origin: 'emergence',
        ...assistant.metadata,
      },
    });
    const assistantEventId = event.eventId;
    const toolCallEventIds: string[] = [];
    const toolResultEventIds: string[] = [];
    const byCallId = new Map<string, string>();
    for (const call of summary.toolCalls) {
      const input = this.redactor.mark(call.input);
      redactionCount += markTotal(input.metadata);
      const toolEvent = await backend.ingestToolCall({
        agentId,
        projectId,
        workspaceId: projectId,
        sessionId,
        threadId,
        turnId: summary.turnId,
        assistantEventId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: input.value,
        metadata: { sourceAgent: agentId, origin: 'emergence', ...input.metadata },
      });
      toolCallEventIds.push(toolEvent.eventId);
      byCallId.set(call.toolCallId, toolEvent.eventId);
    }
    for (const resultEntry of summary.toolResults) {
      const toolCallEventId = byCallId.get(resultEntry.toolCallId);
      if (!toolCallEventId) continue;
      const output = this.redactor.mark(resultEntry.output);
      redactionCount += markTotal(output.metadata);
      const toolEvent = await backend.ingestToolObservation({
        agentId,
        projectId,
        workspaceId: projectId,
        sessionId,
        threadId,
        turnId: summary.turnId,
        toolCallEventId,
        toolCallId: resultEntry.toolCallId,
        toolName: resultEntry.toolName,
        output: boundToolResult(output.value),
        metadata: { sourceAgent: agentId, origin: 'emergence', isError: resultEntry.isError, ...output.metadata },
      });
      toolResultEventIds.push(toolEvent.eventId);
    }
    this.options.trace?.append('capture_run', {
      runId: summary.runId,
      turnId: summary.turnId,
      origin: 'emergence',
      redactionCount,
      toolCalls: summary.toolCalls.length,
      toolResults: summary.toolResults.length,
    });
    return { turnId: summary.turnId, assistantEventId, toolCallEventIds, toolResultEventIds, redactionCount };
  }

  /** A terminal session record: same redaction and marking, written as a task event. */
  async captureTerminalRecord(text: string, threadId: string, title = 'terminal record'): Promise<MemoryEvent | undefined> {
    if (this.paused()) {
      this.options.trace?.append('capture_paused', { kind: 'terminal-record', threadId, chars: text.length });
      return undefined;
    }
    const { backend, agentId, projectId, sessionId } = this.options;
    const redacted = this.redactor.mark(text);
    return backend.ingestTaskEvent({
      agentId,
      projectId,
      workspaceId: projectId,
      sessionId,
      threadId,
      title,
      content: redacted.value,
      metadata: { sourceAgent: agentId, kind: 'terminal-record', ...redacted.metadata },
    });
  }
}

function markTotal(metadata: Record<string, unknown>): number {
  return Number((metadata.secretFindings as { total?: number } | undefined)?.total ?? 0);
}

function mergeMarks(list: Array<Record<string, unknown>>): Record<string, unknown> {
  let total = 0;
  let chars = 0;
  for (const mark of list) {
    total += markTotal(mark);
    chars += Number((mark.redaction as { chars?: number } | undefined)?.chars ?? 0);
  }
  if (total === 0) return {};
  return { secretFindings: { total }, redaction: { count: total, chars } };
}

export interface CapturePluginConfig {
  agentId: string;
  projectId: string;
  sessionId: string;
  channel?: () => string;
  /** The shell's `/pause` gate; see {@link CaptureServiceOptions.paused}. */
  paused?: () => boolean;
}

export function capturePlugin(config: CapturePluginConfig): NativePlugin {
  return {
    name: 'capture',
    inject: ['eventBus', 'memory', 'kernel', 'clock', 'trace'],
    provide: ['capture'],
    apply(ctx) {
      const backend = ctx.getService<KernelAgentMemoryBackend>('memory');
      const kernel = ctx.getService<MemoryKernel>('kernel');
      const clock = ctx.getService<{ localDate(at?: number): string }>('clock');
      const trace = ctx.getService<TraceLog>('trace');
      const eventBus = ctx.getService<{ emit(name: string, payload: unknown): unknown }>('eventBus');
      const service = new CaptureService({
        backend,
        kernel,
        agentId: config.agentId,
        projectId: config.projectId,
        get sessionId() {
          return config.sessionId;
        },
        channel: config.channel,
        trace,
        paused: config.paused,
      });
      interface Buffer {
        userText: string;
        assistantText: string[];
        toolCalls: RunSummary['toolCalls'];
        toolResults: RunSummary['toolResults'];
        userEventId?: string;
        primaryUserText?: string;
        assistantEventIds: string[];
        toolCallEventIds: string[];
        toolResultEventIds: string[];
        byCallId: Map<string, string>;
        turnSeq?: number;
        ordinal: number;
        redactionCount: number;
      }
      const buffers = new Map<string, Buffer>();
      let previousToolResultEventIds: string[] = [];
      const ensure = (runId: string): Buffer => {
        const existing = buffers.get(runId);
        if (existing) return existing;
        const created: Buffer = {
          userText: '',
          assistantText: [],
          toolCalls: [],
          toolResults: [],
          assistantEventIds: [],
          toolCallEventIds: [],
          toolResultEventIds: [],
          byCallId: new Map(),
          ordinal: 0,
          redactionCount: 0,
        };
        buffers.set(runId, created);
        return created;
      };
      ctx.on('message_end', async (event: { message?: { role?: string; content?: string; toolsAdded?: string[]; toolsRemoved?: string[] } }, busCtx?: { runId?: string }) => {
        if (!busCtx?.runId) return;
        const added = event.message?.toolsAdded ?? [];
        const removed = event.message?.toolsRemoved ?? [];
        if (event.message?.role === 'system' && (added.length > 0 || removed.length > 0)) {
          if (service.paused()) {
            trace?.append('capture_paused', { kind: 'tool-loadout', toolsAdded: added.length, toolsRemoved: removed.length });
            return;
          }
          await backend.ingestTaskEvent({
            agentId: config.agentId,
            projectId: config.projectId,
            workspaceId: config.projectId,
            sessionId: config.sessionId,
            threadId: `companion-day:${clock.localDate()}`,
            title: 'tool-loadout declaration',
            content: JSON.stringify({ toolsAdded: added, toolsRemoved: removed }),
            metadata: { sourceAgent: config.agentId, source: 'companion-shell', kind: 'tool-loadout', toolsAdded: added, toolsRemoved: removed },
          });
          return;
        }
        const buffer = ensure(busCtx.runId);
        const content = event.message?.content ?? '';
        if (event.message?.role === 'user') {
          if (promotesToolObservations(content) && previousToolResultEventIds.length > 0) {
            for (const eventId of previousToolResultEventIds) backend.markToolObservationPromoted(eventId);
            previousToolResultEventIds = [];
          }
          buffer.userText = content;
          const written = service.recordMessage({
            threadId: `companion-day:${clock.localDate()}`,
            turnId: `${busCtx.runId}:0`,
            turnSeq: buffer.turnSeq,
            role: 'user',
            content,
            eventOrdinal: ++buffer.ordinal,
          });
          if (written) {
            buffer.turnSeq = written.turnSeq;
            buffer.redactionCount += written.redactions;
            if (!buffer.userEventId) {
              buffer.userEventId = written.event.eventId;
              buffer.primaryUserText = content;
            }
          }
        }
        if (event.message?.role === 'assistant' && content) {
          buffer.assistantText.push(content);
          if (buffer.userEventId) {
            const written = service.recordMessage({
              threadId: `companion-day:${clock.localDate()}`,
              turnId: `${busCtx.runId}:0`,
              turnSeq: buffer.turnSeq,
              role: 'assistant',
              content,
              eventOrdinal: ++buffer.ordinal,
              parentEventId: buffer.assistantEventIds.at(-1) ?? buffer.userEventId,
              prevEventId: buffer.assistantEventIds.at(-1) ?? buffer.userEventId,
              causalityType: 'replies_to',
            });
            if (written) {
              buffer.assistantEventIds.push(written.event.eventId);
              buffer.redactionCount += written.redactions;
            }
          }
        }
      });
      ctx.on('tool_execution_start', async (event: { toolCallId?: string; toolName?: string; input?: unknown }, busCtx?: { runId?: string }) => {
        if (!busCtx?.runId || !event.toolCallId || !event.toolName) return;
        const buffer = ensure(busCtx.runId);
        buffer.toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
        if (!buffer.userEventId || buffer.turnSeq === undefined) return;
        const written = await service.recordToolCall({
          threadId: `companion-day:${clock.localDate()}`,
          turnId: `${busCtx.runId}:0`,
          turnSeq: buffer.turnSeq,
          assistantEventId: buffer.assistantEventIds.at(-1) ?? buffer.userEventId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          eventOrdinal: ++buffer.ordinal,
        });
        if (written) {
          buffer.toolCallEventIds.push(written.event.eventId);
          buffer.byCallId.set(event.toolCallId, written.event.eventId);
          buffer.redactionCount += written.redactions;
        }
      });
      ctx.on('tool_execution_end', async (event: { toolCallId?: string; toolName?: string; result?: RunSummary['toolResults'][number] }, busCtx?: { runId?: string }) => {
        if (!busCtx?.runId || !event.result) return;
        const buffer = ensure(busCtx.runId);
        buffer.toolResults.push(event.result);
        const toolCallEventId = event.toolCallId ? buffer.byCallId.get(event.toolCallId) : undefined;
        if (!toolCallEventId || !event.result.toolCallId || buffer.turnSeq === undefined) return;
        const written = await service.recordToolResult({
          threadId: `companion-day:${clock.localDate()}`,
          turnId: `${busCtx.runId}:0`,
          turnSeq: buffer.turnSeq,
          toolCallEventId,
          toolCallId: event.result.toolCallId,
          toolName: event.result.toolName,
          output: event.result.output,
          isError: event.result.isError,
          eventOrdinal: ++buffer.ordinal,
          promotesToolObservation: promotesToolObservations(buffer.userText),
        });
        if (written) {
          buffer.toolResultEventIds.push(written.event.eventId);
          buffer.redactionCount += written.redactions;
        }
      });
      ctx.on('agent_end', async (event: { summary?: RunSummary }, busCtx?: { runId?: string }) => {
        const runId = busCtx?.runId ?? event.summary?.runId;
        if (!runId) return;
        const origin = event.summary?.origin ?? 'user';
        const buffer = buffers.get(runId);
        if (!buffer && origin === 'user') return;
        const toolResultEventIds = buffer?.toolResultEventIds ?? [];
        buffers.delete(runId);
        const summary: RunSummary = {
          runId,
          sessionId: event.summary?.sessionId ?? config.sessionId,
          turnId: event.summary?.turnId ?? `${runId}:0`,
          origin,
          userText: buffer?.userText ?? '',
          assistantText: buffer?.assistantText.join('\n') ?? '',
          toolCalls: buffer?.toolCalls ?? [],
          toolResults: buffer?.toolResults ?? [],
          turns: event.summary?.turns ?? 0,
          tokens: event.summary?.tokens ?? 0,
          stopReason: event.summary?.stopReason ?? 'run_complete',
          error: event.summary?.error,
        };
        const threadId = `companion-day:${clock.localDate()}`;
        try {
          if (origin === 'user' && buffer?.userEventId) {
            const result = await service.finalizeRun(summary, threadId, {
              userEventId: buffer.userEventId,
              assistantEventIds: buffer.assistantEventIds,
              toolCallEventIds: buffer.toolCallEventIds,
              toolResultEventIds: buffer.toolResultEventIds,
              redactionCount: buffer.redactionCount,
              userText: buffer.primaryUserText ?? buffer.userText,
            });
            if (result.receipt) await eventBus.emit('commitment_receipt', result.receipt);
            previousToolResultEventIds = toolResultEventIds;
          } else {
            const result = await service.captureRun(summary, threadId);
            if (result.receipt) await eventBus.emit('commitment_receipt', result.receipt);
          }
        } catch (error) {
          trace?.append('capture_failed', {
            runId,
            turnId: summary.turnId,
            message: error instanceof Error ? error.message : String(error),
            userChars: summary.userText.length,
            assistantChars: summary.assistantText.length,
            toolCalls: summary.toolCalls.length,
            toolResults: summary.toolResults.length,
          });
          throw error;
        }
      });
      ctx.provide('capture', service);
    },
  };
}

/**
 * Conversation capture: every captured text goes through the kernel ingest path, redacted before it
 * is written and marked with what was removed.
 *
 * `bash`/`read` tool output, the assistant reply and the terminal record all arrive here. The shell
 * redacts with the kernel's own pattern table (see SecretRedactor for why the public surface has no
 * alternative) and then writes through the exported `KernelAgentMemoryBackend`, so the events carry
 * `metadata.secretFindings` — the same key the kernel's suppression checks read — plus a
 * `metadata.redaction` count.
 */
import { KernelAgentMemoryBackend, type MemoryEvent } from 'cogmem';
import type { RunSummary } from '../state/agent-loop.ts';
import { SecretRedactor } from '../kernel-host.ts';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin } from './host.ts';

export interface CaptureServiceOptions {
  backend: KernelAgentMemoryBackend;
  agentId: string;
  projectId: string;
  sessionId: string;
  redactor?: SecretRedactor;
  trace?: TraceLog;
}

export interface CaptureResult {
  turnId: string;
  userEventId?: string;
  assistantEventId?: string;
  toolCallEventIds: string[];
  toolResultEventIds: string[];
  redactionCount: number;
}

export class CaptureService {
  private readonly redactor: SecretRedactor;

  constructor(private readonly options: CaptureServiceOptions) {
    this.redactor = options.redactor ?? new SecretRedactor();
  }

  async captureRun(summary: RunSummary, threadId: string): Promise<CaptureResult> {
    const { backend, agentId, projectId, sessionId } = this.options;
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
      metadata: { sourceAgent: agentId, source: 'companion-shell', kind: 'turn', ...marks },
    });
    const assistantEventId = result.rawEventIds[1];
    const toolCallEventIds: string[] = [];
    const toolResultEventIds: string[] = [];
    const byCallId = new Map<string, string>();
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
        output: output.value,
        metadata: { sourceAgent: agentId, isError: resultEntry.isError, ...output.metadata },
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
    };
  }

  /** A terminal session record: same redaction and marking, written as a task event. */
  async captureTerminalRecord(text: string, threadId: string, title = 'terminal record'): Promise<MemoryEvent> {
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
}

/**
 * The capture plugin: it accumulates the raw message and tool stream (`message_end`,
 * `tool_execution_*`) and flushes the finished run on `agent_end`.
 *
 * The stream is the point (guidance conflict #6): capture reads the events the model actually
 * produced, before any compaction or projection, and only the flush writes to the kernel. It is a
 * plugin rather than core so a channel that should not be recorded simply does not load it.
 */
export function capturePlugin(config: CapturePluginConfig): NativePlugin {
  return {
    name: 'capture',
    inject: ['eventBus', 'memory', 'clock'],
    provide: ['capture'],
    apply(ctx) {
      const backend = ctx.getService<KernelAgentMemoryBackend>('memory');
      const clock = ctx.getService<{ localDate(at?: number): string }>('clock');
      const trace = ctx.getService<TraceLog>('trace');
      const service = new CaptureService({
        backend,
        agentId: config.agentId,
        projectId: config.projectId,
        sessionId: config.sessionId,
        trace,
      });
      interface Buffer {
        userText: string;
        assistantText: string[];
        toolCalls: RunSummary['toolCalls'];
        toolResults: RunSummary['toolResults'];
      }
      const buffers = new Map<string, Buffer>();
      const ensure = (runId: string): Buffer => {
        const existing = buffers.get(runId);
        if (existing) return existing;
        const created: Buffer = { userText: '', assistantText: [], toolCalls: [], toolResults: [] };
        buffers.set(runId, created);
        return created;
      };
      ctx.on('message_end', (event: { message?: { role?: string; content?: string } }, busCtx?: { runId?: string }) => {
        if (!busCtx?.runId) return;
        const buffer = ensure(busCtx.runId);
        if (event.message?.role === 'user') buffer.userText = event.message.content ?? '';
        if (event.message?.role === 'assistant' && event.message.content) buffer.assistantText.push(event.message.content);
      });
      ctx.on('tool_execution_start', (event: { toolCallId?: string; toolName?: string; input?: unknown }, busCtx?: { runId?: string }) => {
        if (!busCtx?.runId || !event.toolCallId || !event.toolName) return;
        ensure(busCtx.runId).toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
      });
      ctx.on('tool_execution_end', (event: { toolCallId?: string; toolName?: string; result?: RunSummary['toolResults'][number] }, busCtx?: { runId?: string }) => {
        if (!busCtx?.runId || !event.result) return;
        ensure(busCtx.runId).toolResults.push(event.result);
      });
      ctx.on('agent_end', async (event: { summary?: RunSummary }, busCtx?: { runId?: string }) => {
        const runId = busCtx?.runId ?? event.summary?.runId;
        if (!runId) return;
        const buffer = buffers.get(runId);
        if (!buffer) return;
        buffers.delete(runId);
        const summary: RunSummary = {
          runId,
          sessionId: event.summary?.sessionId ?? config.sessionId,
          turnId: event.summary?.turnId ?? `${runId}:0`,
          userText: buffer.userText,
          assistantText: buffer.assistantText.join('\n'),
          toolCalls: buffer.toolCalls,
          toolResults: buffer.toolResults,
          turns: event.summary?.turns ?? 0,
          tokens: event.summary?.tokens ?? 0,
          stopReason: event.summary?.stopReason ?? 'run_complete',
          error: event.summary?.error,
        };
        const threadId = `companion-day:${clock.localDate()}`;
        await service.captureRun(summary, threadId);
      });
      ctx.provide('capture', service);
    },
  };
}

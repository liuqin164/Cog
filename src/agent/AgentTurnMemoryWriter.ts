import type { MemoryKernel } from '../factory.js';
import { excludeExplicitSpans } from '../context/ExplicitExclusion.js';
import { hasLongTermMemorySignal } from '../lexicon/coreMemoryLexicon.js';
import { secretFindingsMetadata } from '../security/SecretPatterns.js';
import type { MemoryEvent } from '../types/index.js';
import { collectionTags, metadataWithCollection } from './AgentMemoryScope.js';
import { omitSecretFindings } from './AgentRecallText.js';
import { buildAgentTurnReceipt, withAgentTurnReceipt } from '../store/CommitmentReceipt.js';
import type {
  AgentTaskEventMemory,
  AgentToolCallMemory,
  AgentToolObservationMemory,
  AgentTurnCompileReason,
  AgentTurnIngestMode,
  AgentTurnMemory,
  AgentTurnMemoryResult,
} from './AgentMemoryTypes.js';

export class AgentTurnMemoryWriter {
  constructor(private readonly kernel: MemoryKernel) {}

  async rememberTurn(turn: AgentTurnMemory): Promise<void> {
    await this.rememberTurnWithResult(turn);
  }

  async rememberTurnWithResult(turn: AgentTurnMemory): Promise<AgentTurnMemoryResult> {
    this.kernel.health.assertWritable();
    if (turn.prewritten) return this.finalizePrewrittenTurn(turn);
    const excludedUser = excludeExplicitSpans(turn.userText);
    const occurredAt = turn.timestamp ?? Date.now();
    const threadId = turn.threadId || turn.sessionId;
    const sourceId = `${turn.agentId}:${turn.sessionId}`;
    const mode = turn.ingestMode ?? 'immediate_compile';
    const claim = turn.turnId
      ? this.kernel.claimAgentTurn({
        projectId: turn.projectId,
        agentId: turn.agentId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        userText: excludedUser.text,
        assistantText: turn.assistantText,
      })
      : undefined;
    if (claim?.replay) {
      return {
        mode,
        reason: 'duplicate_turn',
        compiled: false,
        duplicate: true,
        rawEventIds: [claim.userEventId, claim.assistantEventId].filter((id): id is string => Boolean(id)),
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
      };
    }
    const turnSeq = turn.turnSeq ?? this.kernel.eventStore.getNextTurnSeq(threadId, turn.projectId ?? '');
    const turnId = turn.turnId || `${turn.agentId}:${turn.sessionId}:${turnSeq}:${occurredAt}`;
    const writeUserEvent = () => this.kernel.recordRawEvent({
      eventId: claim?.userEventId,
      projectId: turn.projectId,
      workspaceId: turn.workspaceId,
      threadId,
      sessionId: turn.sessionId,
      turnId,
      turnSeq,
      role: 'user',
      content: excludedUser.text,
      eventOrdinal: 1,
      occurredAt,
      localDate: turn.localDate,
      timeZone: turn.timeZone,
      projectTimeZone: turn.projectTimeZone,
      sourceId,
      metadata: {
        ...metadataWithCollection({ ...(turn.metadata || {}), sourceAgent: turn.agentId }, turn.collection),
        ...secretFindingsMetadata(excludedUser.text),
      },
    });
    let userEvent: ReturnType<typeof writeUserEvent>;
    try {
      userEvent = writeUserEvent();
    } catch (error) {
      const settled = turn.turnId
        ? this.kernel.claimAgentTurn({
          projectId: turn.projectId,
          agentId: turn.agentId,
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          userText: excludedUser.text,
          assistantText: turn.assistantText,
        })
        : undefined;
      if (!settled?.replay) throw error;
      return {
        mode,
        reason: 'duplicate_turn',
        compiled: false,
        duplicate: true,
        rawEventIds: [settled.userEventId, settled.assistantEventId].filter((id): id is string => Boolean(id)),
        turnId: turn.turnId!,
      };
    }
    const assistantEvent = turn.assistantText
      ? this.kernel.recordRawEvent({
        eventId: claim?.assistantEventId,
        projectId: turn.projectId,
        workspaceId: turn.workspaceId,
        threadId,
        sessionId: turn.sessionId,
        turnId,
        turnSeq,
        role: 'assistant',
        content: turn.assistantText,
        eventOrdinal: 2,
        occurredAt,
        localDate: turn.localDate,
        timeZone: turn.timeZone,
        projectTimeZone: turn.projectTimeZone,
        parentEventId: userEvent.eventId,
        prevEventId: userEvent.eventId,
        causalityType: 'replies_to',
        sourceId,
        metadata: {
          ...metadataWithCollection({ ...omitSecretFindings(turn.metadata), sourceAgent: turn.agentId }, turn.collection),
          ...secretFindingsMetadata(turn.assistantText, 'secretFindingsAssistant'),
        },
      })
      : undefined;
    if (assistantEvent) {
      this.kernel.eventStore.updateNextEventId(userEvent.eventId, assistantEvent.eventId);
    }
    const result = this.finalizeTurn({
      turn,
      userEvent,
      assistantEvents: assistantEvent ? [assistantEvent] : [],
      mode,
      sourceId,
      threadId,
      userText: excludedUser.text,
      assistantText: turn.assistantText ?? '',
      occurredAt,
      turnId,
    });
    return withAgentTurnReceipt(result, this.receiptFor({
      userEvent,
      assistantEvent,
      userText: excludedUser.text,
      assistantText: turn.assistantText ?? '',
      occurredAt,
    }));
  }

  private finalizePrewrittenTurn(turn: AgentTurnMemory): AgentTurnMemoryResult {
    const prewritten = turn.prewritten!;
    const userEvent = this.kernel.eventStore.getEvent(prewritten.userEventId);
    if (!userEvent) throw new Error('captured_turn_user_event_missing');
    const assistantEvents = (prewritten.assistantEventIds ?? [])
      .map((eventId) => this.kernel.eventStore.getEvent(eventId))
      .filter((event): event is MemoryEvent => Boolean(event));
    const userText = (userEvent.payload as { text?: string }).text ?? '';
    const assistantText = assistantEvents
      .map((event) => (event.payload as { text?: string }).text ?? '')
      .filter(Boolean)
      .join('\n');
    const threadId = turn.threadId || userEvent.threadId || turn.sessionId;
    const occurredAt = turn.timestamp ?? userEvent.occurredAt;
    const turnId = turn.turnId ?? userEvent.turnId ?? `${turn.agentId}:${turn.sessionId}:${turn.turnSeq ?? 0}:${occurredAt}`;
    const result = this.finalizeTurn({
      turn,
      userEvent,
      assistantEvents,
      mode: turn.ingestMode ?? 'immediate_compile',
      sourceId: `${turn.agentId}:${turn.sessionId}`,
      threadId,
      userText,
      assistantText,
      occurredAt,
      turnId,
    });
    return withAgentTurnReceipt(result, this.receiptFor({
      userEvent,
      assistantEvent: assistantEvents.at(-1),
      userText,
      assistantText,
      occurredAt,
    }));
  }

  private receiptFor(input: {
    userEvent: MemoryEvent;
    assistantEvent?: MemoryEvent;
    userText: string;
    assistantText: string;
    occurredAt: number;
  }) {
    if (!this.kernel.receiptsEnabled) return undefined;
    const timeZone = this.kernel.eventStore.getProjectTimeZone();
    const user = buildAgentTurnReceipt({
      text: input.userText,
      role: 'user',
      occurredAt: input.occurredAt,
      timeZone,
      sourceEventId: input.userEvent.eventId,
    });
    if (user) return user;
    if (!input.assistantText) return undefined;
    return buildAgentTurnReceipt({
      text: input.assistantText,
      role: 'assistant',
      occurredAt: input.occurredAt,
      timeZone,
      sourceEventId: input.assistantEvent?.eventId ?? input.userEvent.eventId,
    });
  }

  private finalizeTurn(input: {
    turn: AgentTurnMemory;
    userEvent: MemoryEvent;
    assistantEvents: MemoryEvent[];
    mode: AgentTurnIngestMode;
    sourceId: string;
    threadId: string;
    userText: string;
    assistantText: string;
    occurredAt: number;
    turnId: string;
  }): AgentTurnMemoryResult {
    const { turn, userEvent, assistantEvents, mode, sourceId, threadId, userText, assistantText, occurredAt, turnId } = input;
    try {
      this.kernel.bindMemoryEvent(userEvent);
    } catch (error) {
      this.kernel.pipelineMetrics.recordNonFatal('memory_binding_failed', {
        projectId: turn.projectId,
        message: error instanceof Error ? error.message : String(error),
        details: {
          eventId: userEvent.eventId,
          sessionId: turn.sessionId,
          agentId: turn.agentId,
        },
      });
    }
    try {
      this.kernel.assembleEpisodeTurn([userEvent, ...assistantEvents], {
        projectId: turn.projectId,
        sessionId: turn.sessionId,
        sourceAgent: turn.agentId,
        now: occurredAt,
      });
    } catch (error) {
      this.kernel.pipelineMetrics.recordNonFatal('episode_assembly_failed', {
        projectId: turn.projectId,
        message: error instanceof Error ? error.message : String(error),
        details: { eventIds: [userEvent.eventId, ...assistantEvents.map((event) => event.eventId)], sessionId: turn.sessionId },
      });
    }

    const sourceRefs = [userEvent, ...assistantEvents].map((event) => ({
      eventId: event.eventId,
      eventType: 'message',
      sourceId,
      contentHash: event.contentHash,
      threadId,
      sessionId: turn.sessionId,
      turnId,
      role: event.role,
      threadSeq: event.threadSeq,
      turnSeq: event.turnSeq,
      eventOrdinal: event.eventOrdinal,
      parentEventId: event.parentEventId,
      prevEventId: event.prevEventId,
      nextEventId: event.nextEventId,
      causalityType: event.causalityType,
      orderingConfidence: event.orderingConfidence,
    }));
    const content = [
      `User: ${userText}`,
      assistantText ? `Agent: ${assistantText}` : '',
    ].filter(Boolean).join('\n');
    const compileSignalText = `User: ${userText}`;

    const decision = this.shouldCompileTurn(mode, compileSignalText);
    const rawEventIds = [userEvent, ...assistantEvents].map((event) => event.eventId);
    const named = turn.turnId ? { turnId: turn.turnId } : {};
    if (!decision.compile) {
      return {
        mode,
        reason: decision.reason,
        compiled: false,
        rawEventIds,
        ...named,
      };
    }

    const neuron = this.kernel.compileMemory({
      content,
      projectId: turn.projectId,
      createdAt: occurredAt,
      source: sourceId,
      sourceEventId: userEvent.eventId,
      sourceRefs,
      tags: [
        `agent:${turn.agentId}`,
        `session:${turn.sessionId}`,
        ...collectionTags(turn.collection),
      ],
    }, userEvent.eventId);

    return {
      mode,
      reason: decision.reason,
      compiled: true,
      rawEventIds,
      compiledNeuronId: neuron.id,
      ...named,
    };
  }

  async ingestToolCall(call: AgentToolCallMemory): Promise<MemoryEvent> {
    const threadId = call.threadId || call.sessionId;
    const event = this.kernel.recordToolCall({
      projectId: call.projectId,
      workspaceId: call.workspaceId,
      threadId,
      sessionId: call.sessionId,
      turnId: call.turnId,
      turnSeq: call.turnSeq,
      assistantEventId: call.assistantEventId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      eventOrdinal: call.eventOrdinal,
      occurredAt: call.timestamp,
      sourceId: `${call.agentId}:${call.sessionId}`,
      metadata: call.metadata,
    });
    this.tryAppendAuxiliaryEvent(event, call.projectId, call.sessionId, call.agentId);
    return event;
  }

  async ingestToolObservation(observation: AgentToolObservationMemory): Promise<MemoryEvent> {
    const threadId = observation.threadId || observation.sessionId;
    const sourceId = `${observation.agentId}:${observation.sessionId}`;
    const event = this.kernel.recordToolResult({
      projectId: observation.projectId,
      workspaceId: observation.workspaceId,
      threadId,
      sessionId: observation.sessionId,
      turnId: observation.turnId,
      turnSeq: observation.turnSeq,
      toolCallEventId: observation.toolCallEventId,
      toolCallId: observation.toolCallId,
      toolName: observation.toolName,
      output: observation.output,
      eventOrdinal: observation.eventOrdinal,
      occurredAt: observation.timestamp,
      sourceId,
      metadata: observation.metadata,
    });
    this.tryAppendAuxiliaryEvent(event, observation.projectId, observation.sessionId, observation.agentId);

    return event;
  }

  async ingestTaskEvent(task: AgentTaskEventMemory): Promise<MemoryEvent> {
    const threadId = task.threadId || task.sessionId;
    const sourceId = `${task.agentId}:${task.sessionId}`;
    const event = this.kernel.recordTaskEvent({
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      threadId,
      sessionId: task.sessionId,
      turnId: task.turnId,
      turnSeq: task.turnSeq,
      parentEventId: task.parentEventId,
      taskId: task.taskId,
      title: task.title,
      content: task.content,
      eventOrdinal: task.eventOrdinal,
      occurredAt: task.timestamp,
      sourceId,
      metadata: task.metadata,
    });
    this.tryAppendAuxiliaryEvent(event, task.projectId, task.sessionId, task.agentId);

    return event;
  }

  private tryAppendAuxiliaryEvent(event: MemoryEvent, projectId: string, sessionId: string, agentId: string): void {
    try {
      this.kernel.appendRawEventToEpisode(event, { projectId, sessionId, sourceAgent: agentId, now: event.occurredAt });
    } catch (error) {
      this.kernel.pipelineMetrics.recordNonFatal('episode_assembly_failed', {
        projectId,
        message: error instanceof Error ? error.message : String(error),
        details: { eventId: event.eventId, sessionId, agentId },
      });
    }
  }

  private shouldCompileTurn(
    mode: AgentTurnIngestMode,
    content: string,
  ): { compile: boolean; reason: AgentTurnCompileReason } {
    if (mode === 'immediate_compile') return { compile: true, reason: 'immediate_compile' };
    if (mode === 'raw_archive_only') return { compile: false, reason: 'raw_archive_only' };
    if (mode === 'raw_then_dream') return { compile: false, reason: 'raw_then_dream' };
    if (this.hasDurableTurnSignal(content) || hasLongTermMemorySignal(content.replace(/^User:\s*/i, ''))) return { compile: true, reason: 'durable_signal_detected' };
    return { compile: false, reason: 'low_signal_turn' };
  }

  private hasDurableTurnSignal(content: string): boolean {
    const normalized = content.toLowerCase();
    const durableSignals = [
      /重要/,
      /记住/,
      /以后/,
      /长期/,
      /偏好/,
      /不要/,
      /禁止/,
      /必须/,
      /约束/,
      /边界/,
      /目标/,
      /纠正/,
      /更正/,
      /推翻/,
      /失败/,
      /成功/,
      /教训/,
      /流程/,
      /决定/,
      /架构/,
      /原则/,
      /preference/,
      /remember/,
      /important/,
      /always/,
      /never/,
      /must/,
      /do not/,
      /constraint/,
      /goal/,
      /correction/,
      /supersede/,
      /failure/,
      /lesson/,
      /decision/,
      /architecture/,
      /boundary/,
    ];
    return durableSignals.some((signal) => signal.test(normalized));
  }
}

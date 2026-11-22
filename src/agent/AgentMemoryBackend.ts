import type { MemoryKernel } from '../factory.js';
import type { MemoryEvent } from '../types/index.js';
import type { ConversationTurnInput, ConversationTurnQuery, ConversationTurnRecord } from '../conversation/index.js';
import type {
  AssembleSessionContextInput,
  SessionContextAssembly,
  SessionDigest,
  SessionDigestInput,
  SessionRecallInput,
  SessionRecallPage,
} from '../session/index.js';
import {
  readSessionToolCalls,
  readSessionTurns,
  type SessionToolCall,
  type SessionToolCallReadInput,
  type SessionTurnRead,
  type SessionTurnReadInput,
} from '../session/index.js';
import type { KernelEvent, KernelEventFilter, KernelEventSubscription } from '../events/index.js';
import type {
  DeliverSurfacingInput,
  RecordSurfacingFeedbackInput,
  ResumeSurfacingTypeInput,
  SurfacingCandidatesInput,
  SurfacingFeedbackRecord,
  SurfacingFeedbackState,
  SurfacingPendingEntry,
  SurfacingResult,
  SurfacingResumeRecord,
} from '../surfacing/index.js';
import type {
  DeliveryBatchResult,
  DeliveryCandidateInput,
  DeliveryChannelInput,
  DeliveryDecision,
  DeliveryFeedbackInput,
  DeliveryUserState,
} from '../delivery/index.js';
import type { ChannelBinding } from '../occasion/index.js';
import type { ProcedureAssembly, ProcedureAssemblyInput } from '../procedure/index.js';
import type { CommitmentEntry, CommitmentListInput, CommitmentQuestion, CommitmentSurfacing } from '../commitment/index.js';
import type { HealthNotice, HealthReport } from '../health/index.js';
import type {
  IntentionAuditEntry,
  IntentionCloseInput,
  IntentionConvertInput,
  IntentionEntry,
  IntentionListInput,
  IntentionScheduleInput,
  IntentionUpdateInput,
  ProposeIntentionInput,
} from '../intention/index.js';
import { SoulError, type SoulProposal, type SoulSnapshot } from '../soul/index.js';
import type {
  RegisterWakeIntentionInput,
  TemporalContext,
  WakeIntention,
  WakeIntentionAuditEntry,
  WakeIntentionListInput,
  WakeTickInput,
  WakeTickResult,
} from '../temporal/index.js';
import { TraceStore } from '../observability/TraceStore.js';
import { AgentRecallEngine } from './AgentRecallEngine.js';
import { AgentTurnMemoryWriter } from './AgentTurnMemoryWriter.js';
import type {
  AgentRecallQuery,
  AgentRecallResult,
  AgentTaskEventMemory,
  AgentToolCallMemory,
  AgentToolObservationMemory,
  AgentTurnMemory,
  AgentTurnMemoryResult,
  KernelAgentMemoryBackendOptions,
  RecallDecisionTraceRead,
} from './AgentMemoryTypes.js';

export * from './AgentMemoryTypes.js';
export {
  contentCueOverlap,
  contentCues,
  discriminativeProbes,
  occasionChainEvents,
  occasionDecisionFor,
  occasionEventText,
  overlapIsOnlySmallTalk,
} from './AgentRecallText.js';
export class KernelAgentMemoryBackend {
  private readonly binding?: ChannelBinding;
  private readonly agentId?: string;
  private readonly recallEngine: AgentRecallEngine;
  private readonly turnWriter: AgentTurnMemoryWriter;

  constructor(private readonly kernel: MemoryKernel, options: KernelAgentMemoryBackendOptions = {}) {
    this.binding = options.binding;
    this.agentId = options.agentId;
    this.recallEngine = new AgentRecallEngine(kernel, this.binding);
    this.turnWriter = new AgentTurnMemoryWriter(kernel);
  }

  /**
   * Subscribe to the kernel's memory event stream — the host API's half of the F1 wake surface.
   *
   * The contract (frozen types, cursor semantics, filters, error codes) is written in
   * `docs/events.md` and asserted in `__tests__/event-stream.contract.test.ts`. This is a
   * pass-through so the shell binds the one interface it already has, not `kernel.events` directly.
   */
  subscribe(
    filter: KernelEventFilter,
    onEvent: (event: KernelEvent) => void,
    options: { since?: number } = {},
  ): KernelEventSubscription {
    return this.kernel.events.subscribe(filter, onEvent, options);
  }

  recentRecallDecision(input: { projectId: string; agentId: string }): RecallDecisionTraceRead {
    const db = this.kernel.factStore.getDatabase();
    const hasTraceTable = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trace_events'`).all() as unknown[]).length > 0;
    if (!hasTraceTable) return { state: 'untraced', chain: [] };
    const store = new TraceStore(db);
    const rows = store.queryByEventType('recall.result').filter((event) => {
      if (event.projectId !== undefined && event.projectId !== input.projectId) return false;
      const payload = event.payload as Record<string, unknown>;
      const named = [payload.agentId, payload.agent, payload.sourceAgent].filter((value): value is string => typeof value === 'string');
      return named.length === 0 || named.includes(input.agentId);
    });
    const last = rows[rows.length - 1];
    if (!last) return { state: 'empty', chain: [] };
    return {
      state: 'found',
      decision: {
        id: last.id,
        timestamp: last.timestamp,
        payload: last.payload,
        ...(last.parentEventId ? { parentEventId: last.parentEventId } : {}),
      },
      chain: store.getDecisionChain(last.id).map((event) => event.eventType),
    };
  }

  recordRuntimeText(input: { projectId: string; kind: string; text: string; sourceRefs?: unknown[] }): string {
    return this.kernel.eventStore.append({
      streamId: `shell-state:${input.projectId}:${input.kind}`,
      streamType: 'system',
      eventType: 'SHELL_STATE_RECORDED',
      projectId: input.projectId,
      payload: {
        kind: input.kind,
        text: input.text,
        ...(input.sourceRefs === undefined ? {} : { sourceRefs: input.sourceRefs }),
      },
    }).eventId;
  }

  readRuntimeText(eventId: string): { kind: string; text: string } | undefined {
    const payload = (this.kernel.eventStore.getEvent(eventId)?.payload ?? {}) as { kind?: unknown; text?: unknown };
    return typeof payload.kind === 'string' && typeof payload.text === 'string'
      ? { kind: payload.kind, text: payload.text }
      : undefined;
  }

  latestEventSeq(): number {
    return this.kernel.eventStore.getLatestGlobalSeq();
  }

  latestEventId(projectId: string): string {
    return this.kernel.eventStore.queryEvents(1, 1, { projectId: [projectId], order: 'desc' }).records[0]?.eventId ?? '';
  }

  countEventsBetween(input: { projectId: string; startTime: number; endTime: number }): number {
    return this.kernel.eventStore.queryEvents(1, 1, {
      projectId: [input.projectId],
      startTime: input.startTime,
      endTime: input.endTime,
    }).total;
  }

  countPendingBindingsBetween(input: { projectId: string; startTime: number; endTime: number }): number {
    const row = this.kernel.factStore.getDatabase().prepare(`
      SELECT COUNT(*) AS c FROM pending_bindings WHERE unit_id IN (
        SELECT unit_id FROM interaction_units WHERE json_valid(message_neuron_ids_json) AND EXISTS (
          SELECT 1 FROM json_each(message_neuron_ids_json) ref
          JOIN memory_events event ON event.event_id = ref.value
          WHERE COALESCE(event.project_id,'')=? AND event.occurred_at>=? AND event.occurred_at<?
        )
      )
    `).get(input.projectId, input.startTime, input.endTime) as { c: number };
    return Number(row.c);
  }

  nextTurnSeq(threadId: string, projectId: string): number {
    return this.kernel.eventStore.getNextTurnSeq(threadId, projectId);
  }

  markToolObservationPromoted(eventId: string): boolean {
    return this.kernel.eventStore.markToolObservationPromoted(eventId);
  }

  setWalAutoCheckpoint(pages: number): void {
    this.kernel.factStore.getDatabase().exec(`PRAGMA wal_autocheckpoint=${Math.max(0, Math.trunc(pages))}`);
  }

  /**
   * The time context block for wake or turn start (F2 of #156), computed by the kernel at an
   * injected instant. The shell injects it into the turn; the agent does not query for it.
   *
   * The contract (frozen field list, field meanings) is written in `docs/time-awareness.md` and
   * asserted in `__tests__/time-awareness.contract.test.ts`.
   */
  temporalContext(input: {
    projectId: string;
    now?: number;
    densityWindowMs?: number;
    rhythmSampleDays?: number;
    rhythmActiveHourThreshold?: number;
  }): TemporalContext {
    return this.kernel.temporalContext(input);
  }

  /** Move the clock: fire due wake intentions and announce due prospective memories. */
  runWakeTick(input: WakeTickInput): WakeTickResult {
    return this.kernel.runWakeTick(input);
  }

  /** The instant a base timer should next wake for, or `null` when nothing is waiting. */
  nextWakeAt(input: { projectId: string; agentId?: string; now?: number }): number | null {
    return this.kernel.nextWakeAt(input);
  }

  /**
   * The surfacing candidate query (F6 of #160): the kernel gives candidates with their reason,
   * confidence, freshness and sensitivity; the shell decides whether to speak. The contract
   * (channels, tiers, classifier, sensitive-tag interface) is `docs/surfacing-candidates.md`.
   */
  surfacingCandidates(input: SurfacingCandidatesInput): SurfacingResult {
    return this.kernel.surfacing.candidates(input, this.binding);
  }

  /**
   * Route one candidate to a delivery decision (F18 of #195). The occasion is resolved from this
   * connection's F8 binding; the candidate, user state, channel and F7 level are the router's
   * existing inputs. Contract: `docs/delivery-routing.md`.
   */
  deliveryRoute(input: {
    projectId: string;
    candidate: DeliveryCandidateInput;
    userState: DeliveryUserState;
    channel: DeliveryChannelInput;
    now?: number;
    feedback?: DeliveryFeedbackInput;
  }): DeliveryDecision {
    const occasion = this.kernel.occasionScope.resolve(this.binding).occasion;
    return this.kernel.deliveryRouter.route({ ...input, occasion });
  }

  /** Route a batch and return the accumulated, next-contact and morning-summary sets (F18). */
  deliveryRouteBatch(input: {
    projectId: string;
    candidates: readonly DeliveryCandidateInput[];
    userState: DeliveryUserState;
    channel: DeliveryChannelInput;
    feedbackFor?: (candidate: DeliveryCandidateInput) => DeliveryFeedbackInput | undefined;
    now?: number;
  }): DeliveryBatchResult {
    const occasion = this.kernel.occasionScope.resolve(this.binding).occasion;
    return this.kernel.deliveryRouter.routeBatch({ ...input, occasion });
  }

  /**
   * The kernel's own condition (#196, F19): the four self-checks and the mode they imply. Contract:
   * `docs/health-backup.md`.
   */
  health(options: { record?: boolean; now?: number } = {}): HealthReport {
    return this.kernel.health.check(options);
  }

  /**
   * The Dream-streak health notice, routed through F18's highest tier with this connection's
   * occasion. Returns the decision and its trace; the shell decides whether to speak.
   */
  healthNotice(input: {
    projectId?: string;
    userState: DeliveryUserState;
    channel: DeliveryChannelInput;
    now?: number;
  }): HealthNotice {
    const occasion = this.kernel.occasionScope.resolve(this.binding).occasion;
    return this.kernel.health.notice({ ...input, occasion });
  }

  /**
   * Record the owner's reaction to a surfaced candidate (F7 of #161). The reaction is a ledger
   * event and modulates the proactive channel deterministically. Contract:
   * `docs/surfacing-feedback.md`.
   */
  recordSurfacingFeedback(input: RecordSurfacingFeedbackInput): SurfacingFeedbackRecord {
    return this.kernel.surfacingFeedback.record(input);
  }

  deliverSurfacing(input: DeliverSurfacingInput): SurfacingPendingEntry {
    return this.kernel.surfacingFeedback.deliver(input);
  }

  surfacingPending(input: { projectId: string }): SurfacingPendingEntry[] {
    return this.kernel.surfacingFeedback.pending(input);
  }

  /** Every type's modulation state, derived from the feedback ledger. */
  surfacingFeedbackState(input: { projectId: string; now?: number }): SurfacingFeedbackState {
    return this.kernel.surfacingFeedback.state(input);
  }

  /** The owner restarts a stopped type: the only way out of a stop. */
  resumeSurfacingType(input: ResumeSurfacingTypeInput): SurfacingResumeRecord {
    return this.kernel.surfacingFeedback.resume(input);
  }

  /** Register a self-set wake intention: a time, a reason, and what it is about. */
  registerWakeIntention(input: RegisterWakeIntentionInput): WakeIntention {
    return this.kernel.wakeIntentions.register(input);
  }

  /** Cancel a pending wake intention. */
  cancelWakeIntention(intentionId: string, input: { projectId: string; now: number; reason?: string }): WakeIntention {
    return this.kernel.wakeIntentions.cancel(intentionId, input);
  }

  /** The project's wake intentions, filtered by agent and status. */
  listWakeIntentions(input: WakeIntentionListInput): WakeIntention[] {
    return this.kernel.wakeIntentions.list(input);
  }

  /** Every transition row of one intention, or of the project's intentions, oldest first. */
  auditWakeIntentions(input: { projectId: string; intentionId?: string; agentId?: string }): WakeIntentionAuditEntry[] {
    return this.kernel.wakeIntentions.audit(input);
  }

  async rememberTurn(turn: AgentTurnMemory): Promise<void> {
    await this.turnWriter.rememberTurn(turn);
  }

  async rememberTurnWithResult(turn: AgentTurnMemory): Promise<AgentTurnMemoryResult> {
    return this.turnWriter.rememberTurnWithResult(turn);
  }

  async ingestToolCall(call: AgentToolCallMemory): Promise<MemoryEvent> {
    return this.turnWriter.ingestToolCall(call);
  }

  async ingestToolObservation(observation: AgentToolObservationMemory): Promise<MemoryEvent> {
    return this.turnWriter.ingestToolObservation(observation);
  }

  async ingestTaskEvent(task: AgentTaskEventMemory): Promise<MemoryEvent> {
    return this.turnWriter.ingestTaskEvent(task);
  }

  /**
   * The conversation-native capture face (#157): one turn, with the speaker, the channel, the thread
   * and the occasion written down as first-class facts rather than re-encoded by each shell.
   *
   * Contract and frozen tables: `docs/conversation-capture.md`, asserted by
   * `__tests__/conversation-capture.contract.test.ts`. The ledger row is the write; the compile pass
   * runs through the kernel's one ingest entry point (#199), and none of the existing write faces
   * changes.
   */
  captureConversationTurn(turn: ConversationTurnInput): Promise<ConversationTurnRecord> {
    this.kernel.health.assertWritable();
    return this.kernel.conversationCapture.captureTurn(turn);
  }

  /** One speaker's turns, or every speaker's. Tool rows are never in this lane. */
  listConversationTurns(query: ConversationTurnQuery): ConversationTurnRecord[] {
    return this.kernel.conversationCapture.listTurns(query);
  }

  /**
   * The session-context face (#191): the mechanical digest, the verbatim session recall, and the
   * per-turn assembly. Contract: `docs/session-context.md`.
   */
  sessionDigest(input: SessionDigestInput): SessionDigest {
    return this.kernel.sessionContext.digest(input);
  }

  recallSession(input: SessionRecallInput): SessionRecallPage {
    return this.kernel.sessionContext.recall(input);
  }

  assembleSessionContext(input: AssembleSessionContextInput): SessionContextAssembly {
    return this.kernel.sessionContext.assemble(input);
  }

  sessionTurns(input: SessionTurnReadInput): SessionTurnRead {
    return readSessionTurns(this.kernel.factStore.getDatabase(), input);
  }

  sessionToolCalls(input: SessionToolCallReadInput): SessionToolCall[] {
    return readSessionToolCalls(this.kernel.factStore.getDatabase(), input);
  }

  taskProcedureRecorded(input: { projectId: string; declarationEventId: string }): boolean {
    const row = this.kernel.factStore.getDatabase().query(`
      SELECT 1
      FROM memory_events
      WHERE event_type = 'RAW_EVENT_RECORDED'
        AND raw_event_type = 'task_event'
        AND COALESCE(project_id, '') = ?
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.metadata.procedure.declarationEventId') = ?
      LIMIT 1
    `).get(input.projectId, input.declarationEventId);
    return row !== null && row !== undefined;
  }

  /**
   * The agent's own soul and its version history (#194). The connection's `agentId` is bound at
   * construction, so this read cannot cross into another identity. A proposal is the only write
   * this face offers; `MemoryKernel.soul.save` is owner-only and is not exposed here.
   */
  soul(): SoulSnapshot {
    return this.kernel.soul.snapshot(this.requireSoulAgent());
  }

  /**
   * Draft an edit for the owner. The current soul is unchanged until the owner saves a version.
   * A proposal must carry its ledger evidence and a counterexample (or the no-counterexample search
   * scope); the registry computes the diff against the current soul (#237).
   */
  proposeSoulEdit(input: {
    content: string;
    reason?: string;
    sourceRefs: string[];
    counterexample?: string;
    noCounterexampleScope?: string;
  }): SoulProposal {
    return this.kernel.soul.propose({
      agentId: this.requireSoulAgent(),
      content: input.content,
      reason: input.reason,
      sourceRefs: input.sourceRefs,
      counterexample: input.counterexample,
      noCounterexampleScope: input.noCounterexampleScope,
    });
  }

  private requireSoulAgent(): string {
    if (!this.agentId) throw new SoulError('agent_id_required');
    return this.agentId;
  }

  private requireBoundAgent(): string {
    if (!this.agentId) throw new Error('agent_id_required');
    return this.agentId;
  }

  /**
   * The procedure lane at the start of work (F15 of #192): recalled by the task description, with
   * checklist procedures delivered whole. Contract: `docs/procedure-compilation.md`.
   */
  assembleTaskProcedures(input: ProcedureAssemblyInput): ProcedureAssembly {
    return this.kernel.procedures.assembleTask(input);
  }

  /**
   * The commitment book's read face (F16 of #193): what was promised, what is due, and the one
   * question an ambiguous completion evidence earns. Contract: `docs/commitments.md`.
   */
  listCommitments(input: CommitmentListInput): CommitmentEntry[] {
    return this.kernel.commitments.list(input);
  }

  surfaceCommitments(input: { projectId: string; owner?: CommitmentEntry['owner']; now?: number; limit?: number }): CommitmentSurfacing[] {
    return this.kernel.commitments.surfaceDue(input);
  }

  askCommitments(input: { projectId: string; now?: number; limit?: number }): CommitmentQuestion[] {
    return this.kernel.commitments.askOnce(input);
  }

  dismissCommitment(input: { projectId: string; commitmentId: string; now?: number }): CommitmentEntry {
    return this.kernel.commitments.dismiss(input);
  }

  snoozeCommitment(input: {
    projectId: string;
    commitmentId: string;
    resumeAt: number;
    reason?: string;
    now?: number;
  }): CommitmentEntry {
    return this.kernel.commitments.snooze(input);
  }

  /**
   * The agent's own plans (F22 of #216): the read face, and the self-governance the agent owns —
   * propose, correct, close, convert and schedule. The owner's veto is not here. Contract:
   * `docs/intentions.md`.
   */
  listIntentions(input: IntentionListInput): IntentionEntry[] {
    return this.kernel.intentions.list(input);
  }

  auditIntentions(input: { projectId: string; intentionId?: string }): IntentionAuditEntry[] {
    return this.kernel.intentions.audit(input);
  }

  proposeIntention(input: Omit<ProposeIntentionInput, 'agentId'>): IntentionEntry {
    return this.kernel.intentions.propose({ ...input, agentId: this.requireBoundAgent() });
  }

  updateIntention(input: IntentionUpdateInput): IntentionEntry {
    return this.kernel.intentions.update(input);
  }

  closeIntention(input: IntentionCloseInput): IntentionEntry {
    return this.kernel.intentions.close(input);
  }

  convertIntention(input: IntentionConvertInput): IntentionEntry {
    return this.kernel.intentions.convert(input);
  }

  scheduleIntention(input: IntentionScheduleInput): IntentionEntry {
    return this.kernel.intentions.schedule(input);
  }

  /**
   * Recall with every item marked for what is missing from its text.
   *
   * Redaction happens when a turn is written, so by the time an item is built its text
   * is already altered — and the lane that built it decides nothing about whether the
   * caller can tell. One decoration here covers the raw ledger, compiled memory and the
   * Atlas alike; decorating the raw builder is how the raw lane got it and the compiled
   * lane did not (#115).
   */
  recall(query: AgentRecallQuery): AgentRecallResult {
    return this.recallEngine.recall(query);
  }
}

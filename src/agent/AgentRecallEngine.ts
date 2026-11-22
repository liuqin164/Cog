import type { MemoryKernel } from '../factory.js';
import { classifySocialTurn, isSocialTurn } from '../context/SocialTurn.js';
import type { MemoryAtlasCard, MemoryAtlasNode, MemoryAtlasRelatedCard, MemoryAtlasRelaxationStep } from '../atlas/MemoryAtlasTypes.js';
import {
  memoryEventCharRange,
  memoryEventLabel,
  memoryEventSourceRange,
  normalizeSourceContextWindow,
  type MemoryEventCharRange,
  type MemoryEventSourceRange,
  type SourceContextWindowMetadata,
} from '../recall/SourceContextMetadata.js';
import { filterSuperseded } from '../recall/SupersessionFilter.js';
import { isOperationalNoiseText } from '../recall/RecallGovernance.js';
import { correctionAffects, profileCorrectionSignals, supersededSourceEventIds } from '../profile/CorrectionSignal.js';
import type { ProfileRecallEntry } from '../profile/index.js';
import type { MemoryEvent, MemorySourceRef } from '../types/index.js';
import type { ChannelBinding, Occasion, OccasionWithholdReason } from '../occasion/index.js';
import { eventsVisibleToAgent, isAgentRawEvent } from './AgentScopeRules.js';
import {
  compileAgentRecallQuery,
  type AgentRecallIntent,
  type AgentRecallQueryPlan,
} from './AgentRecallQueryCompiler.js';
import { cliArg } from '../utils/CliArgument.js';
import { projectPhaseItems } from '../recall/PhaseProjection.js';
import { eventHoldsSecretMark } from '../security/SecretMarks.js';
import { eventHoldsLifeSensitivityMark } from '../security/LifeSensitivity.js';
import { RecallDecisionTrace, type RecallTraceSuppression } from '../observability/RecallDecisionTrace.js';
import { TraceStore } from '../observability/TraceStore.js';
import type {
  AgentRecallBeliefTouch,
  AgentRecallDecisionTrace,
  AgentRecallEntityCard,
  AgentRecallItem,
  AgentRecallQuery,
  AgentRecallResult,
  AgentRecallSourceAnchor,
  AgentRecallSourceContext,
  AgentRecallSourceContextEvent,
  RecallCoreResult,
  RecallDecisionTraceRead,
  RecallSuppressionReason,
  ZeroExplanation,
} from './AgentMemoryTypes.js';
import {
  ATLAS_RECALL_NODE_TYPES,
  TOOL_OBSERVATION_TRUST,
  TOOL_OBSERVATION_WHY_MATCHED,
} from './AgentMemoryTypes.js';
import { isAllowedRawEventCollection, normalizeCollection } from './AgentMemoryScope.js';
import {
  contentCueOverlap,
  contentCues,
  discriminativeProbes,
  FORENSIC_SOCIAL_EXEMPT_INTENTS,
  isPromotedToolObservation,
  isToolObservationEvent,
  LIFE_SENSITIVITY_WITHHELD_EVENT_IDS,
  laneAllowed,
  localDateCue,
  mergeSuppressions,
  occasionChainEvents,
  occasionDecisionFor,
  occasionEventText,
  overlapIsOnlySmallTalk,
  recallDecisionTrace,
  recallDecisionTraceForSelection,
  SECRET_WITHHELD_EVENT_IDS,
  sameRecallContent,
  suppressionsForTrace,
  uniqueNonEmpty,
  withRedactionMarks,
  ZERO_EXPLANATION_SAMPLE,
} from './AgentRecallText.js';

/**
 * Per backend instance, never global: document frequency describes one database, and a daemon serving
 * two of them must not answer the second with the first one's counts.
 */
const RAW_TERM_DF_CACHE = new WeakMap<object, { watermark: number; counts: Map<string, number> }>();
const PRIVATE_CHECKED_ITEMS = new WeakMap<object, WeakSet<AgentRecallItem>>();
const FREQUENT_TERM_MIN = 3;
const DISCRIMINATIVE_TERM_BUDGET = 8;

export class AgentRecallEngine {
  constructor(private readonly kernel: MemoryKernel, private readonly binding?: ChannelBinding) {}

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
    query = this.scopeExcludedSessionTail(query);
    const { result, suppressedIds } = this.recallPrivate(query);
    const answered = this.withSharedLane(query, result);
    // Occasion scope is the last admission, after the shared lane as well as the local ones: a shared
    // item is still text this connection may not be allowed to speak (#162).
    const gated = this.applyOccasionGate(query, answered, suppressedIds);
    this.touchAtlasRecallHits(query, gated.result);
    this.recordRecallTrace(query, gated.result, gated.suppressedIds);
    return gated.result;
  }

  private touchAtlasRecallHits(query: AgentRecallQuery, result: AgentRecallResult): void {
    if (!query.projectId) return;
    const nodeIds = new Set<string>();
    for (const item of result.items) {
      if (!item.canonicalId) continue;
      if (!item.tags.some((tag) => tag === 'atlas_node' || tag === 'facet_graph' || tag === 'atlas_path')) continue;
      nodeIds.add(item.canonicalId);
    }
    if (!nodeIds.size) return;
    try {
      this.kernel.touchMemoryAtlas({
        projectId: query.projectId,
        nodeIds: [...nodeIds],
        reason: 'recall_hit',
        query: String(query.query ?? ''),
      });
    } catch (error) {
      this.kernel.pipelineMetrics.recordNonFatal('memory_atlas_recall_touch_failed', {
        projectId: query.projectId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scopeExcludedSessionTail(query: AgentRecallQuery): AgentRecallQuery {
    const sessionId = query.excludeSessionId;
    const turns = query.excludeSessionTailTurns;
    if (!sessionId || !turns || turns <= 0) return query;
    const page = this.kernel.eventStore.queryEvents(1, Math.max(turns * 2, 2), {
      projectId: query.projectId !== undefined ? [query.projectId] : undefined,
      sessionId: [sessionId],
      order: 'desc',
    });
    const sequences = page.records
      .map((event) => event.turnSeq)
      .filter((value): value is number => typeof value === 'number');
    if (sequences.length === 0) return query;
    const latest = Math.max(...sequences);
    return { ...query, excludeSessionBeforeTurnSeq: latest - turns + 1 };
  }

  /**
   * The profile lane (#159). The owner's four ledgers are a compiled product with their own ranking
   * and their own budget: they are **appended** after the ordinary lanes rather than merged through
   * `mergeRecallItems`, so a profile entry never displaces the memory the question named and the
   * compiled lane's cue ranking never reorders the profile's frozen priority/decay order.
   *
   * The item anchors the raw event the entry was compiled from, so the secret and agent scope gates
   * (#142/#143, one chain) apply unchanged — the cross-identity rule stays #153's, not a second one.
   * Exact-quote and previous-session lanes stay whole: they ask for words, not for a profile.
   */
  private withProfileItems(query: AgentRecallQuery, result: RecallCoreResult): RecallCoreResult {
    if (!query.projectId) return result;
    if (!laneAllowed(query.retrievalPolicy, 'graph')) return result;
    const intent = result.queryPlan?.intent;
    if (intent === 'forensic_quote' || intent === 'previous_session_summary') return result;
    const entries = this.kernel.profile.recall({
      projectId: query.projectId,
      query: String(query.query ?? query.anchorText ?? ''),
      now: query.now,
    });
    if (entries.length === 0) return result;
    const items = entries
      .map((entry) => this.toAgentProfileItem(entry, query))
      .filter((item): item is AgentRecallItem => Boolean(item));
    if (items.length === 0) return result;
    return { ...result, items: [...result.items, ...items] };
  }

  /**
   * A profile correction also governs the ordinary lanes (#242). The corrected entry's old source
   * events are exact evidence: an item anchored there is the replaced statement, not a second
   * answer. Text overlap catches compiled cards whose source link is older than the correction.
   * Exact-quote and previous-session lanes are left whole — they ask for the words that were said.
   */
  private withoutSupersededByProfile(query: AgentRecallQuery, result: RecallCoreResult): RecallCoreResult {
    if (!query.projectId) return result;
    if (query.intent === 'forensic_quote' || query.intent === 'previous_session_summary') return result;
    const signals = profileCorrectionSignals(this.kernel.eventStore, query.projectId);
    if (signals.length === 0) return result;
    const oldSourceIds = supersededSourceEventIds(signals);
    const items = result.items.filter((item) => {
      const anchor = item.sourceAnchor?.eventId;
      if (anchor && oldSourceIds.has(anchor)) return false;
      if (signals.some((signal) => item.text.toLowerCase().includes(signal.value.toLowerCase()))) return true;
      return !signals.some((signal) => correctionAffects(signal, { text: item.text }));
    });
    return items.length === result.items.length ? result : { ...result, items };
  }

  private toAgentProfileItem(entry: ProfileRecallEntry, query: AgentRecallQuery): AgentRecallItem | null {
    const eventId = entry.sourceRefs.find((ref) => ref.eventId)?.eventId;
    if (!eventId) return null;
    const sourceContext = this.toAgentSourceContext(eventId, query);
    const anchorEvent = sourceContext?.event;
    const allowRaw = laneAllowed(query.retrievalPolicy, 'raw_source');
    return {
      id: `profile:${entry.entryId}`,
      text: `${entry.key}: ${entry.value}`,
      projectId: query.projectId,
      canonicalId: entry.entryId,
      displayTitle: entry.key,
      tags: ['profile', `profile_ledger:${entry.ledger}`, `profile_version:${entry.version}`],
      source: eventId,
      sourceType: 'compiled_memory',
      sourceAnchor: anchorEvent ? this.toAgentSourceAnchorFromContextEvent(anchorEvent) : { eventId },
      sourceContext: allowRaw ? sourceContext : undefined,
      confidence: 0.9,
      whyMatched: `profile_${entry.ledger}`,
      canAnswerExactQuote: false,
    };
  }

  /**
   * The stored decision behind a recall: ids, reasons and the lane, never an item's text (#187).
   *
   * Written after the answer is assembled and after the shared lane has had its say, so the row names
   * what the caller actually received — and never instead of returning it: a trace that cannot be
   * written is a non-fatal pipeline event, and the recall is unaffected. The whole body is guarded,
   * including the failure report, because nothing on this path may turn a written trace into a lost
   * answer.
   */
  private recordRecallTrace(
    query: AgentRecallQuery,
    result: AgentRecallResult,
    suppressedIds: RecallTraceSuppression[],
  ): void {
    try {
      const trace = this.recallTrace(query);
      if (!trace) return;
      const decision = result.decisionTrace;
      trace.record({
        projectId: query.projectId,
        agentId: query.agentId,
        // The question only. `anchorText` is deliberately not a fallback: a caller may fill it with a
        // returned item's text (the OpenClaw plugin does), and an item's text must never reach this row.
        query: String(query.query ?? ''),
        lane: decision?.selectedLane ?? 'none',
        reason: decision?.reason ?? 'unknown',
        selectedIds: result.items.map((item) => item.id),
        suppressed: suppressionsForTrace(decision?.suppressed, suppressedIds),
      });
    } catch (error) {
      this.recordTraceFailure(query, error);
    }
  }

  /**
   * The trace table, created on the first recall rather than when the kernel opens.
   *
   * Deliberately not part of kernel setup: the 4.0 baseline schema is pinned object-for-object against
   * the installer's own output, and this table is not the installer's. It appears when there is a
   * decision to record, which is also the first moment it can have rows. `null` means "this kernel
   * cannot write one", which is not an error — recall still answers.
   */
  private recallTraceWriter: RecallDecisionTrace | null | undefined;

  private recallTrace(query: AgentRecallQuery): RecallDecisionTrace | null {
    if (this.recallTraceWriter !== undefined) return this.recallTraceWriter;
    try {
      const store = new TraceStore(this.kernel.factStore.getDatabase());
      store.initSchema();
      this.recallTraceWriter = new RecallDecisionTrace(store);
    } catch (error) {
      // Recorded, not silent: "a trace that cannot be written leaves a mark" applies to failing to
      // open the writer as much as to failing to append. Once, not per recall — there is nothing to
      // retry, and a per-recall record would be noise on the hot path.
      this.recallTraceWriter = null;
      this.recordTraceFailure(query, error);
    }
    return this.recallTraceWriter;
  }

  /** The failure record for a trace that could not be written. Never allowed to escape. */
  private recordTraceFailure(query: AgentRecallQuery, error: unknown): void {
    try {
      this.kernel.pipelineMetrics.recordNonFatal('recall_trace_failed', {
        projectId: query.projectId,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The answer is already built; a second failure has nowhere useful to go.
    }
  }

  /**
   * #67: shared items ride their own lane.
   *
   * Another agent's text must never arrive looking like this agent's own memory, so shared items are
   * **appended** after the private ones rather than merged into their slots: private memory keeps the
   * budget it had, and the shared lane spends only its own. Every shared item names its source host and
   * collection, which is what a renderer needs to present it as a reference rather than an instruction.
   *
   * Every shared collection appears here while sharing is enabled (#146: publishing is still explicit, reading is
   * not gated per reader), and the read goes through the adapter's `subscribeSync` — the recall path never queries
   * the shared table itself. A read-only lane: nothing here writes.
   */
  private withSharedLane(query: AgentRecallQuery, result: AgentRecallResult): AgentRecallResult {
    if (!this.kernel.sharedEnabled) return result;
    const agentId = query.agentId;
    if (!agentId) return result;
    // Reading is open to any agent that can connect (#146, 2026-11-06): the readers list is no longer a gate.
    // The registry stays in the database and is left unused on purpose — a future multi-user deployment can turn it
    // back on — but nothing here consults it, so there is no runtime branch to keep in step.
    const readable = this.kernel.listSharedCollectionsSync().map((collection) => collection.collection);
    if (readable.length === 0) return result;

    const injectionLimit = query.limit ?? 5;
    // Derived default until the fitted value is configured: a third of what this recall injects, so a
    // busy shared collection cannot crowd out the memory the agent actually owns.
    const budget = this.kernel.sharedRecallLimit ?? Math.max(1, Math.ceil(injectionLimit / 3));
    // One extra is fetched so `sharedDropped` reports a real count instead of "at least the budget".
    const available = this.kernel.subscribeSharedSync(readable, agentId, { limit: budget + 1 });
    const chosen = available.slice(0, budget);
    const shared: AgentRecallItem[] = chosen.map((item) => {
      const payload = item.payload as { text?: unknown; summary?: unknown };
      const text = typeof payload.text === 'string' ? payload.text
        : typeof payload.summary === 'string' ? payload.summary
        : JSON.stringify(item.payload);
      return {
        id: `shared:${item.itemHash}`,
        text,
        tags: ['shared_memory', `shared_host:${item.sourceHost}`, `shared_collection:${item.collection}`],
        source: 'shared_memory',
        shared: { sourceHost: item.sourceHost, collection: item.collection },
        whyMatched: `shared by ${item.sourceHost} in ${item.collection}`,
      };
    });
    return {
      ...result,
      items: [...result.items, ...shared],
      decisionTrace: result.decisionTrace
        ? { ...result.decisionTrace, sharedCount: shared.length, sharedDropped: Math.max(0, available.length - chosen.length) }
        : result.decisionTrace,
    };
  }

  /**
   * Whether a recalled item's anchor event carries the secret mark (#142).
   *
   * The mark lives on the event, so this is a lookup rather than a second judgement: the lanes differ in where
   * they read an event from, and this is the one question they must all ask before handing it to a caller.
   */
  private itemHoldsSecretMark(item: AgentRecallItem): boolean {
    const meta = item as { secretFindings?: { total?: number } };
    if (Number(meta.secretFindings?.total ?? 0) > 0) return true;
    return this.itemChainEvents(item).some((event) => eventHoldsSecretMark(event));
  }

  /** The same chain, asked for the life-information mark (#164) instead. */
  private itemHoldsLifeSensitivityMark(item: AgentRecallItem): boolean {
    return this.itemChainEvents(item).some((event) => eventHoldsLifeSensitivityMark(event));
  }

  private withholdPrivateItem(item: AgentRecallItem): boolean {
    if (this.itemHoldsSecretMark(item)) {
      const ids = SECRET_WITHHELD_EVENT_IDS.get(this) ?? new Set<string>();
      ids.add(item.id);
      SECRET_WITHHELD_EVENT_IDS.set(this, ids);
      return true;
    }
    if (this.itemHoldsLifeSensitivityMark(item)) {
      const ids = LIFE_SENSITIVITY_WITHHELD_EVENT_IDS.get(this) ?? new Set<string>();
      ids.add(item.id);
      LIFE_SENSITIVITY_WITHHELD_EVENT_IDS.set(this, ids);
      return true;
    }
    return false;
  }

  private itemChainEvents(item: AgentRecallItem): MemoryEvent[] {
    const chain = new Map<string, MemoryEvent>();
    const anchor = (item.sourceAnchor as { eventId?: string } | undefined)?.eventId;
    for (const id of [anchor, ...(item.evidenceEventIds ?? [])]) {
      if (!id) continue;
      for (const event of occasionChainEvents(this.kernel, id)) chain.set(event.eventId, event);
    }
    return [...chain.values()];
  }

  /**
   * Whether an agent may read an item, read from the same chain as the secret mark (#143).
   *
   * The rule (2026-11-07, route 1): imported material is project-level public whatever `sourceAgent` says,
   * because making an import worth doing means the other agents in the project can read it; a turn someone had
   * is scoped to the agent that had it; material whose chain names no agent — a migration, an old row, a record
   * written by a connection that had no identity — is public too. Cross-project isolation is untouched: this
   * only ever widens within one project, and the shared lane stays the one deliberate cross-agent channel.
   */
  private itemVisibleToAgent(item: AgentRecallItem, agentId: string): boolean {
    // One composition for both surfaces (`eventsVisibleToAgent`): the chain is derived here, because
    // an item and an Atlas node reach their events differently, and the judgement is shared.
    return eventsVisibleToAgent(this.itemChainEvents(item), agentId);
  }

  /**
   * Apply the read-time phase to the default lane (#130).
   *
   * Read-time and store-free: the phase is computed from the timestamp every time, so switching it off restores
   * the previous behaviour with no migration and no data to roll back. Forensic and exact-quote lanes never
   * reach this method, and a by-ID read does not either, which is the ticket's rule that those channels always
   * return the whole thing.
   *
   * The rules live in `PhaseProjection.projectPhaseItems`, which is pure and takes the items directly, so the
   * projection has a unit test that does not need a lane to seed a timestamp (#171). This method only adds the
   * trace's suppression reasons and the off switch.
   */
  private projectPhases(items: AgentRecallItem[], query: AgentRecallQuery): { items: AgentRecallItem[]; suppressed: Array<{ reason: RecallSuppressionReason; count: number }> } {
    if (!this.kernel.phaseProjectionEnabled) return { items, suppressed: [] };
    const now = Number(query.now ?? Date.now());
    const projected = projectPhaseItems(items, String(query.query ?? query.anchorText ?? ''), now);
    const suppressed: Array<{ reason: RecallSuppressionReason; count: number }> = [];
    if (projected.dormant > 0) suppressed.push({ reason: 'phase_dormant', count: projected.dormant });
    if (projected.gist > 0) suppressed.push({ reason: 'phase_gist', count: projected.gist });
    return { items: projected.items, suppressed };
  }

  private recallPrivate(query: AgentRecallQuery): { result: AgentRecallResult; suppressedIds: RecallTraceSuppression[] } {
    SECRET_WITHHELD_EVENT_IDS.set(this, new Set());
    LIFE_SENSITIVITY_WITHHELD_EVENT_IDS.set(this, new Set());
    PRIVATE_CHECKED_ITEMS.set(this, new WeakSet());
    const queryText = String(query.query ?? '');
    const forensic = FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(query.intent ?? ''));
    if (!forensic && classifySocialTurn(queryText) === 'social') {
      const empty = this.emptyRecallResult(query, 'social_query_residue_empty');
      const trace: AgentRecallDecisionTrace = {
        ...empty.decisionTrace!,
        suppressed: [{ reason: 'residue_empty', count: 0 }],
      };
      return { result: { ...empty, decisionTrace: trace, semanticIndex: this.kernel.semanticIndexEnabled() }, suppressedIds: [] };
    }
    const result = this.withProfileItems(query, this.withoutSupersededByProfile(query, this.recallCore(query)));
    const quoteIntent = forensic || FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(result.queryPlan?.intent ?? ''));
    const gated = this.gateSocialEntries(result.items ?? [], query, quoteIntent);
    const checked = PRIVATE_CHECKED_ITEMS.get(this);
    const secretWithheldItems = forensic ? [] : gated.items.filter((item) => !checked?.has(item) && this.itemHoldsSecretMark(item));
    const withheld = new Set(secretWithheldItems);
    const secretKept = forensic ? gated.items : gated.items.filter((item) => !withheld.has(item));
    const lifeWithheldItems = forensic ? [] : secretKept.filter((item) => !checked?.has(item) && this.itemHoldsLifeSensitivityMark(item));
    const lifeWithheld = new Set(lifeWithheldItems);
    const lifeKept = forensic ? secretKept : secretKept.filter((item) => !lifeWithheld.has(item));
    const rawWithheldIds = [...(SECRET_WITHHELD_EVENT_IDS.get(this) ?? [])];
    const secretWithheld = rawWithheldIds.length + secretWithheldItems.length;
    const secretIds = [...rawWithheldIds, ...secretWithheldItems.map((item) => item.id)];
    const suppressedIds: RecallTraceSuppression[] = [
      ...gated.suppressedIds,
      ...(secretIds.length ? [{ reason: 'secret_bearing_withheld' as const, count: secretIds.length, ids: secretIds }] : []),
    ];
    if (secretWithheld > 0 && result.decisionTrace) {
      result.decisionTrace.suppressed = mergeSuppressions(result.decisionTrace.suppressed, [
        { reason: 'secret_bearing_withheld', count: secretWithheld },
      ]);
    }
    const rawLifeIds = [...(LIFE_SENSITIVITY_WITHHELD_EVENT_IDS.get(this) ?? [])];
    const lifeWithheldCount = rawLifeIds.length + lifeWithheldItems.length;
    const lifeIds = [...rawLifeIds, ...lifeWithheldItems.map((item) => item.id)];
    if (lifeIds.length) {
      suppressedIds.push({ reason: 'life_sensitivity_withheld', count: lifeIds.length, ids: lifeIds });
    }
    if (lifeWithheldCount > 0 && result.decisionTrace) {
      result.decisionTrace.suppressed = mergeSuppressions(result.decisionTrace.suppressed, [
        { reason: 'life_sensitivity_withheld', count: lifeWithheldCount },
      ]);
    }
    const agentKept = query.agentId
      ? lifeKept.filter((item) => Boolean((item as { shared?: unknown }).shared)
        || this.itemVisibleToAgent(item, String(query.agentId)))
      : lifeKept;
    const phased = this.projectPhases(agentKept, query);
    const zeroExplanation = phased.items.length === 0 ? this.explainZeroResult(query) : undefined;
    const ordered = [...phased.items].sort((left, right) => (
      Number(left.trust === TOOL_OBSERVATION_TRUST) - Number(right.trust === TOOL_OBSERVATION_TRUST)
    ));
    const suppressions = mergeSuppressions(
      mergeSuppressions(result.decisionTrace?.suppressed, gated.suppressed),
      phased.suppressed,
    );
    return {
      result: {
        ...result,
        items: ordered.map(withRedactionMarks),
        decisionTrace: result.decisionTrace
          ? {
            ...result.decisionTrace,
            selectedCount: ordered.length,
            ...(suppressions ? { suppressed: suppressions } : {}),
            ...(zeroExplanation ? { zeroExplanation } : {}),
          }
          : result.decisionTrace,
        semanticIndex: this.kernel.semanticIndexEnabled(),
      },
      suppressedIds,
    };
  }

  /**
   * The occasion admission (#162), applied to the whole answer after the shared lane.
   *
   * Every local lane returns through `recallPrivate`, and the shared lane appends after it, so this
   * is the one place a connection's occasion can filter everything a caller will receive. The
   * occasion is resolved from the backend's binding; a query cannot declare it. A withheld item is
   * counted and named, never dropped silently — `occasion_private_tier` for private/high material
   * outside `private`, `occasion_third_party` for another person's material in `public`.
   */
  private applyOccasionGate(
    query: AgentRecallQuery,
    result: AgentRecallResult,
    suppressedIds: RecallTraceSuppression[],
  ): { result: AgentRecallResult; suppressedIds: RecallTraceSuppression[] } {
    const gate = this.gateOccasionEntries(result.items, query);
    const occasionWithheld = gate.suppressed.reduce((sum, entry) => sum + entry.count, 0);
    const zeroExplanation = gate.items.length === 0
      ? occasionWithheld > 0
        ? { kind: 'occasion_filtered' as const, count: occasionWithheld }
        : result.decisionTrace?.zeroExplanation
      : undefined;
    const suppressions = mergeSuppressions(result.decisionTrace?.suppressed, gate.suppressed);
    const decisionTrace = result.decisionTrace
      ? {
        ...result.decisionTrace,
        occasion: gate.resolved.occasion,
        occasionBinding: gate.resolved.bound ? 'bound' as const : 'unbound' as const,
        ...(suppressions ? { suppressed: suppressions } : {}),
      }
      : undefined;
    if (decisionTrace) {
      if (zeroExplanation) decisionTrace.zeroExplanation = zeroExplanation;
      else delete decisionTrace.zeroExplanation;
    }
    return {
      result: {
        ...result,
        items: gate.items.map(withRedactionMarks),
        ...(decisionTrace ? { decisionTrace } : {}),
      },
      suppressedIds: [...suppressedIds, ...gate.suppressedIds],
    };
  }


  /**
   * Which kind of zero this is, from the index rather than from a second recall.
   *
   * One bounded raw search for the same question, then the identity test the lanes already apply.
   * Nothing else runs: no vectors, no lanes, no ranking. The answer is counts only, because how many
   * turns another identity holds says nothing about what they contain.
   */
  private explainZeroResult(query: AgentRecallQuery): ZeroExplanation {
    const text = String(query.query ?? query.anchorText ?? '').trim();
    if (!text) return { kind: 'no_match', thisScope: 0, otherScopes: 0 };
    const queryPlan = compileAgentRecallQuery({ query: query.query, intent: query.intent, anchorText: query.anchorText, taxonomy: this.kernel.taxonomy });
    let events: MemoryEvent[] = [];
    try {
      events = this.kernel.searchRawEvents(text, {
        projectId: query.projectId,
        workspaceId: query.workspaceId,
        startTime: query.startTime,
        endTime: query.endTime,
        limit: ZERO_EXPLANATION_SAMPLE,
      });
    } catch {
      return { kind: 'no_match', thisScope: 0, otherScopes: 0 };
    }
    const outOfScope = events.filter((event) => !this.isRawEventInRecallScope(event, query, queryPlan.intent)).length;
    if (outOfScope === 0) return { kind: 'no_match', thisScope: 0, otherScopes: 0 };
    return {
      kind: 'scope_filtered',
      thisScope: 0,
      otherScopes: outOfScope,
      ...(query.agentId ? { agentId: query.agentId } : {}),
    };
  }

  /** An answer with no items, keeping the shape every caller already handles. */
  private emptyRecallResult(query: AgentRecallQuery, reason: AgentRecallDecisionTrace['reason']): RecallCoreResult {
    const queryPlan = compileAgentRecallQuery({ query: query.query, intent: query.intent, anchorText: query.anchorText, taxonomy: this.kernel.taxonomy });
    return {
      recallMode: 'social_turn_suppressed',
      items: [],
      fallbackUsed: false,
      queryPlan,
      decisionTrace: recallDecisionTrace('none', reason, {
        graph: 0, navigation: 0, scopedNavigation: 0, brainFallback: 0, rawLedger: 0,
      }, 0),
    };
  }

  /**
   * The occasion admission (#162).
   *
   * Every lane returns through `recallPrivate`, so this is the one place the filter can run. The
   * occasion is resolved from the backend's connection binding; a query cannot declare it. A
   * withheld item is counted and named, never dropped silently — `occasion_private_tier` for
   * private/high material outside `private`, `occasion_third_party` for another person's material
   * in `public`.
   */
  private gateOccasionEntries(
    items: AgentRecallItem[],
    query: AgentRecallQuery,
  ): {
    items: AgentRecallItem[];
    resolved: { occasion: Occasion; bound: boolean };
    suppressed: Array<{ reason: RecallSuppressionReason; count: number }>;
    suppressedIds: RecallTraceSuppression[];
  } {
    const resolved = this.kernel.occasionScope.resolve(this.binding);
    if (resolved.occasion === 'private') return { items, resolved, suppressed: [], suppressedIds: [] };
    const kept: AgentRecallItem[] = [];
    const removed = new Map<OccasionWithholdReason, string[]>();
    for (const item of items) {
      const events = this.itemChainEvents(item);
      const decision = occasionDecisionFor(this.kernel, resolved.occasion, {
        projectId: query.projectId,
        text: String(item.text ?? ''),
        sourceType: events.find((event) => event.rawEventType)?.rawEventType,
        events,
      });
      if (decision.allowed) {
        kept.push(item);
        continue;
      }
      const reason = decision.reason ?? 'occasion_private_tier';
      removed.set(reason, [...(removed.get(reason) ?? []), item.id]);
    }
    const dropped = [...removed.entries()];
    return {
      items: kept,
      resolved,
      suppressed: dropped.map(([reason, ids]) => ({ reason, count: ids.length })),
      suppressedIds: dropped.map(([reason, ids]) => ({ reason, count: ids.length, ids })),
    };
  }

  /**
   * Defence 2: a social entry is never memory content, whatever the question is.
   *
   * The write side already classifies turns (MemoryGate drops pure thanks), but ten-thousand-event
   * databases hold turns written before that gate existed, and the ticket requires them to work
   * without a migration. So the classification is redone here at recall time with the same shared
   * rules — the ledger keeps everything, and this only stops the old pleasantries from being handed
   * back as answers.
   */
  private gateSocialEntries(
    items: AgentRecallItem[],
    query: AgentRecallQuery,
    forensic: boolean,
  ): {
    items: AgentRecallItem[];
    suppressed: Array<{ reason: RecallSuppressionReason; count: number }>;
    /** The same removals, by id, for the trace (#187). Counts alone cannot name what was dropped. */
    suppressedIds: RecallTraceSuppression[];
  } {
    if (forensic) return { items, suppressed: [], suppressedIds: [] };
    const { frequent, rare } = this.queryTermFrequencies(query);
    const measurable = frequent.size > 0 && rare.size > 0;
    const queryText = String(query.query ?? '');
    const grey = classifySocialTurn(queryText) === 'grey';
    const hasContentCue = contentCues(queryText).length > 0;
    const kept: AgentRecallItem[] = [];
    const entrySocialIds: string[] = [], belowFloorIds: string[] = [];
    const belowRelevanceFloorIds: string[] = [];
    for (const item of items) {
      const text = String(item.text ?? '');
      if (isSocialTurn(text)) { entrySocialIds.push(item.id); continue; }
      if (measurable) {
        const overlap = [...frequent, ...rare].filter((term) => text.includes(term));
        // "Resting only on high-frequency words" is measured against the shared filler vocabulary as
        // well as the corpus: a hit is discarded only when every word it shares with the question is
        // both everywhere in this project and part of the pleasantry vocabulary, i.e. the whole match
        // is one turn of small talk. Frequency alone is not enough evidence — this repository's own
        // corpus holds an answer deliberately worded like seven others, and a rule that discards on
        // frequency alone suppresses exactly that answer.
        const onlyCommonWords = overlapIsOnlySmallTalk(overlap, frequent);
        if (onlyCommonWords) {
          if (grey) { belowFloorIds.push(item.id); continue; }
          // A real question gets the same rule as the grey one: a match made only of pleasantries
          // is not a match, whichever lane produced the item (#321).
          belowRelevanceFloorIds.push(item.id);
          continue;
        }
      }
      // Defence 4 for real questions: a lexical retrieve is allowed to be weak, but not unrelated.
      // One content character, latin word or number in common is the floor; the neutral pronouns and
      // particles below are what a question says about itself, not about what it is asking (#321).
      if (hasContentCue && contentCueOverlap(queryText, text).length === 0) {
        belowRelevanceFloorIds.push(item.id);
        continue;
      }
      kept.push(item);
    }
    // One shape, two projections: the trace's counts and the same removals by id. Two parallel
    // if-chains here would be the same fact written twice (#187).
    const removals: Array<{ reason: RecallSuppressionReason; ids: string[] }> = [
      { reason: 'entry_social', ids: entrySocialIds },
      { reason: 'grey_below_floor', ids: belowFloorIds },
      { reason: 'below_relevance_floor', ids: belowRelevanceFloorIds },
    ];
    const dropped = removals.filter((removal) => removal.ids.length > 0);
    return {
      items: kept,
      suppressed: dropped.map((removal) => ({ reason: removal.reason, count: removal.ids.length })),
      suppressedIds: dropped.map((removal) => ({ reason: removal.reason, count: removal.ids.length, ids: removal.ids })),
    };
  }

  private queryTermFrequencies(query: AgentRecallQuery): { frequent: Set<string>; rare: Set<string> } {
    const text = String(query.query ?? '');
    const frequent = new Set<string>(); const rare = new Set<string>();
    if (!text.trim()) return { frequent, rare };
    const scopeKey = query.projectId ?? '*';
    const watermark = this.kernel.eventStore.getLatestGlobalSeq();
    let cache = RAW_TERM_DF_CACHE.get(this);
    if (!cache || cache.watermark !== watermark) RAW_TERM_DF_CACHE.set(this, cache = { watermark, counts: new Map() });
    let probes = 0;
    for (const probe of discriminativeProbes(text)) {
      if (probes >= DISCRIMINATIVE_TERM_BUDGET) break;
      probes += 1;
      const key = `${scopeKey}\u0000${probe}`;
      let count = cache.counts.get(key);
      if (count === undefined) {
        count = this.kernel.countRawEventMatches(probe, { projectId: query.projectId, cap: FREQUENT_TERM_MIN });
        cache.counts.set(key, count);
      }
      (count >= FREQUENT_TERM_MIN ? frequent : rare).add(probe);
    }
    return { frequent, rare };
  }

  // Everything but the semantic-index answer: that is a property of the kernel, not of
  // which lane answered, so it is added once at the single exit above.
  private recallCore(query: AgentRecallQuery): RecallCoreResult {
    const queryPlan = compileAgentRecallQuery({
      query: query.query,
      intent: query.intent,
      anchorText: query.anchorText,
      taxonomy: this.kernel.taxonomy,
    });
    const limit = query.limit ?? 5;
    const forensic = FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(query.intent ?? ''));
    const allowsGraph = laneAllowed(query.retrievalPolicy, 'graph');
    const allowsRawSource = laneAllowed(query.retrievalPolicy, 'raw_source');
    // Only the three intents below merge atlas items into their result. The
    // ordinary recall path reads the atlas itself, so computing these up front
    // made every recall pay for a second atlas read and throw the result away.
    const withEarlyAtlasItems = (result: RecallCoreResult): RecallCoreResult =>
      query.projectId === undefined || !allowsGraph
        ? result
        : this.withAtlasItems(result, this.atlasItemsForAgentQuery(queryPlan.primarySearchText, query, allowsRawSource), limit, forensic);
    if (queryPlan.intent === 'previous_session_summary') {
      return withEarlyAtlasItems(this.recallPreviousSession(query, queryPlan));
    }
    if (queryPlan.intent === 'forensic_quote') {
      return withEarlyAtlasItems(this.recallForensicQuote(query, queryPlan));
    }
    if (queryPlan.intent === 'historical_discussion' || queryPlan.intent === 'action_history') {
      return withEarlyAtlasItems(this.recallHistoricalDiscussion(query, queryPlan));
    }
    const atlasItems = allowsGraph ? this.atlasItemsForAgentQuery(queryPlan.primarySearchText, query, allowsRawSource) : [];
    const graphItems = allowsGraph ? this.memoryBindingGraphItemsForQuery(query, queryPlan, limit) : [];
    const rawFallbackItems = allowsRawSource ? this.rawLedgerFallbackItemsForQuery(queryPlan, query, limit) : [];
    const items = this.mergeRecallItems(graphItems, this.mergeRecallItems(rawFallbackItems, atlasItems, limit, forensic), limit, forensic);
    return {
      recallMode: 'raw_ledger_fallback',
      items,
      fallbackUsed: true,
      queryPlan,
      decisionTrace: recallDecisionTraceForSelection(
        graphItems,
        items,
        rawFallbackItems.length > 0 ? 'raw_ledger' : atlasItems.length > 0 ? 'mixed' : 'none',
        rawFallbackItems.length > 0 ? 'raw_ledger_only' : atlasItems.length > 0 ? 'graph_selected' : 'no_recall_evidence',
        {
          graph: graphItems.length,
          navigation: 0,
          scopedNavigation: 0,
          brainFallback: 0,
          rawLedger: rawFallbackItems.length,
          atlas: atlasItems.length,
        },
      ),
    };
  }

  private recallPreviousSession(query: AgentRecallQuery, queryPlan: AgentRecallQueryPlan): RecallCoreResult {
    const limit = query.limit ?? 5;
    const previousSessionId = this.findPreviousSessionId(query);
    const events = previousSessionId
      ? this.getSessionEvents(previousSessionId, query, Math.max(limit * 3, 24))
      : [];
    const items = events
      .filter((event) => this.isRawEventInRecallScope(event, query, queryPlan.intent))
      .filter((event) => !this.isOperationalNoiseRawEvent(event))
      .filter((event) => this.hasReadableEventText(event))
      .slice(0, limit)
      .map((event) => this.toAgentRawRecallItem(event, {
        sourceType: 'raw_ledger_session',
        whyMatched: 'previous_session_summary',
        canAnswerExactQuote: true,
      }));

    return {
      recallMode: 'raw_ledger_fallback',
      items,
      fallbackUsed: true,
      queryPlan,
      decisionTrace: recallDecisionTrace(items.length > 0 ? 'raw_ledger' : 'none', 'previous_session', {
        graph: 0,
        navigation: 0,
        scopedNavigation: 0,
        brainFallback: 0,
        rawLedger: items.length,
      }, items.length),
    };
  }

  private recallForensicQuote(query: AgentRecallQuery, queryPlan: AgentRecallQueryPlan): RecallCoreResult {
    const limit = query.limit ?? 5;
    const anchorItems = this.recallForensicAnchor(query, queryPlan, limit);
    const rawEvents = anchorItems.length > 0 && (queryPlan.anchorUsed || !!query.anchorEventId)
      ? []
      : [
        ...this.rawEventsForLocalDateCue(query, Math.max(limit * 4, 20)),
        ...this.searchRawEventsByQueryPlan(queryPlan, query, Math.max(limit * 4, 20)),
      ];
    const facetQuoteItems = anchorItems.length === 0 ? this.facetGraphQuoteItemsForQuery(query, queryPlan, limit) : [];
    const items = [
      ...anchorItems,
      ...rawEvents
      .filter((event) => isAgentRawEvent(event, query.agentId))
      .filter((event) => this.isRawEventInRecallScope(event, query, queryPlan.intent))
      .filter((event) => this.isQuoteSourceEvent(event))
      .filter((event) => this.hasReadableEventText(event))
      .sort((a, b) => this.quoteEventPriority(a, queryPlan) - this.quoteEventPriority(b, queryPlan))
      .slice(0, limit)
      .map((event) => this.toAgentRawRecallItem(event, {
        sourceType: 'raw_ledger',
        whyMatched: 'forensic_quote_raw_event',
        canAnswerExactQuote: true,
      })),
      ...facetQuoteItems,
    ].filter((item, index, array) => array.findIndex((candidate) => candidate.id === item.id) === index)
      .slice(0, limit);

    return {
      recallMode: 'raw_ledger_fallback',
      items,
      fallbackUsed: true,
      queryPlan,
      decisionTrace: recallDecisionTrace(
        items.length > 0 ? 'raw_ledger' : 'none',
        'forensic_quote',
        {
          graph: 0,
          navigation: 0,
          scopedNavigation: 0,
          brainFallback: 0,
          rawLedger: items.length,
        },
        items.length,
      ),
    };
  }

  private recallHistoricalDiscussion(query: AgentRecallQuery, queryPlan: AgentRecallQueryPlan): RecallCoreResult {
    const limit = query.limit ?? 5;
    const allowsGraph = laneAllowed(query.retrievalPolicy, 'graph');
    const allowsRawSource = laneAllowed(query.retrievalPolicy, 'raw_source');
    const facetResult = allowsGraph ? this.facetGraphItemsForQuery(query, limit) : { items: [], cards: [], relatedButNotSelected: [], relaxationTrace: [] };
    const facetItems = allowsRawSource ? facetResult.items : [];
    const graphItems = allowsGraph ? this.memoryBindingGraphItemsForQuery(query, queryPlan, limit) : [];
    const rawItems = allowsRawSource ? this.rawLedgerFallbackItemsForQuery(queryPlan, query, Math.max(limit * 2, 10)) : [];
    const items = this.mergeRecallItems(facetItems, this.mergeRecallItems(rawItems, graphItems, limit), limit);
    const selectedLane = facetItems.length > 0
      ? 'facet_graph_raw_ledger'
      : rawItems.length > 0
        ? 'raw_ledger'
        : graphItems.length > 0
        ? 'graph'
        : 'none';
    return {
      recallMode: facetItems.length > 0
        ? (rawItems.length > 0 ? 'atlas_raw_grounded_recall' : 'atlas_facet_recall')
        : rawItems.length > 0 ? 'raw_ledger_fallback' : 'raw_ledger_fallback',
      items,
      fallbackUsed: facetItems.length === 0,
      queryPlan,
      atlasCards: facetResult.cards,
      relatedButNotSelected: facetResult.relatedButNotSelected,
      relaxationTrace: facetResult.relaxationTrace,
      decisionTrace: recallDecisionTrace(
        selectedLane,
        queryPlan.intent === 'action_history' ? 'action_history' : 'historical_discussion',
        {
          graph: graphItems.length + facetItems.length,
          navigation: 0,
          scopedNavigation: 0,
          brainFallback: 0,
          rawLedger: rawItems.length + facetItems.length,
        },
        items.length,
      ),
    };
  }

  private facetGraphQuoteItemsForQuery(
    query: AgentRecallQuery,
    queryPlan: AgentRecallQueryPlan,
    limit: number,
  ): AgentRecallItem[] {
    try {
      const atlas = this.kernel.graphExplore(query.query, {
        projectId: query.projectId,
        limit: Math.max(limit * 2, 6),
        includeEvidence: true,
        evidenceLimit: 2,
        now: query.now,
        localDateNow: query.localDateNow,
        timeZone: query.timeZone,
        refresh: false,
        staleOk: true,
      } as any);
      const cards = (atlas.cards ?? []).slice(0, Math.max(limit * 2, 6));
      const events = cards
        .map((card) => card.sourceLocator?.eventId ?? card.evidenceEventIds[0])
        .filter((eventId): eventId is string => Boolean(eventId))
        .map((eventId) => this.kernel.getEventContext(eventId, { before: 0, after: 0 })?.event)
        .filter((event): event is MemoryEvent => Boolean(event))
        .filter((event) => this.isRawEventInRecallScope(event, query, queryPlan.intent))
        .filter((event) => this.isQuoteSourceEvent(event))
        .filter((event) => this.hasReadableEventText(event));
      return this.dedupeRawEventsByTurnPreferUser(events)
        .slice(0, limit)
        .map((event) => this.toAgentRawRecallItem(event, {
          sourceType: 'raw_ledger',
          whyMatched: 'forensic_quote_atlas_source_locator',
          canAnswerExactQuote: true,
        }));
    } catch {
      return [];
    }
  }

  private facetGraphItemsForQuery(query: AgentRecallQuery, limit: number): {
    items: AgentRecallItem[];
    cards: MemoryAtlasCard[];
    relatedButNotSelected: MemoryAtlasRelatedCard[];
    relaxationTrace: MemoryAtlasRelaxationStep[];
  } {
    try {
      const recall = this.kernel.searchAtlas(query.query, {
        projectId: query.projectId,
        limit,
        now: query.now,
        localDateNow: query.localDateNow,
        timeZone: query.timeZone,
      });
      const atlas = recall.atlas;
      const plannedCards = atlas?.cards ?? [];
      const legacyAtlas = this.kernel.graphExplore(query.query, {
        projectId: query.projectId,
        limit,
        includeEvidence: true,
        evidenceLimit: 2,
        now: query.now,
        localDateNow: query.localDateNow,
        timeZone: query.timeZone,
        refresh: false,
        staleOk: true,
      } as any);
      const cards = [...plannedCards, ...(legacyAtlas.cards ?? [])]
        .filter((card, index, all) => all.findIndex((candidate) => candidate.canonicalId === card.canonicalId) === index)
        .slice(0, limit);
      if (cards.length === 0) return { items: [], cards: [], relatedButNotSelected: [], relaxationTrace: [] };
      const items = cards.map((card) => this.toAgentRecallItemFromAtlasCard(card, query)).filter((item): item is AgentRecallItem => Boolean(item));
      const relatedButNotSelected = cards.flatMap((card) => card.relatedButNotSelected ?? []).slice(0, 8);
      return { items, cards, relatedButNotSelected, relaxationTrace: [...(atlas?.relaxationTrace ?? []), ...(legacyAtlas.relaxationTrace ?? [])] };
    } catch {
      return { items: [], cards: [], relatedButNotSelected: [], relaxationTrace: [] };
    }
  }

  private toAgentRecallItemFromAtlasCard(card: MemoryAtlasCard, query: AgentRecallQuery): AgentRecallItem | null {
    const eventIds = [...new Set([card.sourceLocator?.eventId, ...card.evidenceEventIds].filter((id): id is string => Boolean(id)))];
    const scopedAnchor = eventIds.map((id) => this.kernel.eventStore.getEvent(id)).find((event): event is MemoryEvent => Boolean(event && isAgentRawEvent(event, query.agentId) && this.isRawEventInRecallScope(event, query, query.intent)));
    const eventId = scopedAnchor?.eventId;
    if (!eventId || !scopedAnchor) return null;
    const sourceContext = this.toAgentSourceContext(eventId, query);
    const anchorEvent = sourceContext?.event;
    if (!scopedAnchor || !isAgentRawEvent(scopedAnchor, query.agentId) || !this.isRawEventInRecallScope(scopedAnchor, query, query.intent)) return null;
    const allowRaw = laneAllowed(query.retrievalPolicy, 'raw_source');
    return {
      id: `facet:${card.canonicalId}`,
      text: [card.displayTitle, card.oneLineSummary].filter(Boolean).join(': '),
      projectId: query.projectId,
      topicPath: card.parentTopics[0],
      canonicalId: card.canonicalId,
      displayTitle: card.displayTitle,
      matchedFacets: card.matchedFacets,
      matchedPaths: card.matchedPaths,
      tags: ['facet_graph', card.eventKind, card.issueType, query.agentId ? `agent:${query.agentId}` : ''].filter((tag): tag is string => Boolean(tag)),
      source: 'memory_atlas',
      sourceType: card.origin === 'legacy_facet' ? 'raw_ledger' : 'compiled_memory',
      sourceAnchor: allowRaw ? (anchorEvent ? this.toAgentSourceAnchorFromContextEvent(anchorEvent) : eventId ? { eventId } : undefined) : undefined,
      sourceContext: allowRaw ? sourceContext : undefined,
      evidenceEventIds: eventIds,
      confidence: Math.min(1, 0.7 + card.matchedFacets.length * 0.08),
      whyMatched: card.whyMatched,
      canAnswerExactQuote: Boolean(sourceContext),
    };
  }

  private toAgentRecallItemFromAtlasNode(node: MemoryAtlasNode, query: AgentRecallQuery): AgentRecallItem | null {
    const scopedEvidence = (node.evidence ?? [])
      .map((evidence) => this.kernel.eventStore.getEvent(evidence.eventId))
      .filter((event): event is MemoryEvent => Boolean(event))
      .filter((event) => isAgentRawEvent(event, query.agentId) && this.isRawEventInRecallScope(event, query, query.intent));
    const event = scopedEvidence[0];
    const eventId = event?.eventId;
    if (!event || !eventId) return null;
    const allowRaw = laneAllowed(query.retrievalPolicy, 'raw_source');
    return {
      id: `atlas-node:${node.id}`,
      text: [node.label, node.summary].filter(Boolean).join(': '),
      projectId: query.projectId,
      canonicalId: node.id,
      displayTitle: node.label,
      tags: ['atlas_node', node.nodeType, ...(query.agentId ? [`agent:${query.agentId}`] : [])],
      source: 'memory_atlas',
      sourceType: 'compiled_memory',
      sourceAnchor: allowRaw ? this.toAgentSourceAnchor(event) : undefined,
      sourceContext: allowRaw ? this.toAgentSourceContext(eventId, query) : undefined,
      evidenceEventIds: (node.evidence ?? []).map((evidence) => evidence.eventId),
      confidence: node.confidence,
      whyMatched: `atlas_${node.nodeType}`,
      canAnswerExactQuote: false,
    };
  }

  private isAllowedAtlasCollection(item: AgentRecallItem, collection?: string): boolean {
    const eventId = item.sourceAnchor?.eventId;
    if (!eventId) return item.sourceType === 'compiled_memory' || item.sourceType === 'imported_summary' || !collection;
    const event = this.kernel.eventStore.getEvent(eventId);
    return event ? isAllowedRawEventCollection(event, collection) : !collection;
  }

  private recallForensicAnchor(query: AgentRecallQuery, queryPlan: AgentRecallQueryPlan, limit: number): AgentRecallItem[] {
    if (!query.anchorEventId) return [];
    const context = this.kernel.getEventContext(query.anchorEventId, { before: 4, after: 4 });
    if (!context) return [];
    const candidates = [context.event, ...context.before.slice().reverse(), ...context.after];
    return candidates
      .filter((event) => isAgentRawEvent(event, query.agentId))
      .filter((event) => this.isRawEventInRecallScope(event, query, queryPlan.intent))
      .filter((event) => !this.isOperationalNoiseRawEvent(event))
      .filter((event) => this.isQuoteSourceEvent(event))
      .filter((event) => this.hasReadableEventText(event))
      .sort((a, b) => {
        const anchorDelta = (a.eventId === query.anchorEventId ? 0 : 1) - (b.eventId === query.anchorEventId ? 0 : 1);
        if (anchorDelta !== 0) return anchorDelta;
        return this.quoteEventPriority(a, queryPlan) - this.quoteEventPriority(b, queryPlan);
      })
      .slice(0, limit)
      .map((event) => this.toAgentRawRecallItem(event, {
        sourceType: 'raw_ledger',
        whyMatched: 'forensic_quote_anchor_event',
        canAnswerExactQuote: true,
      }));
  }

  private searchRawEventsByQueryPlan(
    queryPlan: AgentRecallQueryPlan,
    query: AgentRecallQuery,
    limit: number,
  ): MemoryEvent[] {
    const seen = new Set<string>();
    const out: MemoryEvent[] = [];
    const searchTexts = this.expandRawSearchTexts(queryPlan);
    for (const searchText of searchTexts) {
      const events = this.kernel.searchRawEvents(searchText, {
        projectId: query.projectId,
        workspaceId: query.workspaceId,
        threadId: query.threadId,
        startTime: query.startTime,
        endTime: query.endTime,
        limit,
        // Recall wants the event that answers the question. Chronological order
        // here made the oldest match the best match, so the answer a query had
        // found was ranked behind whatever happened first.
        orderBy: 'relevance',
      });
      for (const event of events) {
        if (seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        out.push(event);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  private rawEventsForLocalDateCue(query: AgentRecallQuery, limit: number): MemoryEvent[] {
    const localDate = localDateCue(query.query, query);
    if (!localDate) return [];
    const [year, month, day] = localDate.split('-').map(Number);
    const byLocalDate = this.kernel.eventStore.queryEvents(1, 1000, {
      projectId: query.projectId !== undefined ? [query.projectId] : undefined,
      workspaceId: query.workspaceId ? [query.workspaceId] : undefined,
    }).records.filter((event) => event.localDate === localDate).slice(0, limit);
    if (byLocalDate.length) return byLocalDate;
    const startTime = Date.UTC(year!, month! - 1, day!);
    const endTime = Date.UTC(year!, month! - 1, day! + 1);
    const byTime = this.kernel.eventStore.queryEvents(1, Math.max(1, Math.min(limit, 200)), {
      projectId: query.projectId !== undefined ? [query.projectId] : undefined,
      workspaceId: query.workspaceId ? [query.workspaceId] : undefined,
      startTime,
      endTime,
    }).records;
    if (byTime.length) return byTime;
    return this.kernel.eventStore.queryEvents(1, 1000, {
      projectId: query.projectId !== undefined ? [query.projectId] : undefined,
      workspaceId: query.workspaceId ? [query.workspaceId] : undefined,
    }).records.filter((event) => event.localDate === localDate).slice(0, limit);
  }

  private rawLedgerFallbackItemsForQuery(
    queryPlan: AgentRecallQueryPlan,
    query: AgentRecallQuery,
    limit: number
  ): AgentRecallItem[] {
    const scoped = this.collectRawLedgerItems(queryPlan, query, limit);
    if (scoped.length > 0 || !query.threadId) return scoped;
    // A thread is one conversation, and recall exists to reach across them. A
    // thread with no evidence of its own falls back to the whole project
    // instead of answering nothing.
    return this.collectRawLedgerItems(queryPlan, { ...query, threadId: undefined }, limit)
      .map((item) => ({ ...item, tags: [...(item.tags ?? []), 'cross_thread'] }));
  }

  private collectRawLedgerItems(
    queryPlan: AgentRecallQueryPlan,
    query: AgentRecallQuery,
    limit: number
  ): AgentRecallItem[] {
    const semanticIds = this.kernel
      .nearestRawEventIds(String(query.query ?? queryPlan.primarySearchText), query.projectId, Math.max(limit * 2, 10));
    const semanticEvents = semanticIds
      .map((eventId) => this.kernel.eventStore.getEvent(eventId))
      .filter((event): event is MemoryEvent => Boolean(event));
    const searchedEvents = [
      ...semanticEvents,
      ...this.searchRawEventsByQueryPlan(queryPlan, query, Math.max(limit * 2, 10)),
    ];
    const rawEvents = queryPlan.intent === 'forensic_quote'
      ? this.dedupeRawEventsByTurnPreferUser(searchedEvents)
      : this.dedupeRawEventsByTurnPreferCue(searchedEvents, queryPlan);
    if (semanticIds.length > 0) {
      const semanticRank = new Map(semanticIds.map((eventId, index) => [eventId, index]));
      rawEvents.sort((left, right) => (
        (semanticRank.get(left.eventId) ?? Number.MAX_SAFE_INTEGER)
        - (semanticRank.get(right.eventId) ?? Number.MAX_SAFE_INTEGER)
      ));
    }
    return rawEvents
      .filter((event) => this.isRawEventInRecallScope(event, query, queryPlan.intent))
      .filter((event) => !this.isOperationalNoiseRawEvent(event))
      .slice(0, limit)
      .map((event) => this.toAgentRawRecallItem(event, {
        sourceType: 'raw_ledger',
        whyMatched: 'raw_ledger_text_fallback',
        canAnswerExactQuote: true,
      }));
  }

  private memoryBindingGraphItemsForQuery(
    query: AgentRecallQuery,
    queryPlan: AgentRecallQueryPlan,
    limit: number
  ): AgentRecallItem[] {
    const anchors = this.kernel.recallMemoryBindingGraph(
      [query.query, queryPlan.primarySearchText, ...queryPlan.searchTexts].join('\n'),
      {
        projectId: query.projectId,
        limit: Math.max(limit * 2, 8),
      },
    );
    const items: AgentRecallItem[] = [];
    const seen = new Set<string>();

    for (const anchor of anchors) {
      if (seen.has(anchor.eventId)) continue;
      const event = this.kernel.getEventContext(anchor.eventId, { before: 0, after: 0 })?.event;
      if (!event) continue;
      if (!this.isRawEventInRecallScope(event, query, queryPlan.intent)) continue;
      if (this.isOperationalNoiseRawEvent(event)) continue;
      if (!this.hasReadableEventText(event)) continue;

      const item = this.toAgentRawRecallItem(event, {
        sourceType: 'raw_ledger',
        whyMatched: 'memory_binding_graph',
        canAnswerExactQuote: true,
      });
      items.push({
        ...item,
        topicPath: anchor.topicPath,
        confidence: anchor.confidence,
        tags: [
          ...item.tags,
          `topic:${anchor.topicPath}`,
          anchor.clusterId ? `cluster:${anchor.clusterId}` : '',
        ].filter(Boolean),
      });
      seen.add(anchor.eventId);
    }

    return items
      .sort((a, b) => this.graphRecallTextScore(b, query) - this.graphRecallTextScore(a, query))
      .slice(0, limit);
  }

  private graphRecallTextScore(item: AgentRecallItem, query: AgentRecallQuery): number {
    const queryTerms = uniqueNonEmpty(query.query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff_-]+/))
      .filter((term) => term.length >= 2 && !/^(cogmem|memory|project|之前|什么|问题|why|did|say)$/i.test(term));
    const haystack = this.itemSearchableText(item).toLowerCase();
    const overlap = queryTerms.filter((term) => haystack.includes(term)).length;
    return overlap + (item.confidence || 0);
  }

  private shouldPreferRawLedgerFallback(
    candidateItems: AgentRecallItem[],
    rawFallbackItems: AgentRecallItem[],
    queryPlan: AgentRecallQueryPlan
  ): boolean {
    if (rawFallbackItems.length === 0) return false;
    const rawHasCue = this.itemsContainRecallCue(rawFallbackItems, queryPlan);
    if (!rawHasCue) return false;

    // Ask which lane holds the better match, not whether each lane holds a match.
    // The compiled lane is a broad sample of the whole project, so it contains any
    // common word and "does this set mention the query" is true for every query —
    // measured: of eleven questions whose raw lane carried the cues, the compiled
    // lane carried them eleven times too, so the preference below never fired and
    // the compiled lane won by default while the raw lane held the record.
    const rawMatch = this.bestRecallCueMatch(rawFallbackItems, queryPlan);
    const candidateMatch = this.bestRecallCueMatch(candidateItems, queryPlan);
    if (rawMatch > candidateMatch) return true;

    if (queryPlan.temporalHints.includes('past')) {
      const rawLead = rawFallbackItems.find((item) => this.itemsContainRecallCue([item], queryPlan));
      const candidateLead = candidateItems.find((item) => this.itemsContainRecallCue([item], queryPlan));
      if (rawLead?.sourceAnchor?.role === 'user' && candidateLead?.sourceAnchor?.role !== 'user') {
        return true;
      }
    }

    return false;
  }

  /**
   * How many of the query's cues the best item in this set carries.
   *
   * A set-wide yes/no cannot compare two lanes of different sizes: a large diverse
   * set answers yes to everything. Counting the best single item's coverage says
   * which lane actually has the memory being asked about.
   */
  private bestRecallCueMatch(items: AgentRecallItem[], queryPlan: AgentRecallQueryPlan): number {
    const cues = this.recallCueTerms(queryPlan);
    if (cues.length === 0) return 0;
    let best = 0;
    for (const item of items) {
      const haystack = this.itemSearchableText(item).toLowerCase();
      const matched = cues.filter((cue) => haystack.includes(cue.toLowerCase())).length;
      if (matched > best) best = matched;
    }
    return best;
  }

  private itemsContainRecallCue(items: AgentRecallItem[], queryPlan: AgentRecallQueryPlan): boolean {
    const cues = this.recallCueTerms(queryPlan);
    if (cues.length === 0) return true;
    // One shared word is not evidence of relevance. "CI" appears in nearly every
    // review comment, so a single-word match marked the whole compiled lane as an
    // answer and kept the raw lane — which held the record — from ever being read.
    // An item carries the query when it holds more than one of its cues, or when
    // the query named only one thing and that thing is present.
    const required = cues.length === 1 ? 1 : 2;
    return items.some((item) => {
      const haystack = this.itemSearchableText(item).toLowerCase();
      const matched = cues.filter((cue) => haystack.includes(cue.toLowerCase())).length;
      return matched >= required;
    });
  }

  private recallCueTerms(queryPlan: AgentRecallQueryPlan): string[] {
    const terms = [
      ...queryPlan.keywords,
      ...queryPlan.semanticCuePhrases.flatMap((phrase) => phrase.split(/\s+/)),
    ]
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && !/^(hermes|openclaw|cogmem)$/i.test(term));
    return uniqueNonEmpty(terms);
  }

  private queryHasStructuredCue(queryPlan: AgentRecallQueryPlan): boolean {
    return /hermes|openclaw|cogmem|启动|安装|配置|重启|停止|操作|处理|执行|start|launch|install|configure|restart|stop|run/i.test(queryPlan.originalQuery)
      || queryPlan.intent === 'action_history';
  }

  private structuredCueTerms(queryPlan: AgentRecallQueryPlan): string[] {
    const terms = [
      ...queryPlan.keywords,
      ...queryPlan.semanticCuePhrases.flatMap((phrase) => phrase.split(/\s+/)),
    ]
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .filter((term) => !/^(之前|什么|做过|做了|让你|我的|原话|精确|完整|the|what|did|you|to)$/i.test(term));
    if (/启动|start|launch/i.test(queryPlan.originalQuery)) terms.push('启动', 'start', 'launch');
    if (/安装|install|setup/i.test(queryPlan.originalQuery)) terms.push('安装', 'install', 'setup');
    if (/配置|修改|config/i.test(queryPlan.originalQuery)) terms.push('配置', '修改', 'config');
    if (/操作|处理|执行|run|ran/i.test(queryPlan.originalQuery)) terms.push('操作', '执行', 'run');
    return uniqueNonEmpty(terms);
  }

  private itemSearchableText(item: AgentRecallItem): string {
    return [
      item.text,
      item.source || '',
      item.tags.join(' '),
    ].join('\n');
  }

  private mergeRecallItems(primary: AgentRecallItem[], secondary: AgentRecallItem[], limit: number, forensic = false): AgentRecallItem[] {
    const semanticAtlas = secondary.find((item) => item.source === 'memory_atlas' && (item.tags.includes('atlas_node') || item.tags.includes('facet_graph') || item.tags.includes('atlas_path')));
    const hasSemanticAtlas = primary.some((item) => item.source === 'memory_atlas' && (item.tags.includes('atlas_node') || item.tags.includes('facet_graph') || item.tags.includes('atlas_path')));
    const hasScopedPrimary = primary.some((item) => item.tags.some((tag) => tag.startsWith('agent:')));
    const promotesAtlas = Boolean(semanticAtlas) && !hasSemanticAtlas && !hasScopedPrimary && primary.length >= limit;
    const prioritizedPrimary = promotesAtlas
      ? [...primary.slice(0, Math.max(0, limit - 1)), semanticAtlas!]
      : primary;
    const merged: AgentRecallItem[] = [];
    const seen = new Set<string>();
    const keptByKey = new Map<string, AgentRecallItem>();
    const candidates = [...prioritizedPrimary, ...secondary.filter((candidate) => candidate !== semanticAtlas || !promotesAtlas)]
      .sort((left, right) => Number(left.trust === TOOL_OBSERVATION_TRUST) - Number(right.trust === TOOL_OBSERVATION_TRUST));
    for (const item of candidates) {
      const keys = [item.canonicalId, item.sourceAnchor?.eventId, item.id].filter((value): value is string => Boolean(value));
      const duplicate = keys.map((key) => keptByKey.get(key)).find((candidate): candidate is AgentRecallItem => Boolean(candidate));
      if (keys.some((key) => seen.has(key))) {
        if (duplicate && item.source === 'memory_atlas' && duplicate.source !== 'memory_atlas') {
          duplicate.displayTitle ??= item.displayTitle;
          duplicate.whyMatched ??= item.whyMatched;
          duplicate.canonicalId ??= item.canonicalId;
          for (const tag of item.tags) if (!duplicate.tags.includes(tag)) duplicate.tags.push(tag);
        }
        continue;
      }
      for (const key of keys) { seen.add(key); keptByKey.set(key, item); }
      if (item.trust === TOOL_OBSERVATION_TRUST
        && merged.some((existing) => existing.trust !== TOOL_OBSERVATION_TRUST && sameRecallContent(existing.text, item.text))) {
        continue;
      }
      merged.push(item);
    }
    const superseded = filterSuperseded(merged, (item) => ({
      id: item.id, content: item.text,
      createdAt: item.sourceContext?.event?.occurredAt ?? item.sourceAnchor?.turnSeq ?? item.sourceAnchor?.eventOrdinal ?? 0,
      orderSeq: item.sourceContext?.event?.globalSeq ?? item.sourceAnchor?.threadSeq ?? item.sourceAnchor?.eventOrdinal ?? 0,
      tags: item.tags,
      projectId: item.projectId,
    }));
    const checked = PRIVATE_CHECKED_ITEMS.get(this);
    const kept = forensic ? superseded : superseded.filter((item) => {
      if (checked?.has(item)) return true;
      if (this.withholdPrivateItem(item)) return false;
      checked?.add(item);
      return true;
    });
    return kept.slice(0, limit);
  }

  private withAtlasItems(result: RecallCoreResult, atlasItems: AgentRecallItem[], limit: number, forensic = false): RecallCoreResult {
    if (!atlasItems.length) return result;
    return { ...result, items: this.mergeRecallItems(result.items, atlasItems, limit, forensic) };
  }

  private atlasItemsForAgentQuery(searchText: string, query: AgentRecallQuery, allowsRawSource: boolean): AgentRecallItem[] {
    const recall = this.kernel.searchAtlas(searchText, {
      projectId: query.projectId,
      limit: Math.max((query.limit ?? 5) * 4, 24),
      now: query.now,
      localDateNow: query.localDateNow,
      timeZone: query.timeZone,
    });
    const cards = (recall.atlas?.cards ?? []).map((card) => this.toAgentRecallItemFromAtlasCard(card, query));
    const nodes = (recall.atlas?.nodes ?? [])
      .filter((node) => ATLAS_RECALL_NODE_TYPES.includes(node.nodeType))
      .map((node) => this.toAgentRecallItemFromAtlasNode(node, query));
    return [...cards, ...nodes]
      .filter((item): item is AgentRecallItem => Boolean(item))
      .filter((item) => item.sourceType !== 'raw_ledger' || allowsRawSource)
      .filter((item) => this.isAllowedAtlasCollection(item, query.collection));
  }

  private dedupeRawEventsByTurnPreferUser(events: MemoryEvent[]): MemoryEvent[] {
    const byTurn = new Map<string, MemoryEvent>();
    for (const event of events) {
      const key = event.turnId || event.eventId;
      const existing = byTurn.get(key);
      if (!existing) {
        byTurn.set(key, event);
        continue;
      }
      if (event.role === 'user' && existing.role !== 'user') {
        byTurn.set(key, event);
      }
    }
    return [...byTurn.values()].sort((a, b) => (
      (a.globalSeq || 0) - (b.globalSeq || 0)
      || this.quoteEventPriority(a) - this.quoteEventPriority(b)
      || a.eventId.localeCompare(b.eventId)
    ));
  }

  private expandRawSearchTexts(queryPlan: AgentRecallQueryPlan): string[] {
    const hostNeutralKeywords = queryPlan.keywords.filter((keyword) => !/^(hermes|openclaw|cogmem)$/i.test(keyword));
    return uniqueNonEmpty([
      queryPlan.originalQuery,
      queryPlan.keywords.join(' '),
      ...queryPlan.searchTexts,
      hostNeutralKeywords.join(' '),
      ...hostNeutralKeywords.filter((keyword) => keyword.length >= 2),
    ]);
  }

  private findPreviousSessionId(query: AgentRecallQuery): string | undefined {
    const page = this.kernel.eventStore.queryEvents(1, 1000, {
      projectId: query.projectId !== undefined ? [query.projectId] : undefined,
      workspaceId: query.workspaceId ? [query.workspaceId] : undefined,
      startTime: query.startTime,
      endTime: query.endTime,
    });
    const currentSessionIds = new Set([query.sessionId, query.excludeSessionId].filter((value): value is string => !!value));
    const sessionIds = new Set<string>();
    for (const event of page.records) {
      if (!event.sessionId || currentSessionIds.has(event.sessionId)) continue;
      if (!isAgentRawEvent(event, query.agentId)) continue;
      if (this.isOperationalNoiseRawEvent(event)) continue;
      sessionIds.add(event.sessionId);
    }
    return sessionIds.values().next().value;
  }

  private getSessionEvents(sessionId: string, query: AgentRecallQuery, limit: number): MemoryEvent[] {
    const page = this.kernel.eventStore.queryEvents(1, Math.max(limit, 1), {
      projectId: query.projectId !== undefined ? [query.projectId] : undefined,
      workspaceId: query.workspaceId ? [query.workspaceId] : undefined,
      sessionId: [sessionId],
      startTime: query.startTime,
      endTime: query.endTime,
    });
    return page.records
      .slice()
      .sort((a, b) => (
        (a.globalSeq || 0) - (b.globalSeq || 0)
        || (a.threadSeq || 0) - (b.threadSeq || 0)
        || (a.eventOrdinal || 0) - (b.eventOrdinal || 0)
      || a.eventId.localeCompare(b.eventId)
    ));
  }

  private dedupeRawEventsByTurnPreferCue(events: MemoryEvent[], queryPlan: AgentRecallQueryPlan): MemoryEvent[] {
    const byTurn = new Map<string, MemoryEvent>();
    for (const event of events) {
      const key = event.turnId || event.eventId;
      const existing = byTurn.get(key);
      if (!existing) {
        byTurn.set(key, event);
        continue;
      }
      const eventScore = this.rawEventCueScore(event, queryPlan);
      const existingScore = this.rawEventCueScore(existing, queryPlan);
      const rolePriority = this.quoteEventPriority(event) - this.quoteEventPriority(existing);
      if (eventScore > existingScore || (
        eventScore === existingScore
        && (
          rolePriority < 0
          || (rolePriority === 0 && this.rawEventTextLength(event) > this.rawEventTextLength(existing))
        )
      )) {
        byTurn.set(key, event);
      }
    }
    // Deliberately re-ranked. The search orders by BM25 relevance, which alone
    // ranks a second-hand retelling above the conversation it retells — this sort
    // by cue coverage is what makes the original user turn win (pinned by
    // `agent-nerve-system`: "prefers the original user anchor"). Removing it
    // raises raw-lane delivery from 2 to 4 on the evaluation corpus and changes
    // the end-to-end score not at all, because searching by relevance and
    // preferring a primary source are different questions and this ordering only
    // answers the second. A fix has to combine them — preference first, the
    // search's rank within a preference class — rather than drop one.
    // Preference first, the search's ranking within it.
    //
    // Ranking by cue coverage alone discards the BM25 order the search produced,
    // and ranking by relevance alone puts a second-hand retelling above the
    // conversation it retells. They are different questions — which source is
    // trustworthy, and which event is relevant — so the order answers them in that
    // order and keeps the search's ranking inside each class rather than throwing
    // it away.
    const searchRank = new Map(events.map((event, index) => [event.eventId, index]));
    return [...byTurn.values()].sort((a, b) => (
      this.quoteEventPriority(a, queryPlan) - this.quoteEventPriority(b, queryPlan)
      || (searchRank.get(a.eventId) ?? Number.MAX_SAFE_INTEGER) - (searchRank.get(b.eventId) ?? Number.MAX_SAFE_INTEGER)
      || a.eventId.localeCompare(b.eventId)
    ));
  }

  private rawEventCueScore(event: MemoryEvent, queryPlan: AgentRecallQueryPlan): number {
    const haystack = this.rawEventText(event).toLowerCase();
    return this.recallCueTerms(queryPlan)
      .reduce((score, cue) => score + (haystack.includes(cue.toLowerCase()) ? 1 : 0), 0);
  }

  private rawEventTextLength(event: MemoryEvent): number {
    return this.rawEventText(event).length;
  }

  private rawEventText(event: MemoryEvent): string {
    const payload = event.payload as { text?: unknown; output?: unknown; title?: unknown };
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.output === 'string') return payload.output;
    if (typeof payload.title === 'string') return payload.title;
    return JSON.stringify(event.payload);
  }

  private isRawEventInRecallScope(event: MemoryEvent, query: AgentRecallQuery, effectiveIntent?: AgentRecallIntent): boolean {
    if (event.eventType === 'SHELL_STATE_RECORDED') return false;
    if (isToolObservationEvent(event) && !isPromotedToolObservation(event)) return false;
    if (eventHoldsSecretMark(event) && !FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(effectiveIntent ?? ''))) {
      SECRET_WITHHELD_EVENT_IDS.set(this, (SECRET_WITHHELD_EVENT_IDS.get(this) ?? new Set()).add(event.eventId));
      return false;
    }
    if (eventHoldsLifeSensitivityMark(event) && !FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(effectiveIntent ?? ''))) {
      LIFE_SENSITIVITY_WITHHELD_EVENT_IDS.set(this, (LIFE_SENSITIVITY_WITHHELD_EVENT_IDS.get(this) ?? new Set()).add(event.eventId));
      return false;
    }
    if (query.projectId !== undefined && (event.projectId ?? '') !== query.projectId) return false;
    if (query.workspaceId && event.workspaceId !== query.workspaceId) return false;
    if (query.threadId && event.threadId !== query.threadId) return false;
    if (!isAgentRawEvent(event, query.agentId)) return false;
    if (!this.isAllowedSession(event, query, effectiveIntent)) return false;
    if (!isAllowedRawEventCollection(event, query.collection)) return false;
    return true;
  }

  private isOperationalNoiseRawEvent(event: MemoryEvent): boolean {
    const payload = event.payload as { text?: unknown; metadata?: Record<string, unknown> };
    const tags = Array.isArray(payload.metadata?.tags) ? payload.metadata.tags : [];
    if (tags.some((tag) => (
      tag === 'operational_noise'
      || tag === 'record:heartbeat'
      || tag === 'system:heartbeat'
      || tag === 'routine:heartbeat'
    ))) {
      return true;
    }
    return isOperationalNoiseText(typeof payload.text === 'string' ? payload.text : JSON.stringify(event.payload));
  }

  private isAllowedSession(event: MemoryEvent, query: AgentRecallQuery, effectiveIntent: AgentRecallIntent | undefined = query.intent): boolean {
    if (query.excludeSessionId && event.sessionId === query.excludeSessionId
      && (query.excludeSessionBeforeTurnSeq === undefined
        || (event.turnSeq ?? 0) >= query.excludeSessionBeforeTurnSeq)) return false;
    if (query.sessionId && effectiveIntent && effectiveIntent !== 'memory_recall' && event.sessionId === query.sessionId) return false;
    return true;
  }

  private hasReadableEventText(event: MemoryEvent): boolean {
    const payload = event.payload as { text?: unknown; output?: unknown; title?: unknown };
    return typeof payload.text === 'string'
      || typeof payload.output === 'string'
      || typeof payload.title === 'string';
  }

  private quoteEventPriority(event: MemoryEvent, queryPlan?: AgentRecallQueryPlan): number {
    const cuePenalty = queryPlan && this.rawEventCueScore(event, queryPlan) > 0 ? 0 : queryPlan ? 10 : 0;
    if (event.role === 'user') return cuePenalty;
    if (event.role === 'assistant') return cuePenalty + 1;
    return cuePenalty + 2;
  }

  private isQuoteSourceEvent(event: MemoryEvent): boolean {
    return event.role === 'user' || (!event.role && event.rawEventType === 'message');
  }

  private toAgentRawRecallItem(
    event: MemoryEvent,
    options: {
      sourceType: NonNullable<AgentRecallItem['sourceType']>;
      whyMatched: string;
      canAnswerExactQuote: boolean;
    }
  ): AgentRecallItem {
    const payload = event.payload as { text?: unknown; metadata?: Record<string, unknown> };
    const metadata = payload.metadata || {};
    const metadataTags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const sourceAgent = typeof metadata.sourceAgent === 'string' ? metadata.sourceAgent : undefined;
    const importedSummary = metadataTags.includes('governance:imported_summary_support')
      || metadataTags.includes('provenance:imported_summary')
      || metadataTags.includes('memory_layer:summary_seed')
      || metadata.reliabilityClass === 'imported_summary'
      || metadata.importedSummarySupport === true;
    const tags = [
      'raw_ledger',
      event.rawEventType ? `raw:${event.rawEventType}` : '',
      event.role ? `role:${event.role}` : '',
      event.sessionId ? `session:${event.sessionId}` : '',
      sourceAgent ? `agent:${sourceAgent}` : '',
      ...metadataTags,
    ].filter(Boolean);
    const sourceRef = metadata.sourceRef && typeof metadata.sourceRef === 'object'
      ? metadata.sourceRef as { sourcePath?: string }
      : undefined;
    const toolObservation = isToolObservationEvent(event);
    return {
      id: event.eventId,
      text: typeof payload.text === 'string' ? payload.text : JSON.stringify(event.payload),
      projectId: event.projectId,
      tags,
      source: importedSummary ? (sourceRef?.sourcePath || event.sourceId || event.eventId) : event.eventId,
      sourceType: importedSummary ? 'imported_summary' : options.sourceType,
      sourceAnchor: this.toAgentSourceAnchor(event),
      sourceContext: this.toAgentSourceContext(event.eventId),
      confidence: importedSummary ? 0.45 : 1,
      whyMatched: importedSummary
        ? 'imported_summary_raw_source_fallback'
        : toolObservation ? TOOL_OBSERVATION_WHY_MATCHED : options.whyMatched,
      canAnswerExactQuote: importedSummary ? false : options.canAnswerExactQuote,
      ...(toolObservation ? { trust: TOOL_OBSERVATION_TRUST } : {}),
    };
  }

  private toAgentSourceContext(eventId: string, scope?: AgentRecallQuery): AgentRecallSourceContext | undefined {
    const beforeCount = 2;
    const afterCount = 2;
    const context = this.kernel.getEventContext(eventId, { before: beforeCount, after: afterCount });
    if (!context) return undefined;
    const normalized = normalizeSourceContextWindow(context.event, context.before, context.after, {
      before: beforeCount,
      after: afterCount,
    });
    // The anchor was never checked and the scope test passes everything when no scope is given, which is how a
    // marked turn came back inside another item's window with its text intact (#142, second measurement) — the
    // key arrived even though the raw lane had already withheld the event itself. A marked event is therefore
    // excluded from a window by default, and only an exempt (forensic / exact-quote) intent may see it; the by-id
    // read does not come through here at all, so it stays whole.
    const secretExempt = Boolean(scope && FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(scope.intent ?? '')));
    if (eventHoldsSecretMark(context.event) && !secretExempt) return undefined;
    if (eventHoldsLifeSensitivityMark(context.event) && !secretExempt) return undefined;
    const event = this.toAgentSourceContextEvent(context.event);
    const occasion = this.kernel.occasionScope.resolve(this.binding).occasion;
    const inScope = (candidate: MemoryEvent) => {
      if (isToolObservationEvent(candidate) && !isPromotedToolObservation(candidate)) return false;
      if (!secretExempt && eventHoldsSecretMark(candidate)) return false;
      // A window is part of the answer: a daily item's neighbours must obey the same occasion as
      // the item, or a group query reaches a private turn through the two turns around it (#162).
      if (occasion !== 'private' && !occasionDecisionFor(this.kernel, occasion, {
        projectId: candidate.projectId,
        text: this.eventText(candidate),
        events: occasionChainEvents(this.kernel, candidate.eventId),
      }).allowed) return false;
      if (!secretExempt && eventHoldsLifeSensitivityMark(candidate)) return false;
      return !scope || (isAgentRawEvent(candidate, scope.agentId) && this.isRawEventInRecallScope(candidate, scope, scope.intent));
    };
    return {
      event,
      before: normalized.before.filter(inScope).map((item) => this.toAgentSourceContextEvent(item)),
      after: normalized.after.filter(inScope).map((item) => this.toAgentSourceContextEvent(item)),
      parent: context.parent && inScope(context.parent) ? this.toAgentSourceContextEvent(context.parent) : undefined,
      children: context.children.filter(inScope).map((item) => this.toAgentSourceContextEvent(item)),
      window: normalized.window,
      locator: {
        eventId: event.eventId,
        globalSeq: event.globalSeq,
        projectId: event.projectId,
        command: `cogmem memory show --event ${cliArg(event.eventId)}${event.projectId ? ` --project ${cliArg(event.projectId)}` : ''} --before 2 --after 2 --json`,
        contextCommand: `cogmem memory show --event ${cliArg(event.eventId)}${event.projectId ? ` --project ${cliArg(event.projectId)}` : ''} --before 3 --after 3 --json`,
        threadId: event.threadId,
        sessionId: event.sessionId,
        localDate: event.localDate,
      },
    };
  }

  private toAgentSourceContextEvent(event: MemoryEvent): AgentRecallSourceContextEvent {
    const text = this.eventText(event);
    return {
      eventId: event.eventId,
      globalSeq: event.globalSeq,
      label: memoryEventLabel(event),
      role: event.role,
      rawEventType: event.rawEventType,
      eventType: event.eventType,
      projectId: event.projectId,
      workspaceId: event.workspaceId,
      threadId: event.threadId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      threadSeq: event.threadSeq,
      turnSeq: event.turnSeq,
      eventOrdinal: event.eventOrdinal,
      occurredAt: event.occurredAt,
      localDate: event.localDate,
      charRange: memoryEventCharRange(event),
      sourceRange: memoryEventSourceRange(event),
      textLength: text.length,
      text,
    };
  }

  private toAgentSourceAnchorFromContextEvent(event: AgentRecallSourceContextEvent): AgentRecallSourceAnchor {
    return {
      eventId: event.eventId,
      threadId: event.threadId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      role: event.role,
      occurredAt: event.occurredAt,
      threadSeq: event.threadSeq,
      turnSeq: event.turnSeq,
      eventOrdinal: event.eventOrdinal,
    };
  }

  private toAgentSourceAnchor(event: MemoryEvent): AgentRecallSourceAnchor {
    return {
      eventId: event.eventId,
      threadId: event.threadId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      role: event.role,
      occurredAt: event.occurredAt,
      threadSeq: event.threadSeq,
      turnSeq: event.turnSeq,
      eventOrdinal: event.eventOrdinal,
      parentEventId: event.parentEventId,
      prevEventId: event.prevEventId,
      nextEventId: event.nextEventId,
      causalityType: event.causalityType,
      orderingConfidence: event.orderingConfidence,
    };
  }

  private toSourceRef(event: MemoryEvent, sourceId: string): MemorySourceRef {
    return {
      eventId: event.eventId,
      eventType: event.rawEventType || event.eventType,
      sourceId,
      contentHash: event.contentHash,
      threadId: event.threadId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      role: event.role,
      threadSeq: event.threadSeq,
      turnSeq: event.turnSeq,
      eventOrdinal: event.eventOrdinal,
      parentEventId: event.parentEventId,
      prevEventId: event.prevEventId,
      nextEventId: event.nextEventId,
      causalityType: event.causalityType,
      orderingConfidence: event.orderingConfidence,
    };
  }

  private eventText(event: MemoryEvent): string {
    return occasionEventText(event);
  }

  private buildEntityCards(
    query: AgentRecallQuery,
    allows: (id: string, text: string, events: readonly MemoryEvent[], sourceType?: string) => boolean,
  ): AgentRecallEntityCard[] {
    const cards = new Map<string, AgentRecallEntityCard>();
    for (const candidate of this.entityLookupCandidates(query.query)) {
      const entity = this.kernel.entityStore.findByAlias(candidate, undefined, query.projectId);
      if (!entity || cards.has(entity.entityId)) continue;
      const mentions = this.kernel.entityStore.listTimeline({
        entityId: entity.entityId,
        projectId: query.projectId,
        limit: 6,
      });
      const attributes = this.kernel.entityStore.listAttributes(entity.entityId, undefined, query.projectId)
        .filter((attribute) => {
          return allows(
            `${entity.entityId}:${attribute.attributeKey}`,
            `${attribute.attributeKey} ${attribute.attributeValue}`,
            occasionChainEvents(this.kernel, attribute.sourceNeuronId),
          );
        })
        .slice(0, 8);
      cards.set(entity.entityId, {
        entityId: entity.entityId,
        canonicalName: entity.canonicalName,
        type: entity.type,
        aliases: entity.aliases,
        attributes: attributes.map((attribute) => ({
          key: attribute.attributeKey,
          value: attribute.attributeValue,
          updatedAt: attribute.updatedAt,
        })),
        recentMentions: mentions.map((mention) => ({
          neuronId: mention.neuronId,
          projectId: mention.projectId,
          mentionType: mention.mentionType,
          createdAt: mention.createdAt,
        })),
      });
      if (cards.size >= 4) break;
    }
    return Array.from(cards.values());
  }

  private buildBeliefTouches(
    query: AgentRecallQuery,
    allows: (id: string, text: string, events: readonly MemoryEvent[], sourceType?: string) => boolean,
  ): AgentRecallBeliefTouch[] {
    const beliefs = this.kernel.beliefStore.getActiveBeliefsForQuery({
      query: query.query,
      projectId: query.projectId,
      limit: 6,
      intent: 'recall',
    });
    const history = this.kernel.beliefStore.getBeliefHistoryForCanonicalKeys(
      beliefs.map((belief) => belief.canonicalKey),
      { projectId: query.projectId, limitPerCanonical: 8 },
    );
    return beliefs.filter((belief) => allows(
      belief.id,
      [belief.subject, belief.predicate, belief.objectValue.normalized || belief.objectValue.raw, belief.explanation]
        .filter(Boolean)
        .join(' '),
      occasionChainEvents(this.kernel, belief.sourceEventId),
    )).map((belief) => {
      const alternatives = history.get(belief.canonicalKey) || [];
      return {
        beliefId: belief.id,
        subject: belief.subject,
        predicate: belief.predicate,
        objectValue: belief.objectValue.normalized || belief.objectValue.raw,
        confidence: belief.confidence,
        trustScore: belief.trustScore,
        status: belief.status,
        supportCount: alternatives.filter((item) => item.status === 'active' || item.status === 'superseded').length,
        conflictCount: alternatives.filter((item) => item.status === 'suspect' || item.contradictionGroup).length,
        explanation: belief.explanation,
      };
    });
  }

  private entityLookupCandidates(query: string): string[] {
    const tokens = query
      .split(/[\s,，。！？、:：?？!！/]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
    return uniqueNonEmpty([
      query.trim(),
      ...tokens,
      ...tokens.flatMap((token, index) => {
        const next = tokens[index + 1];
        return next ? [`${token} ${next}`] : [];
      }),
    ]);
  }

}

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
import { correctionAffects, profileCorrectionSignals, type ProfileCorrectionSignal } from '../profile/CorrectionSignal.js';
import type { ProfileRecallEntry } from '../profile/index.js';
import type { MemoryEvent } from '../types/index.js';
import type { ChannelBinding, Occasion, OccasionWithholdReason } from '../occasion/index.js';
import { eventsVisibleToAgent, isAgentRawEvent } from './AgentScopeRules.js';
import {
  compileAgentRecallQuery,
  extractRecallKeywords,
  type AgentRecallIntent,
  type AgentRecallQueryPlan,
} from './AgentRecallQueryCompiler.js';
import { cliArg } from '../utils/CliArgument.js';
import { projectPhaseItems } from '../recall/PhaseProjection.js';
import { localDateRange, nextCivilDate } from '../utils/LocalDateContext.js';
import { relativeDateRange } from '../temporal/RelativeDateRange.js';
import { eventHoldsSecretMark } from '../security/SecretMarks.js';
import { eventHoldsLifeSensitivityMark } from '../security/LifeSensitivity.js';
import { RecallDecisionTrace, type RecallTraceSuppression } from '../observability/RecallDecisionTrace.js';
import { TraceStore } from '../observability/TraceStore.js';
import { digestAnchors } from '../session/SessionDigest.js';
import { detectBackReference, type BackReferenceRewrite } from './BackReference.js';
import type {
  AgentRecallDecisionTrace,
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

const RRF_K = 60;
const RELATIVE_WINDOW_BOOST = 0.004;
const RELATIVE_QUERY_FILLERS = new Set([...'发生做聊说讨论问提干记告诉事情要跟去来刚才方', 'just', 'now', 'moments', 'ago']);

/**
 * Per backend instance, never global: document frequency describes one database, and a daemon serving
 * two of them must not answer the second with the first one's counts.
 */
const RAW_TERM_DF_CACHE = new WeakMap<object, { watermark: number; counts: Map<string, number> }>();
const PRIVATE_CHECKED_ITEMS = new WeakMap<object, WeakSet<AgentRecallItem>>();
const FREQUENT_TERM_MIN = 3;
const DISCRIMINATIVE_TERM_BUDGET = 8;
const RAW_LANE_CANDIDATE_FLOOR = 40;
const RAW_LANE_CANDIDATE_CAP = 200;
const BACK_REFERENCE_ANCHOR_TTL_MS = 30 * 60_000;
const PROFILE_CUE_STOP_WORDS = new Set([
  '什么', '怎么', '为什么', '哪些', '哪个', '多少', '是否', '有没有', '我们', '你们', '他们',
  '上次', '之前', '以前', '当时', '现在', '最近', '问题', '记忆',
  'the', 'a', 'an', 'what', 'did', 'do', 'we', 'you', 'last', 'about',
]);

export class AgentRecallEngine {
  constructor(private readonly kernel: MemoryKernel, private readonly binding?: ChannelBinding) {}

  recall(query: AgentRecallQuery): AgentRecallResult {
    query = this.withRelativeDates(query);
    const rewrite = this.rewriteBackReference(query);
    if (rewrite?.anchorText) query = { ...query, anchorText: rewrite.anchorText };
    if (rewrite?.followUp && rewrite.kind === 'previous_session' && rewrite.anchorTime !== undefined) {
      query = { ...query, startTime: Math.max(query.startTime ?? 0, rewrite.anchorTime) };
    }
    query = this.scopeExcludedSessionTail(query);
    const { result, suppressedIds } = this.recallPrivate(query);
    const answered = this.withSharedLane(query, result);
    const gated = this.applyOccasionGate(query, answered, suppressedIds);
    const finished = this.finishBackReference(query, rewrite, gated.result, gated.suppressedIds.length > 0);
    this.touchAtlasRecallHits(query, finished);
    this.recordRecallTrace(query, finished, gated.suppressedIds, rewrite);
    this.rememberCanonicalIds(query, finished);
    return finished;
  }

  private readonly lastCanonicalIds = new Map<string, { ids: string[]; at: number }>();

  private withRelativeDates(query: AgentRecallQuery): AgentRecallQuery {
    const timeZone = query.timeZone ?? this.kernel.eventStore.getProjectTimeZone();
    const relative = relativeDateRange(query.query, { now: query.now, localDateNow: query.localDateNow, timeZone });
    const hasContent = relative ? contentCues(relative.rest ?? query.query).some((cue) => !RELATIVE_QUERY_FILLERS.has(cue)) : false;
    return {
      ...query,
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(relative && !hasContent ? { startTime: query.startTime ?? relative.from, endTime: query.endTime ?? relative.to } : {}),
      ...(relative && hasContent ? { relativeWindow: { from: relative.from, to: relative.to } } : {}),
    };
  }

  private rewriteBackReference(query: AgentRecallQuery): BackReferenceRewrite | undefined {
    if (query.anchorText?.trim()) return undefined;
    const detection = detectBackReference(query.query);
    if (!detection) return undefined;
    try {
      const anchor = this.backReferenceAnchor(query, detection.kind);
      return {
        ...detection,
        anchorText: anchor.text,
        anchorTime: anchor.occurredAt,
        terms: anchor.text === '' ? [] : anchor.text.split(/\s+/u).filter(Boolean),
      };
    } catch {
      return undefined;
    }
  }

  private backReferenceAnchor(query: AgentRecallQuery, kind: BackReferenceRewrite['kind']): { text: string; occurredAt?: number } {
    const terms = new Set<string>();
    let occurredAt: number | undefined;
    const scopeQuery = { ...query, sessionId: undefined, excludeSessionId: undefined, excludeSessionBeforeTurnSeq: undefined };
    const addText = (text: string | undefined): void => {
      if (!text) return;
      for (const term of digestAnchors(text)) if (term.trim() !== '') terms.add(term.trim());
      for (const term of extractRecallKeywords(text).slice(0, 6)) terms.add(term);
    };
    const inScope = (event: MemoryEvent): boolean => isAgentRawEvent(event, query.agentId)
      && this.isRawEventInRecallScope(event, scopeQuery, query.intent);
    if (kind === 'previous_session') {
      const previousSessionId = this.findPreviousSessionId(query);
      const events = previousSessionId ? this.getSessionEvents(previousSessionId, query, 24) : [];
      for (const event of events
        .filter((candidate) => candidate.role === 'user' || candidate.role === 'assistant')
        .filter((candidate) => this.hasReadableEventText(candidate) && inScope(candidate))
        .slice(-4)) {
        occurredAt = occurredAt === undefined ? event.occurredAt : Math.min(occurredAt, event.occurredAt);
        addText(this.rawEventText(event));
      }
    } else {
      const sessionId = query.excludeSessionId ?? query.sessionId;
      if (sessionId) {
        const page = this.kernel.eventStore.queryEvents(1, Math.max((query.excludeSessionTailTurns ?? 0) * 2, 12), {
          projectId: query.projectId !== undefined ? [query.projectId] : undefined,
          sessionId: [sessionId],
          order: 'desc',
        });
        let assistant = false;
        let user = false;
        for (const event of page.records) {
          if (event.role === 'tool' || !this.hasReadableEventText(event) || !inScope(event)) continue;
          const text = this.rawEventText(event);
          if (normalizeQueryText(text) === normalizeQueryText(query.query)) continue;
          if (event.role === 'assistant' && !assistant) {
            assistant = true;
            addText(text);
          } else if (event.role === 'user' && !user) {
            user = true;
            addText(text);
          }
          if (assistant && user) break;
        }
      }
      if (sessionId) {
        const at = query.now ?? Date.now();
        const stored = this.lastCanonicalIds.get(this.canonicalKey(query, sessionId));
        if (stored && at - stored.at <= BACK_REFERENCE_ANCHOR_TTL_MS) {
          for (const id of stored.ids) terms.add(id);
        }
      }
    }
    return { text: [...terms].filter((term) => term.length >= 2).slice(0, 12).join(' '), occurredAt };
  }

  private finishBackReference(
    query: AgentRecallQuery,
    rewrite: BackReferenceRewrite | undefined,
    result: AgentRecallResult,
    gateWithheld: boolean,
  ): AgentRecallResult {
    if (!rewrite) return result;
    const ordered = !rewrite.followUp || result.items.length < 2
      ? result
      : {
          ...result,
          items: [...result.items].sort((left, right) => (
            (right.sourceAnchor?.occurredAt ?? right.sourceContext?.event?.occurredAt ?? 0)
            - (left.sourceAnchor?.occurredAt ?? left.sourceContext?.event?.occurredAt ?? 0)
          )),
        };
    if (ordered.items.length > 0 || !query.projectId) return ordered;
    if (gateWithheld) return ordered;
    let episodes: ReturnType<MemoryKernel['listEpisodes']>;
    try {
      episodes = this.kernel.listEpisodes({ projectId: query.projectId, limit: 5 });
    } catch {
      return ordered;
    }
    if (episodes.length === 0) return ordered;
    const menuQuery = { ...query, sessionId: undefined, excludeSessionId: undefined, excludeSessionBeforeTurnSeq: undefined };
    const candidates: AgentRecallItem[] = [];
    for (const episode of episodes) {
      const event = this.kernel.eventStore.getEvent(episode.startEventId);
      if (!event || !this.isRawEventInRecallScope(event, menuQuery, query.intent)) continue;
      candidates.push({
        id: episode.startEventId,
        text: String(episode.summary ?? episode.topicPath ?? episode.episodeType).slice(0, 80),
        tags: ['recall_menu'],
        source: episode.startEventId,
        sourceAnchor: this.toAgentSourceAnchor(event),
      });
    }
    const visible = this.gateOccasionEntries(candidates, menuQuery).items;
    if (visible.length === 0) return ordered;
    const text = [
      '<recent-items>',
      '最近事项（可指代其一继续问）：',
      ...visible.map((item) => `- ${item.text} · mem:${item.source}`),
      '</recent-items>',
    ].join('\n');
    return {
      ...ordered,
      items: [{ id: 'recent-items-menu', text, tags: ['recall_menu'], source: 'recall_menu' }],
    };
  }

  private rememberCanonicalIds(query: AgentRecallQuery, result: AgentRecallResult): void {
    const sessionId = query.excludeSessionId ?? query.sessionId;
    if (!query.recordBackReferenceAnchor || !sessionId) return;
    const ids = result.items
      .map((item) => item.canonicalId)
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .slice(0, 5);
    if (ids.length === 0) return;
    const at = query.now ?? Date.now();
    this.lastCanonicalIds.set(this.canonicalKey(query, sessionId), { ids, at });
    for (const [key, value] of this.lastCanonicalIds) {
      if (at - value.at > BACK_REFERENCE_ANCHOR_TTL_MS) this.lastCanonicalIds.delete(key);
    }
  }

  private canonicalKey(query: AgentRecallQuery, sessionId: string): string {
    return `${query.agentId}\u0000${sessionId}`;
  }

  private effectiveQueryText(query: AgentRecallQuery): string {
    return [query.query, query.anchorText]
      .map((text) => String(text ?? '').trim())
      .filter(Boolean)
      .join(' ');
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

  private withProfileItems(query: AgentRecallQuery, result: RecallCoreResult): RecallCoreResult {
    if (!query.projectId) return result;
    if (query.includeProfileLane === false) return result;
    if (!laneAllowed(query.retrievalPolicy, 'graph')) return result;
    const intent = result.queryPlan?.intent;
    if (intent === 'forensic_quote' || intent === 'previous_session_summary') return result;
    const cues = [...new Set(extractRecallKeywords(this.effectiveQueryText(query)).flatMap((keyword) => discriminativeProbes(keyword)))]
      .map((cue) => cue.toLowerCase())
      .filter((cue) => cue.length >= 2 && !PROFILE_CUE_STOP_WORDS.has(cue));
    if (cues.length === 0) return result;
    const entries = this.kernel.profile.recall({
      projectId: query.projectId,
      query: this.effectiveQueryText(query),
      cues,
      now: query.now,
    });
    if (entries.length === 0) return result;
    const seen = new Set(result.items.flatMap((item) => [item.canonicalId, item.sourceAnchor?.eventId, item.id]).filter(Boolean));
    const items = entries
      .map((entry) => this.toAgentProfileItem(entry, query))
      .filter((item): item is AgentRecallItem => Boolean(item))
      .filter((item) => {
        const keys = [item.canonicalId, item.sourceAnchor?.eventId, item.id].filter(Boolean);
        if (keys.some((key) => seen.has(key))) return false;
        keys.forEach((key) => seen.add(key));
        return true;
      })
      .slice(0, query.limit ?? 5);
    if (items.length === 0) return result;
    return { ...result, items: [...result.items, ...items] };
  }

  private withoutSupersededByProfile(
    query: AgentRecallQuery,
    result: RecallCoreResult,
    signals: readonly ProfileCorrectionSignal[],
  ): { result: RecallCoreResult; suppressed: RecallTraceSuppression[] } {
    if (!query.projectId || signals.length === 0) return { result, suppressed: [] };
    if (query.intent === 'forensic_quote' || query.intent === 'previous_session_summary') return { result, suppressed: [] };
    const dropped: string[] = [];
    const items = result.items.filter((item) => {
      if (this.itemSurvivesProfileCorrections(item, signals)) return true;
      dropped.push(item.id);
      return false;
    });
    if (dropped.length === 0) return { result, suppressed: [] };
    return {
      result: { ...result, items },
      suppressed: [{ reason: 'profile_superseded', count: dropped.length, ids: dropped }],
    };
  }

  private itemSurvivesProfileCorrections(item: AgentRecallItem, signals: readonly ProfileCorrectionSignal[]): boolean {
    const evidence = new Set(item.evidenceEventIds ?? []);
    const anchor = item.sourceAnchor?.eventId;
    if (anchor) evidence.add(anchor);
    const recordedAt = item.sourceContext?.event?.occurredAt
      ?? (anchor ? this.kernel.eventStore.getEvent(anchor)?.occurredAt : undefined);
    for (const signal of signals) {
      if (signal.previousSourceRefs.some((ref) => ref.eventId && evidence.has(ref.eventId))) return false;
      if (!this.itemSharesSignalKey(item, signal)) continue;
      if (correctionAffects(signal, { text: item.text, recordedAt })) return false;
    }
    return true;
  }

  private itemSharesSignalKey(item: AgentRecallItem, signal: ProfileCorrectionSignal): boolean {
    const key = signal.key.toLowerCase();
    return [item.canonicalId, item.displayTitle, item.topicPath, ...item.tags].some((value) => {
      const text = String(value ?? '').toLowerCase();
      return text === key || text === `canonicalkey:${key}` || text === `topic:${key}`;
    });
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

  private recordRecallTrace(
    query: AgentRecallQuery,
    result: AgentRecallResult,
    suppressedIds: RecallTraceSuppression[],
    rewrite?: BackReferenceRewrite,
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
        ...(rewrite ? { rewrite: { source: rewrite.source, termCount: rewrite.terms.length } } : {}),
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

  private projectPhases(items: AgentRecallItem[], query: AgentRecallQuery): { items: AgentRecallItem[]; suppressed: Array<{ reason: RecallSuppressionReason; count: number }> } {
    if (!this.kernel.phaseProjectionEnabled) return { items, suppressed: [] };
    const now = Number(query.now ?? Date.now());
    const projected = projectPhaseItems(items, this.effectiveQueryText(query), now);
    const suppressed: Array<{ reason: RecallSuppressionReason; count: number }> = [];
    if (projected.dormant > 0) suppressed.push({ reason: 'phase_dormant', count: projected.dormant });
    if (projected.gist > 0) suppressed.push({ reason: 'phase_gist', count: projected.gist });
    return { items: projected.items, suppressed };
  }

  private recallPrivate(query: AgentRecallQuery): { result: AgentRecallResult; suppressedIds: RecallTraceSuppression[] } {
    SECRET_WITHHELD_EVENT_IDS.set(this, new Set());
    LIFE_SENSITIVITY_WITHHELD_EVENT_IDS.set(this, new Set());
    PRIVATE_CHECKED_ITEMS.set(this, new WeakSet());
    const queryText = this.effectiveQueryText(query);
    const forensic = FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(query.intent ?? ''));
    if (!forensic && classifySocialTurn(queryText) === 'social') {
      const empty = this.emptyRecallResult(query, 'social_query_residue_empty');
      const trace: AgentRecallDecisionTrace = {
        ...empty.decisionTrace!,
        suppressed: [{ reason: 'residue_empty', count: 0 }],
      };
      return { result: { ...empty, decisionTrace: trace, semanticIndex: this.kernel.semanticIndexEnabled() }, suppressedIds: [] };
    }
    const limit = query.limit ?? 5;
    const correctionSignals = query.projectId ? profileCorrectionSignals(this.kernel.eventStore, query.projectId) : [];
    const core = this.withoutSupersededByProfile(
      query,
      this.recallCore(query, correctionSignals.length > 0 ? limit * 2 : limit),
      correctionSignals,
    );
    const capped = core.result.items.length > limit ? { ...core.result, items: core.result.items.slice(0, limit) } : core.result;
    const result = this.withProfileItems(query, capped);
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
      ...core.suppressed,
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
      mergeSuppressions(
        mergeSuppressions(result.decisionTrace?.suppressed, core.suppressed.map(({ reason, count }) => ({ reason: reason as RecallSuppressionReason, count }))),
        gated.suppressed,
      ),
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
    const text = this.effectiveQueryText(query).trim();
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
    const queryText = this.effectiveQueryText(query);
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
    const text = this.effectiveQueryText(query);
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

  private recallCore(query: AgentRecallQuery, laneLimit?: number): RecallCoreResult {
    const queryPlan = compileAgentRecallQuery({
      query: query.query,
      intent: query.intent,
      anchorText: query.anchorText,
      taxonomy: this.kernel.taxonomy,
    });
    const limit = query.limit ?? 5;
    const candidates = laneLimit ?? limit;
    const forensic = FORENSIC_SOCIAL_EXEMPT_INTENTS.has(String(query.intent ?? ''));
    const allowsGraph = laneAllowed(query.retrievalPolicy, 'graph');
    const allowsRawSource = laneAllowed(query.retrievalPolicy, 'raw_source');
    const withEarlyAtlasItems = (result: RecallCoreResult): RecallCoreResult =>
      query.projectId === undefined || !allowsGraph
        ? result
        : this.withAtlasItems(result, this.atlasItemsForAgentQuery(queryPlan.primarySearchText, query, allowsRawSource), candidates, forensic);
    if (queryPlan.intent === 'previous_session_summary') {
      return withEarlyAtlasItems(this.recallPreviousSession(query, queryPlan));
    }
    if (queryPlan.intent === 'forensic_quote') {
      return withEarlyAtlasItems(this.recallForensicQuote(query, queryPlan));
    }
    if (queryPlan.intent === 'historical_discussion' || queryPlan.intent === 'action_history') {
      return withEarlyAtlasItems(this.recallHistoricalDiscussion(query, queryPlan, candidates));
    }
    const atlasItems = allowsGraph ? this.atlasItemsForAgentQuery(queryPlan.primarySearchText, query, allowsRawSource) : [];
    const graphItems = allowsGraph ? this.memoryBindingGraphItemsForQuery(query, queryPlan, candidates) : [];
    const rawFallbackItems = allowsRawSource ? this.rawLedgerFallbackItemsForQuery(queryPlan, query, candidates) : [];
    const items = this.mergeRecallItems(graphItems, this.mergeRecallItems(rawFallbackItems, atlasItems, candidates, forensic), candidates, forensic);
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

  private recallHistoricalDiscussion(query: AgentRecallQuery, queryPlan: AgentRecallQueryPlan, laneLimit?: number): RecallCoreResult {
    const limit = laneLimit ?? query.limit ?? 5;
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
      const atlas = this.kernel.graphExplore(this.effectiveQueryText(query), {
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
      const recall = this.kernel.searchAtlas(this.effectiveQueryText(query), {
        projectId: query.projectId,
        limit,
        now: query.now,
        localDateNow: query.localDateNow,
        timeZone: query.timeZone,
      });
      const atlas = recall.atlas;
      const plannedCards = atlas?.cards ?? [];
      const legacyAtlas = this.kernel.graphExplore(this.effectiveQueryText(query), {
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
    const timeZone = query.timeZone ?? this.kernel.eventStore.getProjectTimeZone();
    const localDate = localDateCue(query.query, { now: query.now, localDateNow: query.localDateNow, timeZone });
    if (!localDate) return [];
    const [year, month, day] = localDate.split('-').map(Number);
    const scope = {
      projectId: query.projectId !== undefined ? [query.projectId] : undefined,
      workspaceId: query.workspaceId ? [query.workspaceId] : undefined,
    };
    const byLocalDate = this.kernel.eventStore.queryEvents(1, Math.max(1, limit), { ...scope, localDate }).records;
    if (byLocalDate.length) return byLocalDate;
    const next = nextCivilDate(year!, month!, day!, 1, timeZone);
    const range = localDateRange(year!, month!, day!, next[0], next[1], next[2], timeZone);
    return this.kernel.eventStore.queryEvents(1, Math.max(1, Math.min(limit, 200)), {
      ...scope,
      startTime: range.from,
      endTime: range.to,
    }).records;
  }

  private rawLedgerFallbackItemsForQuery(
    queryPlan: AgentRecallQueryPlan,
    query: AgentRecallQuery,
    limit: number
  ): AgentRecallItem[] {
    const scoped = this.collectRawLedgerItems(queryPlan, query, limit);
    if (scoped.length > 0 || !query.threadId) return scoped;
    return this.collectRawLedgerItems(queryPlan, { ...query, threadId: undefined }, limit)
      .map((item) => ({ ...item, tags: [...(item.tags ?? []), 'cross_thread'] }));
  }

  private collectRawLedgerItems(
    queryPlan: AgentRecallQueryPlan,
    query: AgentRecallQuery,
    limit: number
  ): AgentRecallItem[] {
    let candidateLimit = Math.min(Math.max(limit * 8, RAW_LANE_CANDIDATE_FLOOR), RAW_LANE_CANDIDATE_CAP);
    for (;;) {
      const semanticIds = this.kernel
        .nearestRawEventIds(this.effectiveQueryText(query) || queryPlan.primarySearchText, query.projectId, candidateLimit);
      const semanticEvents = semanticIds
        .map((eventId) => this.kernel.eventStore.getEvent(eventId))
        .filter((event): event is MemoryEvent => Boolean(event));
      const lexicalEvents = this.searchRawEventsByQueryPlan(queryPlan, query, candidateLimit);
      const searchedEvents = [
        ...semanticEvents,
        ...lexicalEvents,
      ];
      const rawEvents = queryPlan.intent === 'forensic_quote'
        ? this.dedupeRawEventsByTurnPreferUser(searchedEvents)
        : this.dedupeRawEventsByTurnPreferCue(searchedEvents, queryPlan);
      const semanticRank = new Map(semanticIds.map((eventId, index) => [eventId, index + 1]));
      const lexicalRank = new Map(lexicalEvents.map((event, index) => [event.eventId, index + 1]));
      const fusedScore = (event: MemoryEvent): number => (
        (semanticRank.has(event.eventId) ? 1 / (RRF_K + semanticRank.get(event.eventId)!) : 0)
        + (lexicalRank.has(event.eventId) ? 1 / (RRF_K + lexicalRank.get(event.eventId)!) : 0)
        + this.relativeWindowBoost(event, query)
      );
      rawEvents.sort((left, right) => fusedScore(right) - fusedScore(left));
      const items = rawEvents
        .filter((event) => this.isRawEventInRecallScope(event, query, queryPlan.intent))
        .filter((event) => !this.isOperationalNoiseRawEvent(event))
        .slice(0, limit)
        .map((event) => this.toAgentRawRecallItem(event, {
          sourceType: 'raw_ledger',
          whyMatched: 'raw_ledger_text_fallback',
          canAnswerExactQuote: true,
        }));
      if (items.length >= limit || lexicalEvents.length < candidateLimit || candidateLimit >= RAW_LANE_CANDIDATE_CAP) return items;
      candidateLimit = Math.min(candidateLimit * 2, RAW_LANE_CANDIDATE_CAP);
    }
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
    const queryTerms = discriminativeProbes(this.effectiveQueryText(query))
      .filter((term) => !/^(cogmem|memory|project|之前|什么|问题|why|did|say)$/i.test(term));
    const haystack = this.itemSearchableText(item).toLowerCase();
    const overlap = queryTerms.filter((term) => haystack.includes(term)).length;
    return overlap + (item.confidence || 0);
  }

  private recallCueTerms(queryPlan: AgentRecallQueryPlan): string[] {
    const terms = [
      ...queryPlan.keywords,
      ...queryPlan.semanticCuePhrases,
    ]
      .flatMap(discriminativeProbes)
      .filter((term) => term.length >= 2 && !/^(hermes|openclaw|cogmem)$/i.test(term));
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
      createdAt: item.sourceContext?.event?.occurredAt ?? item.sourceAnchor?.occurredAt,
      orderSeq: item.sourceContext?.event?.globalSeq,
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
      const eventUnusable = isToolObservationEvent(event) && !isPromotedToolObservation(event);
      const existingUnusable = isToolObservationEvent(existing) && !isPromotedToolObservation(existing);
      if (eventUnusable !== existingUnusable) { if (!eventUnusable) byTurn.set(key, event); continue; }
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

  private relativeWindowBoost(event: MemoryEvent, query: AgentRecallQuery): number {
    const window = query.relativeWindow;
    return window && event.occurredAt >= window.from && event.occurredAt < window.to ? RELATIVE_WINDOW_BOOST : 0;
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
    if (query.startTime !== undefined && event.occurredAt < query.startTime) return false;
    if (query.endTime !== undefined && event.occurredAt >= query.endTime) return false;
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

  private eventText(event: MemoryEvent): string {
    return occasionEventText(event);
  }

}

function normalizeQueryText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/gu, '');
}

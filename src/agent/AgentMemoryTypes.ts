import type { MemoryAtlasCard, MemoryAtlasRelatedCard, MemoryAtlasRelaxationStep } from '../atlas/MemoryAtlasTypes.js';
import type {
  MemoryEventCharRange,
  MemoryEventSourceRange,
  SourceContextWindowMetadata,
} from '../recall/SourceContextMetadata.js';
import type { BeliefRecord, MemoryEvent } from '../types/index.js';
import type { ChannelBinding, Occasion } from '../occasion/index.js';
import type { StrategyRetrievalPolicy } from '../strategy/StrategyCapsule.js';
import type { AgentRecallIntent, AgentRecallQueryPlan } from './AgentRecallQueryCompiler.js';
import type { RecallDecisionTrace, RecallTraceSuppression } from '../observability/RecallDecisionTrace.js';
export const TOOL_OBSERVATION_TRUST = 'tool_observation' as const;
export const TOOL_OBSERVATION_WHY_MATCHED = 'tool observation (untrusted)';
export const TOOL_OBSERVATION_PROMOTED_KEY = 'toolObservationPromoted';

export type AgentTurnIngestMode =
  | 'immediate_compile'
  | 'selective_compile'
  | 'raw_archive_only'
  | 'raw_then_dream';

export type AgentTurnCompileReason =
  | 'immediate_compile'
  | 'durable_signal_detected'
  | 'low_signal_turn'
  | 'raw_archive_only'
  | 'raw_then_dream'
  | 'duplicate_turn';

export interface AgentTurnMemory {
  agentId: string;
  projectId: string;
  collection?: string;
  workspaceId?: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  turnSeq?: number;
  userText: string;
  assistantText?: string;
  timestamp?: number;
  localDate?: string;
  timeZone?: string;
  projectTimeZone?: string;
  ingestMode?: AgentTurnIngestMode;
  metadata?: Record<string, unknown>;
  prewritten?: { userEventId: string; assistantEventIds?: string[] };
}

export interface AgentTurnMemoryResult {
  mode: AgentTurnIngestMode;
  reason: AgentTurnCompileReason;
  compiled: boolean;
  rawEventIds: string[];
  compiledNeuronId?: string;
  /**
   * This turn was already recorded under the caller's turn id, so nothing was written.
   * `compiled` then reports what *this* call did — nothing — not what the first call did;
   * the first call's compilation already exists and is not repeated.
   */
  duplicate?: boolean;
  /**
   * The turn id the caller supplied, echoed back.
   *
   * Present only when the caller named the turn: it is their identity being acknowledged,
   * and echoing a synthesized one would acknowledge something they never said. Retrying
   * with this value is what makes the retry a replay (#113).
   */
  turnId?: string;
}

export interface AgentRecallQuery {
  agentId: string;
  projectId: string;
  collection?: string;
  query: string;
  workspaceId?: string;
  sessionId?: string;
  threadId?: string;
  excludeSessionId?: string;
  excludeSessionTailTurns?: number;
  excludeSessionBeforeTurnSeq?: number;
  intent?: AgentRecallIntent;
  anchorEventId?: string;
  anchorText?: string;
  now?: number;
  localDateNow?: string;
  timeZone?: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
  retrievalPolicy?: StrategyRetrievalPolicy;
  includeProfileLane?: boolean;
}

export interface AgentRecallSourceAnchor {
  eventId?: string;
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  role?: MemoryEvent['role'];
  occurredAt?: number;
  threadSeq?: number;
  turnSeq?: number;
  eventOrdinal?: number;
  parentEventId?: string;
  prevEventId?: string;
  nextEventId?: string;
  causalityType?: MemoryEvent['causalityType'];
  orderingConfidence?: MemoryEvent['orderingConfidence'];
}

export interface AgentRecallSourceContextEvent {
  eventId: string;
  globalSeq?: number;
  label: string;
  role?: MemoryEvent['role'];
  rawEventType?: MemoryEvent['rawEventType'];
  eventType?: MemoryEvent['eventType'];
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  threadSeq?: number;
  turnSeq?: number;
  eventOrdinal?: number;
  occurredAt: number;
  localDate?: string;
  charRange?: MemoryEventCharRange;
  sourceRange?: MemoryEventSourceRange;
  textLength: number;
  text: string;
}

export interface AgentRecallSourceContext {
  event: AgentRecallSourceContextEvent;
  before: AgentRecallSourceContextEvent[];
  after: AgentRecallSourceContextEvent[];
  parent?: AgentRecallSourceContextEvent;
  children: AgentRecallSourceContextEvent[];
  window: SourceContextWindowMetadata;
  locator: {
    eventId: string;
    globalSeq?: number;
    projectId?: string;
    command: string;
    contextCommand?: string;
    threadId?: string;
    sessionId?: string;
    localDate?: string;
  };
}

export interface AgentToolCallMemory {
  agentId: string;
  projectId: string;
  workspaceId?: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  turnSeq?: number;
  assistantEventId?: string;
  toolCallId?: string;
  toolName: string;
  input?: unknown;
  eventOrdinal?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentToolObservationMemory {
  agentId: string;
  projectId: string;
  workspaceId?: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  turnSeq?: number;
  toolCallEventId: string;
  toolCallId?: string;
  toolName: string;
  output: string;
  eventOrdinal?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskEventMemory {
  agentId: string;
  projectId: string;
  workspaceId?: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  turnSeq?: number;
  parentEventId?: string;
  taskId?: string;
  title?: string;
  content: string;
  eventOrdinal?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentRecallItem {
  id: string;
  text: string;
  projectId?: string;
  topicPath?: string;
  canonicalId?: string;
  displayTitle?: string;
  matchedFacets?: MemoryAtlasCard['matchedFacets'];
  matchedPaths?: MemoryAtlasCard['matchedPaths'];
  tags: string[];
  source?: string;
  sourceType?: 'compiled_memory' | 'imported_summary' | 'raw_ledger' | 'raw_ledger_session';
  sourceAnchor?: AgentRecallSourceAnchor;
  sourceContext?: AgentRecallSourceContext;
  evidenceEventIds?: string[];
  confidence?: number;
  whyMatched?: string;
  canAnswerExactQuote?: boolean;
  trust?: typeof TOOL_OBSERVATION_TRUST;
  /**
   * Present when this item's text has been through redaction: how many values were
   * removed and how many characters they held. Without it a caller cannot tell an
   * altered text from the text that was written (#115).
   */
  redaction?: { count: number; chars: number };
  /**
   * Present when this item came from another agent's shared collection (#67). It is a reference, not
   * this agent's memory: the field is what lets a renderer separate the two with evidence, instead of
   * inferring it from the text.
   */
  shared?: { sourceHost: string; collection: string };
}

/**
 * Atlas node types worth returning as recall items.
 *
 * One list, because there were two: the two call sites kept their own copy, both named
 * dimensions the projection does not emit for a conversation, and the compiled lane
 * therefore returned nothing for every query (measured: `evidenceFor` found 4 nodes and
 * recall reported `navigation: 0` for the same text).
 *
 * `raw_event` is deliberately absent: the raw-ledger lane already answers with those, and
 * a card reading "assistant 2026-11-01" is not an answer.
 */
export const ATLAS_RECALL_NODE_TYPES: readonly string[] = [
  'episode', 'entity', 'topic', 'issue', 'actor', 'event', 'task', 'object', 'location', 'state', 'project', 'time',
];

/** A recall result before the single exit adds what the kernel knows about the index. */
export type RecallCoreResult = Omit<AgentRecallResult, 'semanticIndex'>;

export interface AgentRecallResult {
  recallMode: 'raw_ledger_fallback' | 'atlas_facet_recall' | 'atlas_raw_grounded_recall' | 'social_turn_suppressed';
  /**
   * Whether a semantic index was available for this answer.
   *
   * False means `memory` is `rule_only`: nothing is vectorised, so every answer here came
   * from literal matching over the raw ledger, and a paraphrase that shares no words with
   * the memory will not find it.
   */
  semanticIndex: boolean;
  items: AgentRecallItem[];
  fallbackUsed: boolean;
  queryPlan?: AgentRecallQueryPlan;
  atlasCards?: MemoryAtlasCard[];
  relatedButNotSelected?: MemoryAtlasRelatedCard[];
  relaxationTrace?: MemoryAtlasRelaxationStep[];
  /** Present on all kernel-produced results. Optional for source compatibility with external result mocks. */
  decisionTrace?: AgentRecallDecisionTrace;
}

export interface AgentRecallDecisionTrace {
  version: 'agent_recall_decision.v1';
  selectedLane: 'facet_graph_raw_ledger' | 'graph' | 'brain_fallback' | 'raw_ledger' | 'mixed' | 'none';
  reason:
    | 'social_query_residue_empty'
    | 'previous_session'
    | 'forensic_quote'
    | 'historical_discussion'
    | 'action_history'
    | 'graph_selected'
    | 'raw_cue_match_preferred'
    | 'brain_fallback_selected'
    | 'raw_ledger_only'
    | 'no_recall_evidence';
  candidateCounts: {
    graph: number;
    navigation: number;
    scopedNavigation: number;
    brainFallback: number;
    rawLedger: number;
    atlas?: number;
  };
  selectedCount: number;
  /**
   * The occasion this recall was answered in, resolved from the connection's binding (#162).
   * `occasionBinding` says whether a registered binding existed; an unbound connection is
   * `public`, the strictest occasion.
   */
  occasion?: Occasion;
  occasionBinding?: 'bound' | 'unbound';
  /**
   * What this recall withheld and why, one entry per reason.
   *
   * A gate that only removes things is indistinguishable from a memory that was never there, so
   * every suppression names itself: the query carried nothing to look up (`residue_empty`), the
   * entry is itself a social turn (`entry_social`), a raw-lane hit rested only on high-frequency
   * words (`no_discriminative_hit`), or a grey-zone query's results fell below the relevance floor
   * (`grey_below_floor`).
   */
  suppressed?: Array<{ reason: RecallSuppressionReason; count: number }>;
  /** Shared items this recall appended, and how many the shared budget turned away (#67). Counts only. */
  sharedCount?: number;
  sharedDropped?: number;
  /**
   * Why a recall that returned nothing returned nothing.
   *
   * `scope_filtered` means the question does match stored turns, but they belong to another agent
   * identity: those turns are invisible here, and a silent 0 reads as "nothing was remembered".
   * Counts only — never another identity's content.
   */
  zeroExplanation?: ZeroExplanation;
}

export type ZeroExplanation =
  | { kind: 'scope_filtered'; thisScope: 0; otherScopes: number; agentId?: string }
  | { kind: 'occasion_filtered'; count: number }
  | { kind: 'no_match'; thisScope: 0; otherScopes: 0 };

export type RecallSuppressionReason =
  | 'residue_empty'
  | 'entry_social'
  | 'no_discriminative_hit'
  | 'grey_below_floor'
  // A real (non-probe) question with no content character or word in common with the entry (#321).
  | 'below_relevance_floor'
  // Occasion scope (#162): private/high material outside `private`, or third-party material in
  // `public`. Both name themselves rather than vanishing.
  | 'occasion_private_tier'
  | 'occasion_third_party'
  // A conversation turn holding a secret: written verbatim, marked, and not injected by default.
  | 'secret_bearing_withheld'
  // Life information (health, money, papers, family): written and marked, not injected by default.
  | 'life_sensitivity_withheld'
  | 'profile_superseded'
  // Phase projection (#130), off by default: an item too old for the default lane, and one shown as a gist
  // rather than in full. Both are reported so a caller can tell "not remembered" from "not shown here".
  | 'phase_dormant'
  | 'phase_gist';

export interface AgentRecallEntityCard {
  entityId: string;
  canonicalName: string;
  type: string;
  aliases: string[];
  attributes: Array<{
    key: string;
    value: string;
    updatedAt: number;
  }>;
  recentMentions: Array<{
    neuronId?: string;
    projectId?: string;
    mentionType: string;
    createdAt: number;
  }>;
}

export interface AgentRecallBeliefTouch {
  beliefId: string;
  subject: string;
  predicate: string;
  objectValue: string;
  confidence: number;
  trustScore: number;
  status: BeliefRecord['status'];
  supportCount: number;
  conflictCount: number;
  explanation?: string;
}

export interface KernelAgentMemoryBackendOptions {
  /**
   * The connection's registered channel binding (#162). The host obtains it from
   * `kernel.occasionScope.register(...)` at connection setup. Absent means the connection is
   * unbound and answers as `public`.
   */
  binding?: ChannelBinding;
  /**
   * The identity this connection speaks for. The soul face is bound to it, so a connection cannot
   * ask for another agent's soul; absent means the soul face refuses with `agent_id_required`.
   */
  agentId?: string;
}

export interface RecallDecisionTraceRead {
  state: 'untraced' | 'empty' | 'found';
  decision?: {
    id: string;
    timestamp: number;
    payload: Record<string, unknown>;
    parentEventId?: string;
  };
  chain: string[];
}


export type { RecallTraceSuppression } from '../observability/RecallDecisionTrace.js';

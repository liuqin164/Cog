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

export type AgentTurnReceiptKind = 'commitment' | 'intention';
export type AgentTurnReceiptAction = 'confirm' | 'intention' | 'forget';

export interface AgentTurnReceipt {
  receiptId: string;
  kind: AgentTurnReceiptKind;
  provenance: 'rule_extraction';
  content: string;
  owner?: 'user' | 'agent' | 'third-party';
  dueAt?: number;
  dueCondition?: string;
  confidence: 'explicit' | 'tentative';
  sourceEventId: string;
  timeZone: string;
  text: string;
  actions: readonly AgentTurnReceiptAction[];
}

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
  duplicate?: boolean;
  turnId?: string;
  receipt?: AgentTurnReceipt;
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
  relativeWindow?: { from: number; to: number };
  retrievalPolicy?: StrategyRetrievalPolicy;
  includeProfileLane?: boolean;
  recordBackReferenceAnchor?: boolean;
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
  redaction?: { count: number; chars: number };
  shared?: { sourceHost: string; collection: string };
}

export const ATLAS_RECALL_NODE_TYPES: readonly string[] = [
  'episode', 'entity', 'topic', 'issue', 'actor', 'event', 'task', 'object', 'location', 'state', 'project', 'time',
];

export type RecallCoreResult = Omit<AgentRecallResult, 'semanticIndex'>;

export interface AgentRecallResult {
  recallMode: 'raw_ledger_fallback' | 'atlas_facet_recall' | 'atlas_raw_grounded_recall' | 'social_turn_suppressed';
  semanticIndex: boolean;
  items: AgentRecallItem[];
  fallbackUsed: boolean;
  queryPlan?: AgentRecallQueryPlan;
  atlasCards?: MemoryAtlasCard[];
  relatedButNotSelected?: MemoryAtlasRelatedCard[];
  relaxationTrace?: MemoryAtlasRelaxationStep[];
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
  occasion?: Occasion;
  occasionBinding?: 'bound' | 'unbound';
  suppressed?: Array<{ reason: RecallSuppressionReason; count: number }>;
  sharedCount?: number;
  sharedDropped?: number;
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
  | 'below_relevance_floor'
  | 'occasion_private_tier'
  | 'occasion_third_party'
  | 'secret_bearing_withheld'
  | 'life_sensitivity_withheld'
  | 'profile_superseded'
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
  binding?: ChannelBinding;
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

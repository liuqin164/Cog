import type { EmbeddingProvider } from '../embedding/EmbeddingProvider.js';
import type { EncryptionProvider } from '../encryption/index.js';
import type { RedactionPolicy } from '../governance/index.js';
import type { TurnRelationAdvisoryReviewer, EpisodeDreamStatus, MemoryEpisode } from '../episode/index.js';
import type { EpisodeBoundaryConfig } from '../episode/EpisodeBoundaryPolicy.js';
import type { EnvLike, ConfigDiagnosticLike } from '../config/CogmemConfig.js';
import type { ModelRegistry } from '../models/ModelRegistry.js';
import type { DeepWritePromotionDecision } from '../engine/DeepWritePromotionPolicy.js';
import type { DeepWriteCandidateStatus } from '../store/DeepWriteCandidateStore.js';
import type { DreamBacklogStatus } from '../store/DreamLedgerStore.js';
import type { RawEventOrder } from '../store/EventStore.js';
import type { TaxonomyResolution } from '../config/MemoryTaxonomy.js';
import type { MemoryEventCausalityType, MemoryEventRole, MemoryRawEventType, Neuron, OrderingConfidence } from '../types/index.js';
import { loadCogmemConfig, resolveCogmemConfigPath } from '../config/CogmemConfig.js';

export interface MemoryKernelOptions {
  /** Shared items one recall may append, on top of the private budget. Unset = a third of the limit. */
  sharedRecallLimit?: number;
  /** Sharing between agents. Read from `[shared] enabled`, off unless it is true. */
  sharedEnabled?: boolean;
  /** The project's classification vocabulary (#132); absent means the shipped one. */
  taxonomy?: TaxonomyResolution;
  /** The project's language for host-facing vocabulary (#135); absent means the shipped default. */
  language?: string;
  /** Phase projection (#130): a research sample, off unless a caller turns it on. */
  phaseProjectionEnabled?: boolean;
  dbPath?: string;
  vectorBackend?: string;
  vectorDimension?: number;
  embeddingProvider?: EmbeddingProvider;
  modelRegistry?: ModelRegistry;
  encryptionProvider?: EncryptionProvider;
  redactionPolicy?: RedactionPolicy | false;
  turnRelationReviewer?: TurnRelationAdvisoryReviewer;
  episodeBoundary?: Partial<EpisodeBoundaryConfig>;
  projectTimeZone?: string;
  configDiagnostics?: ConfigDiagnosticLike[];
  /** F19 (#196): where nightly whole-brain snapshots are written. Unset takes none. */
  snapshotsDir?: string;
  /** Where `/export` writes Markdown copies. Unset derives `<db dir>/exports`. */
  exportsDir?: string;
}

export interface MemoryKernelFromConfigOptions extends MemoryKernelOptions {
  configPath?: string;
  cwd?: string;
  env?: EnvLike;
}

export interface MemoryKernelConsolidationOptions {
  projectId?: string;
  startTime?: number;
  endTime?: number;
}

export interface MemoryKernelNavigationOptions {
  projectId?: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
  now?: number;
  localDateNow?: string;
  timeZone?: string;
}

export interface RawEventSearchOptions {
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  sessionId?: string;
  localDate?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  /** Declared once, in EventStore, where the two orders are explained. */
  orderBy?: RawEventOrder;
}

export type DreamCandidateStatus = DeepWriteCandidateStatus;

export interface DreamCandidateRecord {
  candidateId: string;
  runId: string;
  candidateType: string;
  status: DreamCandidateStatus;
  confidence: number;
  content: unknown;
  evidence: unknown;
  promotionTargetType?: string;
  promotionTargetId?: string;
  statusReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DreamCandidateListOptions {
  statuses?: DreamCandidateStatus[];
  candidateTypes?: string[];
  projectId?: string;
  runId?: string;
  limit?: number;
}

export interface DreamGovernanceRunOptions {
  projectId?: string;
  limit?: number;
}

export interface DreamGovernanceRunResult {
  projectId?: string;
  decisions: DeepWritePromotionDecision[];
  /** Candidates this run moved to a promoted status. */
  promotedCandidates: number;
  /** Neurons created by this run — zero unless a candidate carries a source neuron. */
  neuronsWritten: number;
  queue: {
    candidate: number;
    needsConfirmation: number;
    promoted: number;
    rejected: number;
    superseded: number;
    shadow: number;
  };
}

export interface MemoryMapOptions {
  projectId?: string;
}

export interface MemoryBindingBackfillOptions {
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  sessionId?: string;
  sinceGlobalSeq?: number;
  limit?: number;
}

export interface MemoryBindingBackfillResult {
  projectId?: string;
  sinceGlobalSeq?: number;
  nextGlobalSeq?: number;
  hasMore: boolean;
  scannedEvents: number;
  bindableEvents: number;
  boundEvents: number;
  createdBindings: number;
  skippedAlreadyBound: number;
  failedEvents: number;
  errors: Array<{
    eventId: string;
    message: string;
  }>;
}

export interface MemoryMapSection {
  id: string;
  name: string;
  role: string;
  currentCount?: number;
}

export interface MemoryDataLane {
  id: string;
  name: string;
  route: string;
  useWhen: string;
}

export interface MemorySelfMap {
  version: 'memory_map.v1';
  generatedAt: number;
  projectId?: string;
  anatomy: MemoryMapSection[];
  dataLanes: MemoryDataLane[];
  bounds: string[];
  manual: {
    commands: string[];
    agentUsage: string[];
  };
  counters: {
    rawEvents: number;
    memoryBindings: number;
    memoryBindingTopics: number;
    memoryBindingEntities: number;
    memoryBindingClusters: number;
    memoryBindingEdges: number;
    episodes: number;
    unassignedRawEvents: number;
    episodeDream: EpisodeDreamStatus;
    dreamBacklog: DreamBacklogStatus;
    dreamCandidateQueue: DreamGovernanceRunResult['queue'];
  };
}

export interface MaintenanceTickOptions {
  projectId?: string;
  activationDecayFactor?: number;
  confirmationTtlMs?: number;
  now?: number;
  atlasAccessRetentionMs?: number;
  /**
   * Whether this tick runs the atlas reconciliation pass. Set false by a caller that
   * finishes with its own pass over the work it did — the Night, whose run ends by
   * reconciling what Dream just wrote. Without this the Night reconciled twice per
   * run (#106): the tick's pass ran *before* Dream wrote the frames it was there to
   * notice, so the run paid a corpus rebuild for work it had not done yet, and then
   * paid for it again afterwards.
   */
  atlasRefresh?: boolean;
}

export interface MaintenanceSuggestedAction {
  kind:
    | 'dream_curator'
    | 'govern_candidates'
    | 'resolve_entities'
    | 'bind_raw_events'
    | 'inspect_binding_failures'
    | 'repair_episodes';
  command: string;
  executable: string;
  args: string[];
  reason: string;
}

export interface MaintenanceTickResult {
  version: 'maintenance_tick.v1';
  projectId?: string;
  ranAt: number;
  hostOwned: true;
  chargeVector: {
    dreamBacklog: number;
    candidateQueue: number;
    entityConflicts: number;
    unboundRawEvents: number;
    bindingFailures: number;
    expiredConfirmationCandidates: number;
    episodeDreamBacklog: number;
    unassignedEpisodeRawEvents: number;
  };
  executed: {
    /** Conversations the tick judged over: their episodes are sealed for Dream (#87). */
    episodeSealing: { idleGapMs: number; idleBefore: number; sealedEpisodes: number };
    memoryAtlasRefresh: { documents: number; actions: number; refreshed: boolean; /** This tick was told not to run the pass. */ skipped?: boolean; errors?: Array<{ projectId: string; error: string }> };
    memoryAtlasActivationDecay: number;
    memoryAtlasAccessPruned: number;
    reviewQueueAging: {
      expired: number;
      candidateIds: string[];
      cutoff: number;
      ttlMs: number;
    };
    hiddenDaemonStarted: false;
  };
  suggestedActions: MaintenanceSuggestedAction[];
}

export interface RawMemoryEventInput {
  eventId?: string;
  projectId?: string;
  workspaceId?: string;
  threadId: string;
  sessionId?: string;
  turnId?: string;
  turnSeq?: number;
  role: MemoryEventRole;
  rawEventType?: MemoryRawEventType;
  content: string;
  eventOrdinal?: number;
  occurredAt?: number;
  parentEventId?: string;
  prevEventId?: string;
  causalityType?: MemoryEventCausalityType;
  sourceId?: string;
  sourceOffset?: number;
  lineStart?: number;
  lineEnd?: number;
  charStart?: number;
  charEnd?: number;
  orderingConfidence?: OrderingConfidence;
  localDate?: string;
  localDateSource?: 'explicit' | 'legacy_unknown';
  timeZone?: string;
  projectTimeZone?: string;
  metadata?: Record<string, unknown>;
}

export interface EpisodeMessageInput {
  projectId: string;
  sessionId: string;
  sourceAgent: string;
  role: MemoryEventRole;
  text: string;
  externalMessageId?: string;
  timestamp?: number;
  threadId?: string;
  turnId?: string;
  turnSeq?: number;
  localDate?: string;
  eventOrdinal?: number;
  metadata?: Record<string, unknown>;
}

export interface EpisodeMessageResult {
  created: boolean;
  eventId: string;
  episodeId?: string;
  assigned: boolean;
  ignored: boolean;
  sealed: boolean;
  dreamRecommended: boolean;
  dreamRan: false;
  boundaryTriggered?: boolean;
  boundaryDetected?: boolean;
  boundaryApplied?: boolean;
  boundaryMode?: string;
  boundaryDecisionId?: string;
  boundaryGuardCodes?: string[];
  boundaryAuditRecorded?: boolean;
  boundaryAuditStatus?: string;
  previousEpisodeId?: string;
  reviewerRawResultStatus?: string;
  warnings?: string[];
}

export type EpisodeRepairInput =
  | { operation: 'move-event'; projectId: string; eventId: string; targetEpisodeId: string; now?: number }
  | { operation: 'split'; projectId: string; episodeId: string; eventIds: string[]; now?: number }
  | { operation: 'merge'; projectId: string; sourceEpisodeId: string; targetEpisodeId: string; now?: number }
  | { operation: 'reclassify'; projectId: string; episodeId: string; episodeType?: MemoryEpisode['episodeType']; topicPath?: string; importance?: number; now?: number }
  | { operation: 'requeue-dream' | 'invalidate-dream-run'; projectId: string; episodeId: string; mode?: 'micro' | 'normal' | 'deep'; now?: number };

export interface EpisodeRepairResult {
  repairId: string;
  applied: boolean;
  operation: EpisodeRepairInput['operation'];
  affectedEpisodeIds: string[];
  changedFields: string[];
  staleCandidateIds: string[];
  requeuedDream: boolean;
  graphRefreshNeeded: boolean;
  nextCommands: string[];
  note: string;
}

export interface ToolCallMemoryEventInput {
  projectId?: string;
  workspaceId?: string;
  threadId: string;
  sessionId?: string;
  turnId?: string;
  turnSeq?: number;
  assistantEventId?: string;
  toolCallId?: string;
  toolName: string;
  input?: unknown;
  content?: string;
  eventOrdinal?: number;
  occurredAt?: number;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolResultMemoryEventInput {
  projectId?: string;
  workspaceId?: string;
  threadId: string;
  sessionId?: string;
  turnId?: string;
  turnSeq?: number;
  toolCallEventId: string;
  toolCallId?: string;
  toolName: string;
  output: string;
  eventOrdinal?: number;
  occurredAt?: number;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskMemoryEventInput {
  projectId?: string;
  workspaceId?: string;
  threadId: string;
  sessionId?: string;
  turnId?: string;
  turnSeq?: number;
  parentEventId?: string;
  taskId?: string;
  title?: string;
  content: string;
  role?: MemoryEventRole;
  rawEventType?: Extract<MemoryRawEventType, 'task_event' | 'action_result'>;
  eventOrdinal?: number;
  occurredAt?: number;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryKernelNavigationResult {
  query: string;
  projectId?: string;
  recallMode: 'brain_recall_fallback';
  fallbackUsed: boolean;
  rawEvidence: Neuron[];
}

export interface ForgetUserResult {
  projectId: string;
  auditId: string;
  deleted: {
    events: number;
    facts: number;
    compiledEvents: number;
    memoryBindings: number;
    episodes: number;
    brainProjections: number;
    entityRecords: number;
  };
}

export interface GovernanceAuditRecord {
  auditId: string;
  action: string;
  projectId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  createdAt: number;
}

export function resolveMemoryKernelOptionsFromConfig(input: string | MemoryKernelFromConfigOptions = {}): MemoryKernelOptions {
  const options = typeof input === 'string' ? { configPath: input } : input;
  const resolution = resolveCogmemConfigPath({
    configPath: options.configPath,
    cwd: options.cwd,
    env: options.env,
  });
  if (resolution.kind === 'missing') {
    throw new Error(`Missing cogmem config at ${resolution.path}. Run cogmem init first.`);
  }

  const loaded = loadCogmemConfig({
    configPath: resolution.path,
    cwd: options.cwd,
    env: options.env,
  });
  const error = loaded.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (error) throw new Error(`${error.code}: ${error.message}`);

  const {
    configPath: _configPath,
    cwd: _cwd,
    env: _env,
    ...explicitOptions
  } = options;
  return {
    ...loaded.options,
    ...explicitOptions,
    episodeBoundary: { ...loaded.options.episodeBoundary, ...explicitOptions.episodeBoundary },
    configDiagnostics: [...loaded.diagnostics, ...(explicitOptions.configDiagnostics || [])],
  };
}

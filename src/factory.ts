import { cliArg } from './utils/CliArgument.js';
import { describeSqliteTempDirectoryFailure } from './utils/SqliteTempDirectory.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'bun:sqlite';
import type { GraphEdgeStoreLike } from './types/ExtensionPoints.js';

import { BeliefStore } from './belief/BeliefStore.js';
import { projectFrameRelationsToBeliefs } from './belief/FrameRelationBeliefs.js';
import { BeliefGovernanceService } from './belief/BeliefGovernanceService.js';
import {
  MemoryBindingService,
  type MemoryBindingListOptions,
  type MemoryBindingRecord,
  type MemoryBindingStats,
  type MemoryClusterListOptions,
  type MemoryClusterRecord,
  type MemoryEdgeListOptions,
  type MemoryEdgeRecord,
  type MemoryGraphRecallAnchor,
} from './binding/index.js';
import { IngestionCursorStore } from './batch/IngestionCursorStore.js';
import { NeuronFactory } from './core/Neuron.js';
import { AtlasPathRetriever, MultidimensionalQueryPlanner } from './recall/index.js';
import { ConsolidationPipeline } from './engine/ConsolidationPipeline.js';
import { DeepWritePromotionPolicy, type DeepWritePromotionDecision } from './engine/DeepWritePromotionPolicy.js';
import { DreamCuratorWorker, type DreamCuratorRunOptions, type DreamCuratorRunResult } from './engine/DreamCuratorWorker.js';
import { EntityResolutionEngine } from './engine/EntityResolutionEngine.js';
import { FactCompiler } from './engine/FactCompiler.js';
import { InteractionBinder } from './engine/InteractionBinder.js';
import { LocalSemanticCompiler } from './engine/LocalSemanticCompiler.js';
import { PipelineMetrics } from './engine/PipelineMetrics.js';
import type { EmbeddingProvider } from './embedding/EmbeddingProvider.js';
import { EventEmbeddingStore } from './embedding/EventEmbeddingStore.js';
import { RECALL_TRACE_MAX_ROWS } from './observability/RecallDecisionTrace.js';
import type { EncryptionProvider } from './encryption/index.js';
import { TopicAliasRegistry, TopicGovernance, TopicPathRegistry as UserTopicPathRegistry, TopicRelationGraph } from './topic/index.js';
import { CorrectionResolver } from './episode/CorrectionResolver.js';
import {
  CandidateReviewService,
  MemoryGovernanceExecutor,
  MemoryGovernanceValidator,
  PiiRedactor,
  type MemoryGovernanceExecutionResult,
  type MemoryGovernancePlan,
  type RedactionPolicy,
  type CandidateReviewInput,
  type CandidateReviewResult,
} from './governance/index.js';

import { installRuntimeProvenanceGuards } from './migrations/v3_7_4/FinalRuntimeGuards.js';
import {
  LATEST_SCHEMA_VERSION,
  assertSupportedDatabase,
  createFinalSchema,
  hasUserSchema,
} from './migrations/v3_7_4/FinalSchema.js';
import { ensureUsableTempSpace } from './utils/SqliteTempDirectory.js';
import { EntityGovernanceService } from './entity/index.js';
import { DEFAULT_RHYTHM_SAMPLE_DAYS, TemporalMemoryService, WakeIntentionService, WakeScheduler, computeTemporalContext, evaluateDreamWindow as evaluateDreamWindowAt, type DreamWindow, type DreamWindowEvaluation, type TemporalAnchor, type TemporalContext, type WakeTickInput, type WakeTickResult } from './temporal/index.js';
import { ConversationCaptureService, type ConversationTurnInput, type ConversationTurnQuery, type ConversationTurnRecord } from './conversation/index.js';
import { SessionContextService, type SessionContextItem } from './session/index.js';
import { PersonDirectory } from './person/index.js';
import { ProfileCompiler } from './profile/index.js';
import { SurfacingCandidates, SurfacingFeedback } from './surfacing/index.js';
import { OccasionScope } from './occasion/index.js';
import { DeliveryRouter } from './delivery/index.js';
import { ProcedureCompiler } from './procedure/index.js';
import { CommitmentBook } from './commitment/index.js';
import { IntentionBook } from './intention/index.js';
import { SoulService } from './soul/index.js';
import { ContextCortex } from './context/index.js';
import { ProspectiveMemoryService } from './prospective/index.js';
import { KernelEventStream, ledgerAppendEvent } from './events/index.js';
import { StrategyCortex } from './strategy/index.js';
import { ContextOutcomeStore, MemoryUseJudge } from './eval/strategy/index.js';
import { EpisodeAssembler, EpisodeStore, type EpisodeBoundaryDecisionRecord, type EpisodeClosureMode, type EpisodeClosureReceipt, type EpisodeDreamStatus, type EpisodeListOptions, type MemoryEpisode, type TurnRelationAdvisoryReviewer } from './episode/index.js';
import { EpisodeBoundaryAuditService, type EpisodeBoundaryAuditResult } from './episode/EpisodeBoundaryAuditService.js';
import { localDateFor, resolveProjectClockContext, type ProjectClockContext } from './utils/LocalDateContext.js';
import { EpisodeBoundaryPolicy, normalizeEpisodeBoundaryConfig, type EpisodeBoundaryConfig } from './episode/EpisodeBoundaryPolicy.js';
import { logicalTurnsFromPairs } from './episode/EpisodeBoundaryReplayEngine.js';
import { EpisodeSplitPlanner, type EpisodeSplitPlan } from './episode/EpisodeSplitPlanner.js';
import { DreamScheduler, type DreamTickOptions, type DreamTickResult } from './dream/index.js';
import {
  loadCogmemConfig,
  resolveCogmemConfigPath,
  type EnvLike,
  type ConfigDiagnosticLike,
} from './config/CogmemConfig.js';
import { ModelRegistry } from './models/ModelRegistry.js';
import { DeepWriteCandidateStore, type DeepWriteCandidateStatus } from './store/DeepWriteCandidateStore.js';
import { CandidateReviewStore, type CandidateReviewRecord } from './store/CandidateReviewStore.js';
import { CompilerConfidenceStore } from './store/CompilerConfidenceStore.js';
import { DreamLedgerStore, type DreamBacklogStatus } from './store/DreamLedgerStore.js';
import { EntityStore } from './store/EntityStore.js';
import { EventStore, type RawEventOrder } from './store/EventStore.js';
import { FactStore } from './store/FactStore.js';
import { InteractionUnitStore } from './store/InteractionUnitStore.js';
import { MemoryBindingStore } from './store/MemoryBindingStore.js';
import { MemoryAtlasStore } from './store/MemoryAtlasStore.js';
import { MemoryFrameStore, frameSourceFingerprint } from './store/MemoryFrameStore.js';
import { deterministicFrameFallback } from './semantic/DeterministicFrameFallback.js';
import type { MemoryFrameV1 } from './semantic/MemoryFrameTypes.js';
import {
  MemoryAtlasIndexer,
  MemoryAtlasService,
  type MemoryAtlasNodeDetail,
  type MemoryAtlasPathResult,
  type MemoryAtlasQueryOptions,
  type MemoryAtlasSlice,
  type MemoryAtlasTimelineResult,
} from './atlas/index.js';
import { MemoryGovernanceStore } from './store/MemoryGovernanceStore.js';
import { SummaryStore } from './store/SummaryStore.js';
import { matchesProjectScope, projectScope } from './topology/ProjectScope.js';
import { deleteRegisteredProjectContent, deleteResidualProjectOwnedContent } from './governance/PrivacyDeletionRegistry.js';
import type {
  IngestInput,
  MemoryEvent,
  MemoryEventCausalityType,
  MemoryEventContext,
  MemoryRawEventType,
  MemoryEventRole,
  Neuron,
  NeuronMetadata,
  OrderingConfidence,
} from './types/index.js';
import { config } from './utils/Config.js';
import {
  BrainBackup,
  BrainBundle,
  KernelRunningError,
  SnapshotExporter,
  SnapshotImporter,
  type BrainConfig,
  type BrainManifest,
  type ImportOptions,
  type ImportResult,
  type SnapshotMeta,
} from './snapshot/index.js';
import { HealthService } from './health/index.js';
import { CORE_VERSION } from './version.js';
import { SqliteSharedMemory } from './adapters/sqlite/SqliteSharedMemory.js';
import type { SharedCollection, SharedItem, SharedRetraction } from './ports/index.js';
import { DEFAULT_TAXONOMY, type MemoryTaxonomy, type TaxonomyResolution } from './config/MemoryTaxonomy.js';
import { setConfiguredLanguage } from './config/LanguagePacks.js';
import { secretFindingsMetadata } from './security/SecretPatterns.js';
import { lifeSensitivityMetadata, type LifeSensitivityTier } from './security/LifeSensitivity.js';
import { MemorySovereigntyService } from './sovereignty/index.js';
import { KernelServices } from './factory/KernelServices.js';
import {
  resolveMemoryKernelOptionsFromConfig,
  type MemoryKernelOptions,
} from './factory/KernelOptions.js';
import {
  agentTurnEventId,
  changedFieldsForRepair,
  eventPayloadText,
  extractNavigationTerms,
  optionalGovernancePayloadNumber,
  optionalGovernancePayloadString,
  parseJsonObject,
  parseJsonStringArray,
  rebuildCanonicalEntityAfterForget,
  requireProjectId,
  requiredGovernancePayloadString,
  sameProvided,
  scrubEntityAliasConflicts,
  shellQuote,
  stringifyToolPayload,
  uniqueStrings,
  validateEpisodeRepairInput,
  type AgentTurnClaim,
  type AgentTurnIdentityInput,
} from './factory/KernelSupport.js';
import type {
  DreamCandidateListOptions,
  DreamCandidateRecord,
  DreamCandidateStatus,
  DreamGovernanceRunOptions,
  DreamGovernanceRunResult,
  EpisodeMessageInput,
  EpisodeMessageResult,
  EpisodeRepairInput,
  EpisodeRepairResult,
  ForgetUserResult,
  GovernanceAuditRecord,
  MaintenanceSuggestedAction,
  MaintenanceTickOptions,
  MaintenanceTickResult,
  MemoryBindingBackfillOptions,
  MemoryBindingBackfillResult,
  MemoryDataLane,
  MemoryKernelFromConfigOptions,
  MemoryMapOptions,
  MemoryMapSection,
  MemorySelfMap,
  RawEventSearchOptions,
  RawMemoryEventInput,
  TaskMemoryEventInput,
  ToolCallMemoryEventInput,
  ToolResultMemoryEventInput,
} from './factory/KernelOptions.js';
export type { DreamCuratorRunOptions, DreamCuratorRunResult } from './engine/DreamCuratorWorker.js';
export type { DreamTickOptions, DreamTickResult } from './dream/index.js';
export type { EpisodeClosureReceipt, EpisodeDreamStatus, EpisodeListOptions, MemoryEpisode } from './episode/index.js';

const ATLAS_RECALL_REFRESH_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIRMATION_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
const HIGH_PRIVILEGE_CANDIDATE_TYPES = ['preferences', 'user_preference', 'long_term_goal', 'boundary', 'failure_lesson'];
export type * from './factory/KernelOptions.js';

export class MemoryKernel extends KernelServices {
  async initialize(skipWarmup = true): Promise<void> {
    if (this.initialized) return;
    void skipWarmup;
    this.initialized = true;
  }

  async start(): Promise<void> {
    await this.initialize();
  }

  stop(): void {
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.beliefStore.close();
    this.cursorStore.close();
    this.eventStore.close();
    this.entityStore.close();
    this.interactionUnitStore.close();
    this.compilerConfidenceStore.close();
    this.factStore.close();
    // bun:sqlite close(false) waits for temporary prepared statements to be
    // finalized. An explicit Kernel close must release the file before a CLI
    // process can reopen it, even while the Kernel object remains reachable.
    Bun.gc(true);
  }

  compileMemory(input: IngestInput, sourceEventId?: string): Neuron {
    const createdAt = input.createdAt ?? Date.now();
    const eventId = sourceEventId ?? input.sourceEventId ?? `compiled-${randomUUID()}`;
    const metadata: NeuronMetadata = {
      projectId: input.projectId,
      topicPath: input.topicPath,
      filePath: input.filePath,
      type: input.type ?? 'chat',
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
      tags: input.tags,
      confidence: 1.0,
      sourceType: input.sourceType || 'user_input',
      sourceEventId: eventId,
      sourceRefs: input.sourceRefs,
      stability: 1.0,
      repetitions: 0,
      importanceLevel: input.importanceLevel ?? 'normal',
      isPinned: input.isPinned ?? false,
    };
    const neuron = NeuronFactory.create(
      input.content,
      'genesis',
      { T: createdAt, S: [0, 0, 0], V: [] },
      metadata,
    );
    neuron.id = eventId;
    this.consolidationPipeline.consolidate(neuron, eventId);
    this.queueEventEmbedding(eventId, input.content, input.projectId);
    return neuron;
  }

  private queueEventEmbedding(eventId: string, content: string, projectId?: string): void {
    if (!this.embeddingProvider) return;
    const embedDocument = this.embeddingProvider.embedBatch
      ? this.embeddingProvider.embedBatch([content]).then(([vector]) => vector)
      : this.embeddingProvider.embed(content);
    embedDocument
      .then((vector) => {
        if (vector.length !== this.embeddingProvider!.dimensions) {
          throw new Error(`Embedding dimension mismatch for ${this.embeddingProvider!.modelId}: expected ${this.embeddingProvider!.dimensions}, got ${vector.length}`);
        }
        this.eventEmbeddingStore.upsert(
          eventId,
          this.embeddingProvider!.modelId,
          new Float32Array(vector),
          projectId,
        );
      })
      .catch((error) => {
        this.pipelineMetrics.recordNonFatal('event_embedding_failed', {
          projectId,
          message: error instanceof Error ? error.message : String(error),
          details: { eventId },
        });
      });
  }

  nearestRawEventIds(query: string, projectId: string | undefined, limit: number): string[] {
    if (!this.embeddingProvider) return [];
    const embedSync = (this.embeddingProvider as EmbeddingProvider & {
      embedSync?: (text: string) => Float32Array;
    }).embedSync;
    if (typeof embedSync !== 'function') return [];
    try {
      const vector = embedSync.call(this.embeddingProvider, query);
      if (vector.length === 0) return [];
      return this.eventEmbeddingStore
        .findNearest(vector, projectId, limit, this.embeddingProvider.modelId)
        .map((hit) => hit.eventId);
    } catch {
      return [];
    }
  }

  async backfillEventEmbeddingBatch(options: {
    projectId?: string;
    limit?: number;
    afterRowId?: number;
  } = {}): Promise<{ completed: number; failed: number; nextRowId: number; hasMore: boolean }> {
    const provider = this.embeddingProvider;
    const afterRowId = options.afterRowId ?? 0;
    if (!provider) return { completed: 0, failed: 0, nextRowId: afterRowId, hasMore: false };
    const batchSize = Math.max(1, options.limit ?? 16);
    const db = this.factStore.getDatabase();
    const scoped = options.projectId !== undefined;
    const select = db.prepare(`
      SELECT e.rowid AS row_id, e.event_id AS event_id, e.project_id AS project_id, e.payload_json AS payload_json
      FROM memory_events e
      LEFT JOIN memory_event_embeddings ee ON ee.event_id = e.event_id AND ee.model_id = ?
      WHERE e.event_type = 'RAW_EVENT_RECORDED'
        AND ee.event_id IS NULL
        AND e.rowid > ?
        ${scoped ? `AND COALESCE(e.project_id,'') = ?` : ''}
      ORDER BY e.rowid
      LIMIT ?
    `);
    const rows = (scoped
      ? select.all(provider.modelId, afterRowId, options.projectId ?? '', batchSize)
      : select.all(provider.modelId, afterRowId, batchSize)) as Array<{
        row_id: number;
        event_id: string;
        project_id: string | null;
        payload_json: string;
      }>;
    let completed = 0, failed = 0;
    if (rows.length > 0) {
      const entries = rows.map((row) => {
        let text = row.payload_json;
        try {
          const payload = JSON.parse(row.payload_json) as { text?: unknown };
          if (typeof payload.text === 'string') text = payload.text;
        } catch {}
        return { ...row, text };
      });
      try {
        const vectors = await provider.embedBatch(entries.map((entry) => entry.text));
        for (const [index, entry] of entries.entries()) {
          const vector = vectors[index];
          if (!vector || vector.length !== provider.dimensions) {
            failed += 1;
            this.pipelineMetrics.recordNonFatal('event_embedding_failed', {
              projectId: entry.project_id ?? undefined,
              message: `Embedding dimension mismatch for ${provider.modelId}: expected ${provider.dimensions}, got ${vector?.length ?? 0}`,
              details: { eventId: entry.event_id },
            });
            continue;
          }
          this.eventEmbeddingStore.upsert(entry.event_id, provider.modelId, vector, entry.project_id ?? undefined);
          completed += 1;
        }
      } catch (error) {
        failed += entries.length;
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of entries) {
          this.pipelineMetrics.recordNonFatal('event_embedding_failed', {
            projectId: entry.project_id ?? undefined,
            message,
            details: { eventId: entry.event_id },
          });
        }
      }
    }
    return {
      completed,
      failed,
      nextRowId: rows.at(-1)?.row_id ?? afterRowId,
      hasMore: rows.length === batchSize,
    };
  }

  async backfillEventEmbeddings(options: { projectId?: string; limit?: number; yieldMs?: number } = {}): Promise<{ completed: number; failed: number }> {
    const provider = this.embeddingProvider;
    if (!provider) return { completed: 0, failed: 0 };
    const batchSize = Math.max(1, options.limit ?? 64);
    let completed = 0;
    let failed = 0;
    let afterRowId = 0;
    for (;;) {
      const batch = await this.backfillEventEmbeddingBatch({ ...options, limit: batchSize, afterRowId });
      completed += batch.completed;
      failed += batch.failed;
      if (!batch.hasMore) break;
      afterRowId = batch.nextRowId;
      if (options.yieldMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.yieldMs));
    }
    const db = this.factStore.getDatabase();
    db.prepare(`DELETE FROM memory_event_embeddings WHERE model_id<>?`).run(provider.modelId);
    return { completed, failed };
  }

  getEmbeddingBacklog(projectId?: string): { count: number; oldestAt?: number } {
    const provider = this.embeddingProvider;
    if (!provider) return { count: 0 };
    const scoped = projectId !== undefined;
    const row = this.factStore.getDatabase().prepare(`
      SELECT COUNT(*) AS count, MIN(e.occurred_at) AS oldest_at
      FROM memory_events e
      LEFT JOIN memory_event_embeddings ee ON ee.event_id = e.event_id AND ee.model_id = ?
      WHERE e.event_type = 'RAW_EVENT_RECORDED'
        AND ee.event_id IS NULL
        ${scoped ? `AND COALESCE(e.project_id,'') = ?` : ''}
    `).get(...(scoped ? [provider.modelId, projectId] : [provider.modelId])) as { count?: number; oldest_at?: number | null } | null;
    const oldest = row?.oldest_at;
    return {
      count: Number(row?.count ?? 0),
      ...(oldest === null || oldest === undefined ? {} : { oldestAt: Number(oldest) }),
    };
  }

  async ingest(input: IngestInput | { content: string; projectId?: string; tags?: string[] }): Promise<Neuron> {
    await this.initialize();
    const normalizedInput: IngestInput = {
      ...(input as IngestInput),
      content: input.content ?? '',
    };
    if (this.sovereignty && this.sovereignty.recordingPaused(normalizedInput.projectId)) {
      throw new Error('recording_paused');
    }
    const projectId = normalizedInput.projectId;
    const event = this.recordRawEvent({
      projectId,
      threadId: (normalizedInput as IngestInput & { threadId?: string }).threadId
        ?? `ingest:${projectId ?? 'default'}`,
      sessionId: (normalizedInput as IngestInput & { sessionId?: string }).sessionId,
      role: 'user',
      content: normalizedInput.content,
      occurredAt: normalizedInput.createdAt,
      sourceId: normalizedInput.source,
      metadata: {
        ...(normalizedInput.tags ? { tags: normalizedInput.tags } : {}),
        ingestType: normalizedInput.type ?? 'chat',
        ingestSourceType: normalizedInput.sourceType ?? 'user_input',
      },
    });
    const sourceRefs = [
      ...(normalizedInput.sourceRefs ?? []),
      {
        eventId: event.eventId,
        eventType: 'message',
        sourceId: normalizedInput.source,
        contentHash: event.contentHash,
        threadId: event.threadId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        role: event.role,
      },
    ];
    return this.compileMemory({ ...normalizedInput, sourceRefs }, event.eventId);
  }

  searchAtlas(query: string, options: {
    projectId?: string;
    limit?: number;
    now?: number;
    localDateNow?: string;
    timeZone?: string;
  } = {}) {
    const now = options.now ?? Date.now();
    const timeZone = options.timeZone ?? this.projectClock.timeZone;
    const localDateNow = options.localDateNow ?? localDateFor(now, timeZone) ?? '';
    try {
      if (options.projectId) this.refreshAtlasForRecall(options.projectId);
      const planned = this.atlasPathRetriever.retrieve(query, {
        projectId: options.projectId ?? '',
        limit: options.limit,
        includeEvidence: true,
        evidenceLimit: 1000,
        staleOk: true,
        localDateNow,
        timeZone,
        now,
      });
      return { queryFrame: planned.queryFrame, atlas: planned.result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pipelineMetrics.recordNonFatal('memory_atlas_recall_degraded', {
        projectId: options.projectId,
        message,
        details: { component: 'atlas_path_retriever' },
      });
      return { atlasStatus: 'unavailable' as const, atlasErrorCode: 'atlas_recall_failed' as const };
    }
  }

  private refreshAtlasForRecall(projectId: string): void {
    const state = this.memoryAtlasStore.getProjectionState(projectId);
    if (!state || state.status === 'clean') return;
    if (state.lastRebuildAt !== undefined && Date.now() - state.lastRebuildAt < ATLAS_RECALL_REFRESH_MS) return;
    try {
      this.memoryAtlasIndexer.ensureFresh({ projectId, frameMode: 'repair' });
    } catch (error) {
      this.pipelineMetrics.recordNonFatal('memory_atlas_recall_refresh_failed', {
        projectId,
        message: error instanceof Error ? error.message : String(error),
        details: { component: 'memory_atlas_indexer' },
      });
    }
  }

  claimAgentTurn(input: AgentTurnIdentityInput): AgentTurnClaim {
    const userEventId = agentTurnEventId(input, 1);
    const assistantEventId = input.assistantText ? agentTurnEventId(input, 2) : undefined;
    const recordedUser = this.eventStore.getEvent(userEventId);
    if (!recordedUser) return { userEventId, assistantEventId, replay: false };
    this.assertAgentTurnIdentity(recordedUser, input, 1);
    const recordedAssistant = assistantEventId ? this.eventStore.getEvent(assistantEventId) : null;
    if (assistantEventId && !recordedAssistant) {
      // The retry carries a reply the first write did not: same turn id, different turn.
      throw new Error(`agent_turn_identity_conflict:${input.turnId}`);
    }
    if (recordedAssistant) this.assertAgentTurnIdentity(recordedAssistant, input, 2);
    return { userEventId, assistantEventId, replay: true };
  }

  private assertAgentTurnIdentity(event: MemoryEvent, input: AgentTurnIdentityInput, ordinal: 1 | 2): void {
    const raw = ordinal === 1 ? input.userText : input.assistantText ?? '';
    const expectedText = this.piiRedactor ? this.piiRedactor.redact(raw).text : raw;
    const payload = event.payload as { text?: unknown } | undefined;
    if (
      event.turnId !== input.turnId
      || event.sessionId !== input.sessionId
      || payload?.text !== expectedText
    ) {
      throw new Error(`agent_turn_identity_conflict:${input.turnId}`);
    }
  }

  recordRawEvent(input: RawMemoryEventInput): MemoryEvent<{ text: string; metadata?: Record<string, unknown> }> {
    // Pause is a write-path gate, not a read-time filter: a paused project appends no row to the
    // ledger, so there is nothing to filter or delete later (#163).
    if (this.sovereignty && this.sovereignty.recordingPaused(input.projectId)) {
      throw new Error('recording_paused');
    }
    const text = this.piiRedactor ? this.piiRedactor.redact(input.content).text : input.content;
    const occurredAt = input.occurredAt ?? Date.now();
    return this.eventStore.append({
      eventId: input.eventId,
      streamId: input.threadId,
      streamType: 'thread',
      eventType: 'RAW_EVENT_RECORDED',
      rawEventType: input.rawEventType ?? 'message',
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      actorId: input.role,
      sourceId: input.sourceId,
      contentHash: createHash('sha256').update(text).digest('hex'),
      threadId: input.threadId,
      sessionId: input.sessionId,
      localDate: input.localDate,
      localDateSource: input.localDateSource,
      timeZone: input.timeZone ?? input.projectTimeZone,
      projectTimeZone: this.projectClock.timeZone,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      eventOrdinal: input.eventOrdinal,
      role: input.role,
      parentEventId: input.parentEventId,
      prevEventId: input.prevEventId,
      causalityType: input.causalityType,
      sourceOffset: input.sourceOffset,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      charStart: input.charStart,
      charEnd: input.charEnd,
      occurredAt,
      orderingConfidence: input.orderingConfidence
        ?? (input.turnSeq !== undefined || input.eventOrdinal !== undefined || input.sourceOffset !== undefined || input.lineStart !== undefined ? 'high' : 'low'),
      payload: {
        text,
        // The secret mark is written where the ledger is appended (#142), so the host bridge, the MCP tool
        // and any direct kernel call all get it; the role decides which side's key it belongs to.
        metadata: {
          ...(input.metadata || {}),
          ...secretFindingsMetadata(text, input.role === 'assistant' ? 'secretFindingsAssistant' : 'secretFindings'),
          ...lifeSensitivityMetadata(text),
        },
      },
    });
  }

  recordToolCall(input: ToolCallMemoryEventInput): MemoryEvent<{
    text: string;
    toolCallId?: string;
    toolName: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }> {
    const text = input.content ?? `Tool call ${input.toolName}: ${stringifyToolPayload(input.input)}`;
    const event = this.recordRawEvent({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      role: 'assistant',
      rawEventType: 'tool_call',
      content: text,
      eventOrdinal: input.eventOrdinal,
      occurredAt: input.occurredAt,
      parentEventId: input.assistantEventId,
      prevEventId: input.assistantEventId,
      causalityType: input.assistantEventId ? 'triggered_by' : undefined,
      sourceId: input.sourceId,
      metadata: {
        ...input.metadata,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.input,
      },
    });
    if (input.assistantEventId) {
      this.eventStore.updateNextEventId(input.assistantEventId, event.eventId);
    }
    return {
      ...event,
      payload: {
        text: event.payload.text,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.input,
        metadata: event.payload.metadata,
      },
    };
  }

  recordToolResult(input: ToolResultMemoryEventInput): MemoryEvent<{
    text: string;
    toolCallId?: string;
    toolName: string;
    output: string;
    metadata?: Record<string, unknown>;
  }> {
    const event = this.recordRawEvent({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      role: 'tool',
      rawEventType: 'tool_result',
      content: input.output,
      eventOrdinal: input.eventOrdinal,
      occurredAt: input.occurredAt,
      parentEventId: input.toolCallEventId,
      prevEventId: input.toolCallEventId,
      causalityType: 'tool_result_for',
      sourceId: input.sourceId,
      metadata: {
        ...input.metadata,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
    });
    this.eventStore.updateNextEventId(input.toolCallEventId, event.eventId);
    return {
      ...event,
      payload: {
        text: event.payload.text,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: event.payload.text,
        metadata: event.payload.metadata,
      },
    };
  }

  recordTaskEvent(input: TaskMemoryEventInput): MemoryEvent<{ text: string; taskId?: string; title?: string; metadata?: Record<string, unknown> }> {
    const event = this.recordRawEvent({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      role: input.role ?? 'system',
      rawEventType: input.rawEventType ?? 'task_event',
      content: input.content,
      eventOrdinal: input.eventOrdinal,
      occurredAt: input.occurredAt,
      parentEventId: input.parentEventId,
      prevEventId: input.parentEventId,
      causalityType: input.parentEventId ? 'triggered_by' : undefined,
      sourceId: input.sourceId,
      metadata: {
        ...input.metadata,
        taskId: input.taskId,
        title: input.title,
      },
    });
    return {
      ...event,
      payload: {
        text: event.payload.text,
        taskId: input.taskId,
        title: input.title,
        metadata: event.payload.metadata,
      },
    };
  }

  getThreadEvents(
    threadId: string,
    options: { projectId?: string; sessionId?: string; localDate?: string; limit?: number } = {},
  ): MemoryEvent[] {
    return this.eventStore.getThreadEvents(threadId, options);
  }

  getEventContext(eventId: string, options: { before?: number; after?: number } = {}): MemoryEventContext | null {
    return this.eventStore.getEventContext(eventId, options);
  }

  searchRawEvents(query: string, options: RawEventSearchOptions = {}): MemoryEvent[] {
    return this.eventStore.searchRawEvents(query, options);
  }

  /** Capped per-term document count, for recall's discriminator check. */
  countRawEventMatches(token: string, options: { projectId?: string; workspaceId?: string; threadId?: string; cap?: number } = {}): number {
    return this.eventStore.countRawEventMatches(token, options);
  }

  /**
   * Whether recall can use a semantic index at all.
   *
   * `memory` defaults to `rule_only`, and in that mode the curator marks every event
   * `shouldEmbed: false` and stores it `raw_ledger_only` — nothing is vectorised, so recall
   * is lexical. Callers say so in the result rather than leaving a reader to infer it from
   * answer quality (measured: 8 of 12 paraphrased questions at rank 1 with `rule_only`,
   * and the misses are the ones whose words are not in the fact).
   */
  semanticIndexEnabled(): boolean {
    return this.embeddingProvider !== undefined
      && typeof (this.embeddingProvider as { embedSync?: unknown }).embedSync === 'function';
  }

  getDreamBacklogStatus(projectId?: string): DreamBacklogStatus {
    return this.dreamLedgerStore.getStatus(projectId);
  }

  markDreamed(projectId: string | undefined, globalSeq: number, dreamedAt?: number): DreamBacklogStatus {
    return this.dreamLedgerStore.markDreamed(projectId, globalSeq, dreamedAt);
  }

  async runDreamCurator(options: DreamCuratorRunOptions = {}): Promise<DreamCuratorRunResult> {
    return this.dreamCuratorWorker.run(options);
  }

  /**
   * One Night: seal what has gone quiet, Dream a bounded number of the sealed
   * episodes, and project exactly those into the atlas.
   *
   * The order matters. Sealing is what makes an episode Dreamable; Dream writes
   * frames and beliefs and marks the projection dirty; projecting the episodes it
   * actually processed is what puts yesterday's conversation in front of today's
   * recall without a corpus-wide rebuild. Running it again with nothing new
   * seals nothing, dreams nothing and projects nothing.
   */
  async runNight(options: { projectId?: string; maxEpisodes?: number; now?: number } = {}): Promise<{
    tick: MaintenanceTickResult;
    dream: DreamTickResult;
    projected: { episodes: number; atlasDocuments: number };
    reconciled: { refreshed: boolean; documents: number };
    snapshot?: BrainManifest;
  }> {
    // No atlas pass inside the tick: this run reconciles once, at the end, over the
    // frames Dream is about to write. See MaintenanceTickOptions.atlasRefresh.
    const tick = this.runMaintenanceTick({ projectId: options.projectId, now: options.now, atlasRefresh: false });
    // The tick seals what has gone quiet as a *soft* seal, which the scheduler
    // only promotes after a grace period meant to let a conversation resume.
    // A batch that runs once a night has already waited the idle gap the seal
    // was based on, so the grace is redundant here and the night's conversations
    // are dreamable in the same run.
    this.episodeStore.finalizeMatureSoftSeals({
      projectId: options.projectId,
      sealedBefore: options.now ?? Date.now(),
      now: options.now,
    });
    const dream = await this.runDreamTick({ projectId: options.projectId, maxEpisodes: options.maxEpisodes ?? 50, now: options.now });
    const episodeIds = options.projectId === undefined ? [] : (dream.episodeIds ?? []);
    const projected = episodeIds.length
      ? this.memoryAtlasIndexer.projectEpisodes(options.projectId!, episodeIds)
      : { episodeCount: 0, facetNodeCount: 0, facetEdgeCount: 0, reviewNeeded: 0 };
    if (projected.episodeCount > 0) this.memoryAtlasStore.aggregateFacetNodeSupport(options.projectId!);
    // The incremental pass covers the canonical layer only; the frame and action
    // layers Dream just wrote are still owed. Finishing the run with the
    // reconciliation pass is what clears the dirty flag, so the next night's tick
    // does not pay a corpus rebuild for work this run already knew about.
    // The frame half is bounded: only the frames the double-stamp scan calls stale
    // (plus the ones Dream just wrote and the projection lacks) are re-projected,
    // not the project's whole frame layer (#110).
    const reconciled = options.projectId !== undefined
      ? this.memoryAtlasIndexer.ensureFresh({ projectId: options.projectId, frameMode: 'repair' })
      : this.memoryAtlasIndexer.ensureAllFresh({ frameMode: 'repair' });
    // The nightly copy is taken after the Dream and the atlas reconcile, so the snapshot is the
    // brain the night produced rather than the one it started with. A failure fails the Night: the
    // Dream rows are already committed and a re-run is idempotent.
    const snapshot = await this.backup.snapshot();
    return {
      tick,
      dream,
      projected: { episodes: projected.episodeCount, atlasDocuments: this.memoryAtlasStore.countDocuments(options.projectId) },
      reconciled: { refreshed: reconciled.refreshed, documents: reconciled.documents },
      ...(snapshot ? { snapshot } : {}),
    };
  }

  async runDreamTick(options: DreamTickOptions = {}): Promise<DreamTickResult> {
    const result = await this.dreamScheduler.tick(options);
    // The compile-done producer for the Dream pass. A skipped tick still emitted one: "the pass
    // finished and had nothing to do" is exactly what a waiter must be able to distinguish from
    // "the pass never ran".
    this.events.emit({
      type: 'compile-done',
      at: Date.now(),
      projectId: options.projectId,
      payload: {
        kind: 'dream',
        runId: result.runId,
        selectedMode: result.selectedMode,
        skipped: result.skipped,
        processedEpisodeCount: result.processedEpisodeCount,
        candidateCount: result.candidateCount,
      },
    });
    return result;
  }

  /**
   * The time context block a shell hands the agent at wake or turn start (F2 of #156).
   *
   * Computed from the ledger at an injected instant — the agent never queries it, and nothing here
   * reads `Date.now()` when `now` is given. Field meanings and the frozen field list are in
   * `docs/time-awareness.md`.
   */
  temporalContext(input: {
    projectId: string;
    now?: number;
    densityWindowMs?: number;
    rhythmSampleDays?: number;
    rhythmActiveHourThreshold?: number;
  }): TemporalContext {
    const projectId = requireProjectId(input.projectId);
    const now = input.now ?? Date.now();
    const rhythmSampleDays = Math.max(1, Math.trunc(input.rhythmSampleDays ?? DEFAULT_RHYTHM_SAMPLE_DAYS));
    const from = now - rhythmSampleDays * 24 * 60 * 60_000;
    const lastInteractionAt = this.eventStore.getLatestRawEventOccurrence({ projectId, atOrBefore: now })?.occurredAt ?? null;
    const lastUserTurnAt = this.eventStore.getLatestRawEventOccurrence({ projectId, atOrBefore: now, role: 'user' })?.occurredAt ?? null;
    // ponytail: 5000 turns is the density/rhythm sample cap; beyond it the count saturates and the
    // label is still `busy`. Aggregate in SQL if a project ever measures against the cap.
    const occurrences = this.eventStore.listRawEventOccurrences({ projectId, from, to: now, limit: 5_000 });
    const anchors: TemporalAnchor[] = [];
    for (const intention of this.wakeIntentions.list({ projectId, statuses: ['pending'] })) {
      anchors.push({ kind: 'wake-intention', at: intention.at, label: intention.reason });
    }
    for (const memory of this.prospectiveMemoryService.list({ projectId, statuses: ['confirmed', 'deferred'] })) {
      const at = memory.status === 'deferred' ? memory.deferredUntil : memory.dueAt;
      if (at !== undefined) anchors.push({ kind: 'prospective-memory', at, label: memory.title });
    }
    return computeTemporalContext({
      now,
      timeZone: this.projectClock.timeZone,
      lastInteractionAt,
      lastUserTurnAt,
      occurrences,
      anchors,
      densityWindowMs: input.densityWindowMs,
      rhythmSampleDays,
      rhythmActiveHourThreshold: input.rhythmActiveHourThreshold,
    });
  }

  /**
   * Move the kernel's clock: fire due wake intentions, announce due prospective memories as
   * `prospective-due` events, and report the dream window and the next wake instant.
   *
   * Idempotent by construction: the second call at the same `now` fires nothing, because the fired
   * rows are in the ledger. No timer, no sleeping — the caller owns the clock.
   */
  runWakeTick(input: WakeTickInput): WakeTickResult {
    const projectId = requireProjectId(input.projectId);
    return this.wakeScheduler.tick({ ...input, projectId, timeZone: input.timeZone ?? this.projectClock.timeZone });
  }

  /** The instant the base timer should next wake for, or `null` when nothing is waiting. */
  nextWakeAt(input: { projectId: string; agentId?: string; now?: number }): number | null {
    return this.wakeScheduler.nextWakeAt({
      projectId: requireProjectId(input.projectId),
      agentId: input.agentId,
      now: input.now ?? Date.now(),
    });
  }

  /** Whether the shell's dream window is open at `now`, and when it next opens. */
  dreamWindowAt(input: { now?: number; window: DreamWindow; timeZone?: string }): DreamWindowEvaluation {
    return evaluateDreamWindowAt({
      now: input.now ?? Date.now(),
      timeZone: input.timeZone ?? this.projectClock.timeZone,
      window: input.window,
    });
  }

  assembleEpisodeTurn(
    events: MemoryEvent[],
    input: {
      projectId: string; sessionId: string; sourceAgent?: string; conversationThreadId?: string;
      now?: number; batchSeal?: boolean; forceBatchSeal?: boolean; allowNonUserEpisodeStart?: boolean;
    },
  ) {
    return this.episodeAssembler.appendTurn(events, input);
  }

  assembleEpisodeTurnAsync(
    events: MemoryEvent[],
    input: {
      projectId: string; sessionId: string; sourceAgent?: string; conversationThreadId?: string;
      now?: number; batchSeal?: boolean; forceBatchSeal?: boolean; allowNonUserEpisodeStart?: boolean;
    },
  ) {
    return this.episodeAssembler.appendTurnAsync(events, input);
  }

  appendRawEventToEpisode(
    event: MemoryEvent,
    input: { projectId: string; sessionId: string; sourceAgent?: string; now?: number },
  ) {
    return this.episodeAssembler.appendEvent(event, input);
  }

  appendEpisodeMessage(input: EpisodeMessageInput): EpisodeMessageResult {
    let reservedEventId: string | undefined;
    if (input.externalMessageId) {
      const proposedEventId = `evt-episode-${createHash('sha256')
        .update(JSON.stringify([input.projectId, input.sourceAgent, input.sessionId, input.externalMessageId]))
        .digest('hex')}`;
      this.episodeStore.recordIngestKey({
        projectId: input.projectId,
        sourceAgent: input.sourceAgent,
        sourceSessionId: input.sessionId,
        externalMessageId: input.externalMessageId,
        eventId: proposedEventId,
        now: input.timestamp,
      });
      reservedEventId = this.episodeStore.getIngestedEvent(
        input.projectId,
        input.sourceAgent,
        input.sessionId,
        input.externalMessageId,
      );
      const existingEvent = reservedEventId ? this.eventStore.getEvent(reservedEventId) : null;
      if (existingEvent) {
        this.assertEpisodeIngestIdentity(existingEvent, input);
        return this.finishIngestMessage(existingEvent, input, false, () => this.resumeEpisodeMessage(existingEvent, input, false));
      }
    }
    let event: MemoryEvent<{ text: string; metadata?: Record<string, unknown> }>;
    try {
      event = this.recordRawEvent({
        eventId: reservedEventId,
        projectId: input.projectId,
        workspaceId: input.projectId,
        threadId: input.threadId || input.sessionId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        turnSeq: input.turnSeq,
        localDate: input.localDate,
        eventOrdinal: input.eventOrdinal,
        role: input.role,
        content: input.text,
        occurredAt: input.timestamp,
        sourceId: `${input.sourceAgent}:${input.sessionId}`,
        metadata: { ...input.metadata, externalMessageId: input.externalMessageId, sourceAgent: input.sourceAgent },
      });
    } catch (error) {
      const concurrent = reservedEventId ? this.eventStore.getEvent(reservedEventId) : null;
      if (!concurrent) {
        if (input.externalMessageId) this.episodeStore.markIngestState({
          projectId: input.projectId, sourceAgent: input.sourceAgent, sourceSessionId: input.sessionId,
          externalMessageId: input.externalMessageId, state: 'failed', error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.assertEpisodeIngestIdentity(concurrent, input);
      return this.finishIngestMessage(concurrent, input, false, () => this.resumeEpisodeMessage(concurrent, input, false));
    }
    return this.finishIngestMessage(event, input, true, () => this.resumeEpisodeMessage(event, input, true));
  }

  async appendEpisodeMessageAsync(input: EpisodeMessageInput): Promise<EpisodeMessageResult> {
    let reservedEventId: string | undefined;
    if (input.externalMessageId) {
      const proposedEventId = `evt-episode-${createHash('sha256')
        .update(JSON.stringify([input.projectId, input.sourceAgent, input.sessionId, input.externalMessageId]))
        .digest('hex')}`;
      this.episodeStore.recordIngestKey({
        projectId: input.projectId, sourceAgent: input.sourceAgent, sourceSessionId: input.sessionId,
        externalMessageId: input.externalMessageId, eventId: proposedEventId, now: input.timestamp,
      });
      reservedEventId = this.episodeStore.getIngestedEvent(
        input.projectId, input.sourceAgent, input.sessionId, input.externalMessageId,
      );
      const existingEvent = reservedEventId ? this.eventStore.getEvent(reservedEventId) : null;
      if (existingEvent) {
        this.assertEpisodeIngestIdentity(existingEvent, input);
        return this.finishIngestMessageAsync(existingEvent, input, false, () => this.resumeEpisodeMessageAsync(existingEvent, input, false));
      }
    }
    let event: MemoryEvent<{ text: string; metadata?: Record<string, unknown> }>;
    try {
      event = this.recordRawEvent({
        eventId: reservedEventId, projectId: input.projectId, workspaceId: input.projectId,
        threadId: input.threadId || input.sessionId, sessionId: input.sessionId, role: input.role,
        turnId: input.turnId, turnSeq: input.turnSeq, localDate: input.localDate, eventOrdinal: input.eventOrdinal,
        content: input.text, occurredAt: input.timestamp, sourceId: `${input.sourceAgent}:${input.sessionId}`,
        metadata: { ...input.metadata, externalMessageId: input.externalMessageId, sourceAgent: input.sourceAgent },
      });
    } catch (error) {
      const concurrent = reservedEventId ? this.eventStore.getEvent(reservedEventId) : null;
      if (!concurrent) {
        if (input.externalMessageId) this.episodeStore.markIngestState({
          projectId: input.projectId, sourceAgent: input.sourceAgent, sourceSessionId: input.sessionId,
          externalMessageId: input.externalMessageId, state: 'failed', error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.assertEpisodeIngestIdentity(concurrent, input);
      return this.finishIngestMessageAsync(concurrent, input, false, () => this.resumeEpisodeMessageAsync(concurrent, input, false));
    }
    return this.finishIngestMessageAsync(event, input, true, () => this.resumeEpisodeMessageAsync(event, input, true));
  }

  private finishIngestMessage(event: MemoryEvent, input: EpisodeMessageInput, created: boolean, operation: () => EpisodeMessageResult): EpisodeMessageResult {
    try {
      const result = operation();
      if (input.externalMessageId) this.episodeStore.markIngestState({
        projectId: input.projectId, sourceAgent: input.sourceAgent, sourceSessionId: input.sessionId,
        externalMessageId: input.externalMessageId, state: 'committed', now: event.occurredAt,
      });
      return result;
    } catch (error) {
      if (input.externalMessageId) this.episodeStore.markIngestState({
        projectId: input.projectId, sourceAgent: input.sourceAgent, sourceSessionId: input.sessionId,
        externalMessageId: input.externalMessageId, state: 'failed', error: error instanceof Error ? error.message : String(error), now: event.occurredAt,
      });
      throw error;
    }
  }

  private async finishIngestMessageAsync(event: MemoryEvent, input: EpisodeMessageInput, created: boolean, operation: () => Promise<EpisodeMessageResult>): Promise<EpisodeMessageResult> {
    try {
      const result = await operation();
      if (input.externalMessageId) this.episodeStore.markIngestState({
        projectId: input.projectId, sourceAgent: input.sourceAgent, sourceSessionId: input.sessionId,
        externalMessageId: input.externalMessageId, state: 'committed', now: event.occurredAt,
      });
      return result;
    } catch (error) {
      if (input.externalMessageId) this.episodeStore.markIngestState({
        projectId: input.projectId, sourceAgent: input.sourceAgent, sourceSessionId: input.sessionId,
        externalMessageId: input.externalMessageId, state: 'failed', error: error instanceof Error ? error.message : String(error), now: event.occurredAt,
      });
      throw error;
    }
  }

  private resumeEpisodeMessage(event: MemoryEvent, input: EpisodeMessageInput, created: boolean): EpisodeMessageResult {
    let link = this.episodeStore.getEventLink(event.eventId);
    let ignored = this.episodeStore.hasEventDisposition(event.eventId);
    let assembly: ReturnType<MemoryKernel['assembleEpisodeTurn']> | undefined;
    if (!link && !ignored) {
      assembly = this.assembleEpisodeTurn([event], {
        projectId: input.projectId,
        sessionId: event.sessionId || input.sessionId,
        sourceAgent: input.sourceAgent,
        conversationThreadId: input.threadId || event.threadId || input.sessionId,
        now: event.occurredAt,
      });
      link = this.episodeStore.getEventLink(event.eventId);
      ignored = assembly.ignoredEventIds.includes(event.eventId);
    }
    const episode = link ? this.episodeStore.getEpisode(link.episodeId) : undefined;
    const receipt = episode?.status === 'sealed'
      ? this.episodeStore.listClosureReceipts({ episodeId: episode.episodeId, limit: 1 })[0]
      : undefined;
    return {
      created,
      eventId: event.eventId,
      episodeId: episode?.episodeId,
      assigned: Boolean(link),
      ignored,
      sealed: episode?.status === 'sealed',
      dreamRecommended: Boolean(receipt?.dreamRecommended && !receipt.requiresReview && episode?.dreamStatus !== 'processed'),
      dreamRan: false,
      boundaryTriggered: assembly?.boundaryTriggered,
      boundaryDetected: assembly?.boundaryDetected,
      boundaryApplied: assembly?.boundaryApplied,
      boundaryMode: assembly?.boundaryMode,
      boundaryDecisionId: assembly?.boundaryDecisionId,
      boundaryGuardCodes: assembly?.boundaryGuardCodes,
      boundaryAuditRecorded: assembly?.boundaryAuditRecorded,
      boundaryAuditStatus: assembly?.boundaryAuditStatus,
      previousEpisodeId: assembly?.previousEpisodeId,
      reviewerRawResultStatus: assembly?.reviewerRawResultStatus,
      warnings: assembly?.warnings,
    };
  }

  private async resumeEpisodeMessageAsync(event: MemoryEvent, input: EpisodeMessageInput, created: boolean): Promise<EpisodeMessageResult> {
    let link = this.episodeStore.getEventLink(event.eventId);
    let ignored = this.episodeStore.hasEventDisposition(event.eventId);
    let assembly: Awaited<ReturnType<MemoryKernel['assembleEpisodeTurnAsync']>> | undefined;
    if (!link && !ignored) {
      assembly = await this.assembleEpisodeTurnAsync([event], {
        projectId: input.projectId, sessionId: event.sessionId || input.sessionId, sourceAgent: input.sourceAgent,
        conversationThreadId: input.threadId || event.threadId || input.sessionId, now: event.occurredAt,
      });
      link = this.episodeStore.getEventLink(event.eventId);
      ignored = assembly.ignoredEventIds.includes(event.eventId);
    }
    const episode = link ? this.episodeStore.getEpisode(link.episodeId) : undefined;
    const receipt = episode?.status === 'sealed'
      ? this.episodeStore.listClosureReceipts({ episodeId: episode.episodeId, limit: 1 })[0]
      : undefined;
    return {
      created, eventId: event.eventId, episodeId: episode?.episodeId, assigned: Boolean(link), ignored,
      sealed: episode?.status === 'sealed',
      dreamRecommended: Boolean(receipt?.dreamRecommended && !receipt.requiresReview && episode?.dreamStatus !== 'processed'),
      dreamRan: false,
      boundaryTriggered: assembly?.boundaryTriggered,
      boundaryDetected: assembly?.boundaryDetected,
      boundaryApplied: assembly?.boundaryApplied,
      boundaryMode: assembly?.boundaryMode,
      boundaryDecisionId: assembly?.boundaryDecisionId,
      boundaryGuardCodes: assembly?.boundaryGuardCodes,
      boundaryAuditRecorded: assembly?.boundaryAuditRecorded,
      boundaryAuditStatus: assembly?.boundaryAuditStatus,
      previousEpisodeId: assembly?.previousEpisodeId,
      reviewerRawResultStatus: assembly?.reviewerRawResultStatus,
      warnings: assembly?.warnings,
    };
  }

  private assertEpisodeIngestIdentity(event: MemoryEvent, input: EpisodeMessageInput): void {
    const payload = event.payload as { text?: unknown; metadata?: { sourceAgent?: unknown; imported?: unknown; sourceRef?: unknown } } | undefined;
    const expectedText = this.piiRedactor ? this.piiRedactor.redact(input.text).text : input.text;
    if (
      event.projectId !== input.projectId
      || event.sessionId !== input.sessionId
      || event.threadId !== (input.threadId || input.sessionId)
      || event.role !== input.role
      || !sameProvided(event.turnId, input.turnId)
      || !sameProvided(event.turnSeq, input.turnSeq)
      || !sameProvided(event.localDate, input.localDate)
      || !sameProvided(event.eventOrdinal, input.eventOrdinal)
      || (input.timestamp !== undefined && event.occurredAt !== input.timestamp)
      || (input.metadata?.imported !== undefined && payload?.metadata?.imported !== input.metadata.imported)
      || (input.metadata?.sourceRef !== undefined && JSON.stringify(payload?.metadata?.sourceRef) !== JSON.stringify(input.metadata.sourceRef))
      || payload?.text !== expectedText
      || payload?.metadata?.sourceAgent !== input.sourceAgent
    ) {
      throw new Error(`episode_ingest_identity_conflict:${input.externalMessageId || event.eventId}`);
    }
  }

  listEpisodes(options: EpisodeListOptions = {}): MemoryEpisode[] {
    return this.episodeStore.listEpisodes(options);
  }

  getEpisode(episodeId: string): MemoryEpisode | undefined {
    return this.episodeStore.getEpisode(episodeId);
  }

  sealEpisode(episodeId: string, input: { mode: EpisodeClosureMode; reason: string; now?: number }): EpisodeClosureReceipt {
    return this.episodeStore.sealEpisode(episodeId, input);
  }

  sealImportedEpisode(episodeId: string, input: { reason: string; force?: boolean; now?: number }): EpisodeClosureReceipt {
    const links = this.episodeStore.listEventLinks(episodeId);
    if (!links.length) throw new Error(`episode_empty:${episodeId}`);
    const averageConfidence = links.length
      ? links.reduce((total, link) => total + link.confidence, 0) / links.length
      : 0;
    const requiresReview = input.force !== true && averageConfidence < 0.6;
    return this.episodeStore.sealEpisode(episodeId, {
      mode: requiresReview ? 'soft' : 'batch',
      reason: requiresReview ? 'batch_low_confidence_review' : input.reason,
      reasonCode: 'batch_boundary',
      requiresReview,
      now: input.now,
    });
  }

  sealIdleEpisodes(input: { projectId?: string; idleBefore: number; now?: number }): EpisodeClosureReceipt[] {
    return this.episodeStore.sealIdleEpisodes(input);
  }

  listEpisodeClosureReceipts(options: { episodeId?: string; projectId?: string; limit?: number } = {}): EpisodeClosureReceipt[] {
    return this.episodeStore.listClosureReceipts(options);
  }

  listEpisodeEventLinks(episodeId: string) {
    return this.episodeStore.listEventLinks(episodeId);
  }

  auditEpisodeBoundaries(options: {
    projectId: string; episodeId?: string; status?: MemoryEpisode['status']; limit?: number; cursor?: string;
    maxEvents?: number; maxDurationMs?: number; maxIdleGapMs?: number; timezone?: string;
  }): EpisodeBoundaryAuditResult {
    return this.episodeBoundaryAuditService.audit(options);
  }

  listEpisodeBoundaryDecisions(options: { projectId: string; primaryEventId?: string; limit?: number }): EpisodeBoundaryDecisionRecord[] {
    if (!options.projectId) throw new Error('projectId is required');
    return this.episodeStore.listBoundaryDecisions(options);
  }

  planEpisodeSplit(options: {
    projectId: string; episodeId: string; maxEvents?: number; maxDurationMs?: number; maxIdleGapMs?: number;
    timezone?: string; includeEventIds?: boolean;
  }): EpisodeSplitPlan {
    return this.episodeSplitPlanner.plan(options);
  }

  getEpisodeDreamStatus(projectId?: string): EpisodeDreamStatus {
    return this.episodeStore.getDreamStatus(projectId);
  }

  retryFailedEpisodeDreams(projectId?: string): number {
    return this.episodeStore.retryFailed(projectId);
  }

  repairEpisodes(options: { projectId?: string; sinceGlobalSeq?: number; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 500), 5000));
    let afterGlobalSeq = options.sinceGlobalSeq === undefined ? undefined : options.sinceGlobalSeq - 1;
    const events: MemoryEvent[] = [];
    while (events.length < limit) {
      const page = this.eventStore.listRawEventsAfterGlobalSeq({ projectId: options.projectId, afterGlobalSeq, limit: Math.min(500, limit - events.length) });
      if (!page.length) break;
      events.push(...page);
      afterGlobalSeq = page.at(-1)?.globalSeq ?? afterGlobalSeq;
      if (page.length < Math.min(500, limit - events.length + page.length)) break;
    }
    const eligibleEvents = events
      .filter((event) => !this.episodeStore.getEventLink(event.eventId))
      .filter((event) => !this.episodeStore.hasEventDisposition(event.eventId));
    let assigned = 0;
    const unassignedEventIds: string[] = [];
    for (const event of eligibleEvents) {
      const projectId = event.projectId || options.projectId;
      const sessionId = event.sessionId || event.threadId;
      if (!projectId || !sessionId) { unassignedEventIds.push(event.eventId); continue; }
      try {
        const metadata = (event.payload as { metadata?: { sourceAgent?: unknown } } | undefined)?.metadata;
        const sourceAgent = typeof metadata?.sourceAgent === 'string' ? metadata.sourceAgent : undefined;
        const result = this.assembleEpisodeTurn([event], {
          projectId, sessionId, sourceAgent, now: event.occurredAt,
        });
        if (result.assignedEventIds.includes(event.eventId)) assigned += 1;
        else unassignedEventIds.push(event.eventId);
      } catch (error) {
        unassignedEventIds.push(event.eventId);
        this.pipelineMetrics.recordNonFatal('episode_repair_failed', {
          projectId, message: error instanceof Error ? error.message : String(error), details: { eventId: event.eventId },
        });
      }
    }
    return { scanned: eligibleEvents.length, assigned, unassigned: unassignedEventIds.length, unassignedEventIds, nextGlobalSeq: afterGlobalSeq, hasMore: events.length >= limit };
  }

  repairEpisode(input: EpisodeRepairInput): EpisodeRepairResult {
    validateEpisodeRepairInput(
      input,
      this.episodeStore,
      (eventId) => this.eventStore.getEvent(eventId) ?? undefined,
      // The same resolved vocabulary the CLI guard reads: a caller reaching the kernel
      // directly may only name an episode type the project declared (#209).
      this.taxonomy.episodeTypes,
    );
    return this.episodeStore.transaction(() => this.repairEpisodeInTransaction(input));
  }

  private repairEpisodeInTransaction(input: EpisodeRepairInput): EpisodeRepairResult {
    const now = input.now ?? Date.now();
    const affected = new Set<string>();
    const before: Record<string, unknown> = {};
    const previousStatuses = new Map<string, MemoryEpisode['status']>();
    let requeuedDream = input.operation === 'requeue-dream' || input.operation === 'invalidate-dream-run';
    if (input.operation === 'move-event') {
      const link = this.episodeStore.getEventLink(input.eventId);
      const source = link ? this.episodeStore.getEpisode(link.episodeId) : undefined;
      const target = this.episodeStore.getEpisode(input.targetEpisodeId);
      if (!source || !target || source.projectId !== input.projectId || target.projectId !== input.projectId) {
        throw new Error('episode_project_mismatch');
      }
      before[source.episodeId] = source;
      before[target.episodeId] = target;
      previousStatuses.set(source.episodeId, source.status);
      previousStatuses.set(target.episodeId, target.status);
    }
    if ('episodeId' in input) {
      const episode = this.episodeStore.getEpisode(input.episodeId);
      if (!episode || episode.projectId !== input.projectId) throw new Error(`episode_project_mismatch:${input.episodeId}`);
      before[input.episodeId] = episode;
      previousStatuses.set(input.episodeId, episode.status);
    }
    if ('sourceEpisodeId' in input) {
      const source = this.episodeStore.getEpisode(input.sourceEpisodeId);
      const target = this.episodeStore.getEpisode(input.targetEpisodeId);
      if (!source || !target || source.projectId !== input.projectId || target.projectId !== input.projectId) throw new Error('episode_project_mismatch');
      before[input.sourceEpisodeId] = source;
      before[input.targetEpisodeId] = target;
      previousStatuses.set(input.sourceEpisodeId, source.status);
      previousStatuses.set(input.targetEpisodeId, target.status);
    }

    if (input.operation === 'move-event') {
      const moved = this.episodeStore.moveEventForRepair(input.eventId, input.targetEpisodeId, now);
      affected.add(moved.sourceEpisodeId); affected.add(moved.targetEpisodeId);
    } else if (input.operation === 'reclassify') {
      this.episodeStore.reclassifyForRepair(input.episodeId, input);
      affected.add(input.episodeId);
    } else if (input.operation === 'requeue-dream' || input.operation === 'invalidate-dream-run') {
      this.episodeStore.requeueDreamForRepair(input.episodeId, input.mode || 'normal', now);
      affected.add(input.episodeId);
    } else if (input.operation === 'split') {
      const source = this.episodeStore.getEpisode(input.episodeId)!;
      if (source.status !== 'sealed') throw new Error('episode_split_requires_sealed_source');
      const sourceLinks = this.episodeStore.listEventLinks(input.episodeId);
      const selected = sourceLinks.filter((link) => input.eventIds.includes(link.eventId));
      if (!selected.length || selected.length === sourceLinks.length) throw new Error('episode_split_requires_proper_subset');
      const firstEvent = this.eventStore.getEvent(selected[0].eventId);
      if (!firstEvent) throw new Error(`event_not_found:${selected[0].eventId}`);
      const created = this.episodeStore.createEpisode({
        projectId: source.projectId, sessionId: source.sessionId, sourceAgent: source.sourceAgent,
        conversationThreadId: source.conversationThreadId, topicPath: source.topicPath, episodeType: source.episodeType,
        importance: source.importance, eventId: firstEvent.eventId, globalSeq: firstEvent.globalSeq,
        occurredAt: firstEvent.occurredAt, episodeTags: source.episodeTags,
        candidateTypes: source.candidateTypes, importanceSignals: source.importanceSignals, importanceReason: 'repair_split',
        linkedEpisodeId: source.episodeId,
      });
      previousStatuses.set(created.episodeId, source.status);
      for (const link of selected) this.episodeStore.moveEventForRepair(link.eventId, created.episodeId, now);
      this.episodeStore.addCrossReference({ projectId: source.projectId, episodeId: created.episodeId,
        referencedEpisodeId: source.episodeId, relation: 'SPLIT_FROM', createdBy: 'repair', now });
      affected.add(source.episodeId); affected.add(created.episodeId);
    } else if (input.operation === 'merge') {
      for (const link of this.episodeStore.listEventLinks(input.sourceEpisodeId)) {
        this.episodeStore.moveEventForRepair(link.eventId, input.targetEpisodeId, now);
      }
      this.episodeStore.addCrossReference({ projectId: input.projectId, episodeId: input.targetEpisodeId,
        referencedEpisodeId: input.sourceEpisodeId, relation: 'MERGED_FROM', createdBy: 'repair', now });
      affected.add(input.sourceEpisodeId); affected.add(input.targetEpisodeId);
    }

    if (['move-event', 'split', 'merge', 'reclassify'].includes(input.operation)) {
      this.memoryFrameStore.supersedeEpisodes([...affected], now);
      for (const episodeId of affected) {
        const episode = this.episodeStore.getEpisode(episodeId);
        if (!episode) continue;
        const previousStatus = previousStatuses.get(episodeId) || 'open';
        if (episode.eventCount === 0) {
          this.episodeStore.sealEpisode(episodeId, {
            mode: 'soft', reason: 'episode_repair_recomputed_empty', reasonCode: 'repair', requiresReview: true, now,
          });
        } else if (previousStatus === 'sealed') {
          this.episodeStore.sealEpisode(episodeId, {
            mode: 'manual', reason: 'episode_repair_recomputed', reasonCode: 'repair', now,
          });
        } else if (previousStatus === 'soft_sealed') {
          this.episodeStore.sealEpisode(episodeId, {
            mode: 'soft', reason: 'episode_repair_recomputed', reasonCode: 'repair', requiresReview: true, now,
          });
        }
      }
    }

    const staleCandidateIds: string[] = [];
    let candidateCursor: { createdAt: number; candidateId: string } | undefined;
    while (true) {
      const page = this.deepWriteCandidateStore.listCandidates({ projectId: input.projectId, limit: 500, after: candidateCursor });
      if (!page.length) break;
      for (const candidate of page) {
        const content = candidate.content && typeof candidate.content === 'object' ? candidate.content as Record<string, unknown> : {};
        const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
        const evidenceIds = evidence.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).eventId === 'string'
          ? [String((item as Record<string, unknown>).eventId)] : typeof item === 'string' ? [item] : []);
        const runSourceEpisode = typeof content.sourceEpisodeId === 'string' ? content.sourceEpisodeId : undefined;
        if (candidate.status !== 'superseded' && (
          (runSourceEpisode && affected.has(runSourceEpisode))
          || evidenceIds.some((eventId) => affected.has(this.episodeStore.getEventLink(eventId)?.episodeId || ''))
        )) {
          this.deepWriteCandidateStore.updateCandidateStatus(candidate.candidateId, 'superseded', {
            reason: 'episode_repair_invalidated_source',
          });
          this.invalidatePromotedCandidate(candidate, now);
          staleCandidateIds.push(candidate.candidateId);
        }
      }
      const last = page.at(-1)!;
      candidateCursor = { createdAt: last.createdAt, candidateId: last.candidateId };
      if (page.length < 500) break;
    }
    for (const episodeId of affected) {
      const episode = this.episodeStore.getEpisode(episodeId);
      if (episode?.eventCount && episode.status === 'sealed'
        && input.operation !== 'requeue-dream'
        && input.operation !== 'invalidate-dream-run') {
        this.episodeStore.requeueDreamForRepair(episodeId, 'normal', now);
        requeuedDream = true;
      }
    }
    const after = Object.fromEntries([...affected].map((episodeId) => [episodeId, this.episodeStore.getEpisode(episodeId)]));
    const repairId = this.episodeStore.recordRepairAudit({ projectId: input.projectId, operation: input.operation, payload: input, before, after, now });
    const affectedEpisodeIds = [...affected];
    const nextCommands = affectedEpisodeIds.length
      ? affectedEpisodeIds.map((episodeId) => `cogmem memory graph-reindex --project ${shellQuote(input.projectId)} --episode ${shellQuote(episodeId)} --json`)
      : [];
    return {
      repairId,
      applied: true,
      operation: input.operation,
      affectedEpisodeIds,
      changedFields: changedFieldsForRepair(input),
      staleCandidateIds,
      requeuedDream,
      graphRefreshNeeded: affectedEpisodeIds.length > 0,
      nextCommands: [
        ...nextCommands,
        `cogmem memory graph-explore --project ${shellQuote(input.projectId)} --query '<query>' --json`,
      ],
      note: 'repairId is an audit id, not a dream candidate id; do not run governance just because repairId exists.',
    };
  }

  private invalidatePromotedCandidate(candidate: DreamCandidateRecord, now: number): void {
    if (candidate.status !== 'promoted' || !candidate.promotionTargetId) return;
    const db = this.factStore.getDatabase();
    const targetId = candidate.promotionTargetId;
    if (candidate.promotionTargetType === 'fact') {
      this.factStore.updateFactStatus(targetId, 'superseded', undefined, { repairInvalidatedAt: now, sourceCandidateId: candidate.candidateId });
    } else if (candidate.promotionTargetType === 'belief') {
      db.prepare(`UPDATE beliefs SET status = 'suspect', updated_at = ? WHERE id = ?`).run(now, targetId);
    } else if (candidate.promotionTargetType === 'summary') {
      this.summaryStore.markSuperseded(targetId);
    } else if (candidate.promotionTargetType === 'entity') {
      const support = db.prepare(`
        SELECT (
          (SELECT COUNT(*) FROM facts WHERE entity_id = ? AND status IN ('provisional', 'provisional_enriched', 'verified', 'active'))
          + (SELECT COUNT(*) FROM beliefs WHERE subject = ? AND status IN ('active', 'verified'))
          + (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = ?)
          + (SELECT COUNT(*) FROM entity_attributes WHERE entity_id = ?)
          + (SELECT COUNT(*) FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ?)
          + ?
        ) AS count
      `).get(targetId, targetId, targetId, targetId, targetId, targetId,
        this.deepWriteCandidateStore.countActivePromotions('entity', targetId, candidate.candidateId)) as { count?: number } | null;
      if (Number(support?.count || 0) === 0) {
        this.entityStore.archiveEntity(targetId, now);
      }
    } else if (candidate.promotionTargetType === 'graph_edge') {
      const relationStore = this.extensions.get('relationStore') as GraphEdgeStoreLike | undefined;
      if (!relationStore || relationStore.getDatabase() !== this.episodeStore.getDatabase()) {
        throw new Error(`graph_edge_invalidation_failed:${targetId}`);
      }
      const invalidated = relationStore.invalidateEdge(targetId, {
        repairInvalidatedAt: now,
        sourceCandidateId: candidate.candidateId,
      });
      if (invalidated !== true) throw new Error(`graph_edge_invalidation_failed:${targetId}`);
    }
  }

  listDreamCandidates(options: DreamCandidateListOptions = {}): DreamCandidateRecord[] {
    return this.deepWriteCandidateStore.listCandidates(options);
  }

  countDreamCandidates(options: Omit<DreamCandidateListOptions, 'limit'> = {}): number {
    return this.deepWriteCandidateStore.countCandidates(options);
  }

  reviewDreamCandidate(input: CandidateReviewInput): CandidateReviewResult {
    return this.candidateReviewService.review(input);
  }

  listDreamCandidateReviews(options: { projectId?: string; candidateId?: string; limit?: number } = {}): CandidateReviewRecord[] {
    return this.candidateReviewStore.list(options);
  }

  bindMemoryEvent(event: MemoryEvent): MemoryBindingRecord[] {
    return this.memoryBindingService.bindRawEvent(event);
  }

  executeMemoryGovernancePlan(plan: MemoryGovernancePlan): MemoryGovernanceExecutionResult {
    return this.memoryGovernanceExecutor.execute(plan);
  }

  bindRawEvents(options: MemoryBindingBackfillOptions = {}): MemoryBindingBackfillResult {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
    const afterGlobalSeq = options.sinceGlobalSeq === undefined
      ? undefined
      : Math.max(-1, options.sinceGlobalSeq - 1);
    const records = this.eventStore.listRawEventsAfterGlobalSeq({
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      threadId: options.threadId,
      sessionId: options.sessionId,
      afterGlobalSeq,
      limit,
    });
    const result: MemoryBindingBackfillResult = {
      projectId: options.projectId,
      sinceGlobalSeq: options.sinceGlobalSeq,
      nextGlobalSeq: records.at(-1)?.globalSeq,
      hasMore: records.length >= limit,
      scannedEvents: records.length,
      bindableEvents: 0,
      boundEvents: 0,
      createdBindings: 0,
      skippedAlreadyBound: 0,
      failedEvents: 0,
      errors: [],
    };

    for (const event of records) {
      if (!this.memoryBindingService.isBindableRawEvent(event)) continue;
      result.bindableEvents += 1;
      if (this.memoryBindingStore.listBindings({ eventId: event.eventId, limit: 1 }).length > 0) {
        result.skippedAlreadyBound += 1;
        continue;
      }
      try {
        const bindings = this.bindMemoryEvent(event);
        if (bindings.length > 0) {
          result.boundEvents += 1;
          result.createdBindings += bindings.length;
        }
      } catch (error) {
        result.failedEvents += 1;
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ eventId: event.eventId, message });
        this.pipelineMetrics.recordNonFatal('memory_binding_failed', {
          projectId: event.projectId,
          message,
          details: { eventId: event.eventId, source: 'bindRawEvents' },
        });
      }
    }

    return result;
  }

  listMemoryBindings(options: MemoryBindingListOptions = {}): MemoryBindingRecord[] {
    return this.memoryBindingStore.listBindings(options);
  }

  listMemoryClusters(options: MemoryClusterListOptions = {}): MemoryClusterRecord[] {
    return this.memoryBindingStore.listClusters(options);
  }

  listMemoryEdges(options: MemoryEdgeListOptions = {}): MemoryEdgeRecord[] {
    return this.memoryBindingStore.listEdges(options);
  }

  recallMemoryBindingGraph(query: string, options: { projectId?: string; limit?: number } = {}): MemoryGraphRecallAnchor[] {
    return this.memoryBindingService.recallGraphAnchors(query, options);
  }

  getMemoryBindingStats(projectId?: string): MemoryBindingStats {
    return this.memoryBindingStore.getStats(projectId);
  }

  rebuildMemoryAtlas(options: { projectId?: string } = {}): { documents: number; actions: number } {
    return this.memoryAtlasIndexer.rebuild(options);
  }

  reindexMemoryAtlas(options: { projectId: string; eventId?: string; episodeId?: string }): { projectId: string; episodeIds: string[]; projectionCurrent: boolean; curatedEpisodes: number; facetEdges: number; reviewNeeded: number } {
    return this.memoryAtlasIndexer.reindex(options);
  }

  ensureMemoryAtlas(options: { projectId: string }): { documents: number; actions: number; refreshed: boolean } {
    return this.memoryAtlasIndexer.ensureFresh(options);
  }

  getMemoryFrame(episodeId: string, projectId?: string, options: { includeStaged?: boolean } = {}): MemoryFrameV1 | null {
    const episode = this.episodeStore.getEpisode(episodeId);
    if (!episode || (projectId !== undefined && episode.projectId !== projectId)) return null;
    return this.memoryFrameStore.getByEpisode(episode.projectId, episodeId, options.includeStaged ? ['active', 'needs_confirmation', 'staged'] : undefined);
  }

  reviewMemoryFrame(input: { frameId: string; projectId: string; action: 'approve' | 'reject'; actor: string; reason: string }): boolean {
    return this.memoryFrameStore.review(input.frameId, input.projectId, input.action, input.actor, input.reason);
  }

  listMemoryDimensions(projectId: string, nodeType?: string, limit = 100): Array<{ id: string; nodeType: string; label: string; confidence: number; evidenceEventIds: string[] }> {
    const allowed = new Set(['actor', 'entity', 'project', 'topic', 'issue', 'event', 'task', 'object', 'location', 'state', 'episode', 'time']);
    if (nodeType && !allowed.has(nodeType)) throw new Error(`invalid_memory_dimension:${nodeType}`);
    const rows = this.factStore.getDatabase().prepare(`
      SELECT node_id,node_type,label,confidence,evidence_event_ids_json
      FROM memory_atlas_documents
      WHERE project_id=? AND status NOT IN ('archived','rejected','needs_confirmation') ${nodeType ? 'AND node_type=?' : ''}
      ORDER BY confidence DESC, updated_at DESC, node_id ASC LIMIT ?
    `).all(projectId, ...(nodeType ? [nodeType] : []), Math.max(1, Math.min(limit, 500))) as Array<{ node_id: string; node_type: string; label: string; confidence: number; evidence_event_ids_json: string }>;
    return rows.map((row) => ({ id: row.node_id, nodeType: row.node_type, label: row.label, confidence: Number(row.confidence), evidenceEventIds: JSON.parse(row.evidence_event_ids_json || '[]') as string[] }));
  }

  backfillMemoryFrames(options: { projectId: string; limit?: number; cursor?: string; mode?: 'shadow' | 'active' }): { projectId: string; processed: number; created: number; needsReview: number; failed: number; errors?: Array<{ episodeId: string; message: string }>; nextCursor?: string; hasMore: boolean } {
    const page = this.episodeStore.listEpisodesForFrameBackfill({ projectId: options.projectId, cursor: options.cursor, limit: options.limit });
    const selected = page.episodes;
    let created = 0; let needsReview = 0; const failed: Array<{ episodeId: string; message: string }> = [];
    for (const episode of selected) {
      const events = this.episodeStore.listEventLinks(episode.episodeId).map((link) => this.eventStore.getEvent(link.eventId)).filter((event): event is MemoryEvent => Boolean(event));
      if (!events.length) continue;
      // One episode this layer cannot frame must not stop the page: the earlier version
      // threw out of the loop, so a single unknown episode type left every episode after
      // it unbackfilled with no record of which one stopped it.
      try {
        // The project's own vocabulary, so a frame the store then validates is one that vocabulary accepts (#175).
        const frame = deterministicFrameFallback({ projectId: options.projectId, episodeId: episode.episodeId, episodeType: episode.episodeType, episodeKinds: this.taxonomyResolution.taxonomy.episodeKinds.map((kind) => kind.id), events });
        const saved = this.memoryFrameStore.save({
        frame,
        sourceFingerprint: frameSourceFingerprint(events.map((event) => event.eventId), episode.episodeId),
          status: 'staged',
          publishStatus: 'needs_confirmation',
        });
        // Backfill active is an explicit publication request, but deterministic
        // fallback frames remain review-only and can never become active here.
        if (options.mode === 'active') {
          const published = this.memoryFrameStore.publish(saved.frameId, 'staged', frame.needsReview ? 'needs_confirmation' : 'active');
          if (!published) throw new Error(`memory_frame_backfill_publish_conflict:${saved.frameId}`);
        }
        created += 1; needsReview += frame.needsReview ? 1 : 0;
      } catch (error) {
        failed.push({ episodeId: episode.episodeId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { projectId: options.projectId, processed: selected.length, created, needsReview, failed: failed.length, ...(failed.length ? { errors: failed } : {}), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), hasMore: page.hasMore };
  }

  private prepareMemoryAtlasRead(options: MemoryAtlasQueryOptions): { atlasFresh: boolean; refreshError?: string } {
    if (options.refresh !== true) {
      const state = this.memoryAtlasStore.getProjectionState(options.projectId);
      return { atlasFresh: state?.status === 'clean' };
    }
    try {
      this.ensureMemoryAtlas({ projectId: options.projectId });
      return { atlasFresh: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.staleOk !== false && /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) {
        return { atlasFresh: false, refreshError: message };
      }
      throw error;
    }
  }

  private withProjectClock(options: MemoryAtlasQueryOptions): MemoryAtlasQueryOptions {
    const now = options.now ?? Date.now();
    const timeZone = options.timeZone ?? this.projectClock.timeZone;
    return { ...options, now, timeZone, localDateNow: options.localDateNow ?? localDateFor(now, timeZone) };
  }

  private withAtlasFreshness<T extends object>(result: T, freshness: { atlasFresh: boolean; refreshError?: string }): T {
    return Object.assign(result, {
      atlasFresh: freshness.atlasFresh,
      ...(freshness.refreshError ? { refreshError: freshness.refreshError } : {}),
    });
  }

  graphOverview(options: MemoryAtlasQueryOptions): MemoryAtlasSlice {
    const freshness = this.prepareMemoryAtlasRead(options);
    return this.withAtlasFreshness(this.memoryAtlasService.overview(options), freshness);
  }

  graphSearch(query: string, options: MemoryAtlasQueryOptions): MemoryAtlasSlice {
    options = this.withProjectClock(options);
    const freshness = this.prepareMemoryAtlasRead(options);
    return this.withAtlasFreshness(this.memoryAtlasService.search(query, options), freshness);
  }

  graphExplore(query: string, options: MemoryAtlasQueryOptions): MemoryAtlasSlice {
    options = this.withProjectClock(options);
    const freshness = this.prepareMemoryAtlasRead(options);
    return this.withAtlasFreshness(this.memoryAtlasService.explore(query, options), freshness);
  }

  planMemoryQuery(query: string, options: MemoryAtlasQueryOptions): { queryFrame: ReturnType<MultidimensionalQueryPlanner['plan']>; result: MemoryAtlasSlice } {
    options = this.withProjectClock(options);
    const freshness = this.prepareMemoryAtlasRead(options);
    const planned = this.atlasPathRetriever.retrieve(query, options);
    return { queryFrame: planned.queryFrame, result: this.withAtlasFreshness(planned.result, freshness) };
  }

  graphNode(nodeId: string, options: MemoryAtlasQueryOptions): MemoryAtlasNodeDetail | null {
    const freshness = this.prepareMemoryAtlasRead(options);
    const result = this.memoryAtlasService.node(nodeId, options);
    return result ? this.withAtlasFreshness(result, freshness) : result;
  }

  graphNeighbors(nodeId: string, options: MemoryAtlasQueryOptions & { hops?: number }): MemoryAtlasSlice {
    const freshness = this.prepareMemoryAtlasRead(options);
    return this.withAtlasFreshness(this.memoryAtlasService.neighbors(nodeId, options), freshness);
  }

  graphPath(from: string, to: string, options: MemoryAtlasQueryOptions & { maxHops?: number }): MemoryAtlasPathResult {
    const freshness = this.prepareMemoryAtlasRead(options);
    return this.withAtlasFreshness(this.memoryAtlasService.path(from, to, options), freshness);
  }

  graphTimeline(query: string, options: MemoryAtlasQueryOptions): MemoryAtlasTimelineResult {
    options = this.withProjectClock(options);
    const freshness = this.prepareMemoryAtlasRead(options);
    return this.withAtlasFreshness(this.memoryAtlasService.timeline(query, options), freshness);
  }

  touchMemoryAtlas(input: { projectId: string; nodeIds: string[]; reason: string; query?: string; now?: number }): { touched: number } {
    if (!input.projectId?.trim()) throw new Error('projectId is required');
    if (!input.reason?.trim()) throw new Error('reason is required');
    const valid = Array.from(new Set(input.nodeIds)).filter((id) => this.memoryAtlasStore.getNode(id, input.projectId)).slice(0, 30);
    return { touched: this.memoryAtlasStore.recordAccess(input.projectId, valid, input.reason, input.query, input.now) };
  }

  countUnboundBindableRawEvents(projectId?: string, limit: number = 1000): number {
    const max = Math.max(1, limit);
    const scoped = projectId !== undefined;
    const rows = this.factStore.getDatabase().prepare(`
      SELECT e.raw_event_type AS raw_event_type, e.payload_json AS payload_json
      FROM memory_events e
      WHERE e.event_type = 'RAW_EVENT_RECORDED'
        AND e.role = 'user'
        AND (e.raw_event_type IS NULL OR e.raw_event_type = 'message')
        AND NOT EXISTS (SELECT 1 FROM memory_bindings b WHERE b.event_id = e.event_id)
        ${scoped ? `AND COALESCE(e.project_id,'') = ?` : ''}
      LIMIT ?
    `).all(...(scoped ? [projectId, max] : [max])) as Array<{ raw_event_type: string | null; payload_json: string }>;
    let count = 0;
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const event = { role: 'user', rawEventType: row.raw_event_type, payload } as MemoryEvent;
      if (this.memoryBindingService.isBindableRawEvent(event)) count += 1;
    }
    return count;
  }

  promoteDreamCandidates(options: DreamGovernanceRunOptions = {}): DreamGovernanceRunResult {
    this.deepWriteCandidateStore.recoverStalePromoting(Date.now() - 5 * 60_000, Date.now());
    const decisions = this.deepWritePromotionPolicy.promotePending(options.limit ?? 100, {
      projectId: options.projectId,
    });
    // Named explicitly: a prefix match would silently start counting a future
    // outcome called `promote_*` that is not a promotion.
    const promoting = new Set<DeepWritePromotionDecision['outcome']>(['promote_verified', 'promote_provisional']);
    const promotedCandidates = decisions.filter((decision) => promoting.has(decision.outcome)).length;
    return {
      projectId: options.projectId,
      decisions,
      promotedCandidates,
      neuronsWritten: 0,
      queue: this.getDreamCandidateQueue(options.projectId),
    };
  }

  getDreamCandidateQueue(projectId?: string): DreamGovernanceRunResult['queue'] {
    return {
      candidate: this.countDreamCandidates({ projectId, statuses: ['candidate'] }),
      needsConfirmation: this.countDreamCandidates({ projectId, statuses: ['needs_confirmation'] }),
      promoted: this.countDreamCandidates({ projectId, statuses: ['promoted'] }),
      rejected: this.countDreamCandidates({ projectId, statuses: ['rejected'] }),
      superseded: this.countDreamCandidates({ projectId, statuses: ['superseded'] }),
      shadow: this.countDreamCandidates({ projectId, statuses: ['shadow'] }),
    };
  }

  getBacklogReadings(projectId?: string, now = Date.now(), confirmationTtlMs = CONFIRMATION_TTL_MS) {
    const expiredBefore = now - confirmationTtlMs;
    const warningBefore = expiredBefore + CONFIRMATION_WARNING_MS;
    const aging = this.deepWriteCandidateStore.countNeedsConfirmationAging({ projectId, expiredBefore, warningBefore });
    const highPrivilegeAging = this.deepWriteCandidateStore.countNeedsConfirmationAging({
      projectId, expiredBefore, warningBefore, candidateTypes: HIGH_PRIVILEGE_CANDIDATE_TYPES,
    });
    return {
      measuredAt: now,
      unboundEvents: this.countUnboundBindableRawEvents(projectId),
      dreamBacklog: this.getDreamBacklogStatus(projectId).undreamedRawCount,
      aliasConflicts: this.countEntityAliasConflicts(projectId),
      candidateQueue: {
        ...this.getDreamCandidateQueue(projectId),
        needsConfirmationExpiringSoon: aging.expiringSoon,
        needsConfirmationOverdue: aging.overdue,
        highPrivilege: {
          needsConfirmation: this.countDreamCandidates({ projectId, statuses: ['needs_confirmation'], candidateTypes: HIGH_PRIVILEGE_CANDIDATE_TYPES }),
          needsConfirmationExpiringSoon: highPrivilegeAging.expiringSoon,
          needsConfirmationOverdue: highPrivilegeAging.overdue,
        },
      },
    };
  }

  countEntityAliasConflicts(projectId?: string): number {
    return this.entityStore.listAliasConflicts().filter((conflict) => {
      if (projectId === undefined) return true;
      return conflict.entityIds.some((entityId) => {
        const entity = this.entityStore.getByEntityId(entityId);
        return entity?.metadata?.projectId === projectId
          || this.entityStore.listTimeline({ entityId, projectId, limit: 1 }).length > 0;
      });
    }).length;
  }

  buildMemoryMap(options: MemoryMapOptions = {}): MemorySelfMap {
    const projectId = options.projectId;
    const rawPage = this.eventStore.queryEvents(1, 1, {
      projectId: projectId !== undefined ? [projectId] : undefined,
    });
    const dreamBacklog = this.getDreamBacklogStatus(projectId);
    const dreamCandidateQueue = this.getDreamCandidateQueue(projectId);
    const memoryBindingStats = this.getMemoryBindingStats(projectId);
    const episodes = this.listEpisodes({ projectId, limit: 1000 });
    const episodeDream = this.getEpisodeDreamStatus(projectId);
    const unassignedRawEvents = this.episodeStore.countUnassignedRawEvents(projectId);

    return {
      version: 'memory_map.v1',
      generatedAt: Date.now(),
      projectId,
      anatomy: [
        {
          id: 'raw_ledger',
          name: 'Raw chronological ledger',
          role: 'append-only event source for exact source drill-down and vectors=0 recall fallback',
          currentCount: rawPage.total,
        },
        {
          id: 'belief_cases',
          name: 'Belief cases',
          role: 'active beliefs plus support, supersession, and contradiction history',
        },
        {
          id: 'entity_cards',
          name: 'Entity cards',
          role: 'resolved people, projects, devices, aliases, attributes, and mention timelines',
        },
        {
          id: 'memory_binding',
          name: 'Memory binding layer',
          role: 'deterministic raw-event bindings, clusters, and graph edges before governed fact promotion',
          currentCount: memoryBindingStats.bindings,
        },
        {
          id: 'memory_atlas',
          name: 'Memory Atlas',
          role: 'bounded, source-anchored content navigation over topics, entities, clusters, episodes, beliefs, actions, and time',
        },
        {
          id: 'episode_assembler',
          name: 'Episode assembler',
          role: 'groups raw session events into auditable open, soft-sealed, and sealed consolidation units',
          currentCount: episodes.length,
        },
        {
          id: 'dream_queue',
          name: 'Dream curator queue',
          role: 'sealed-episode candidate-only consolidation backlog controlled by explicit host ticks',
          currentCount: episodeDream.pending + episodeDream.failed,
        },
      ],
      dataLanes: [
        {
          id: 'episode_dream',
          name: 'Episode Dream',
          route: 'cogmem episode status|repair and cogmem dream tick|status',
          useWhen: 'Inspect conversation boundaries, repair unassigned raw events, or conditionally consolidate sealed episodes.',
        },
        {
          id: 'agent_recall_pack',
          name: 'Agent recall pack',
          route: 'KernelAgentMemoryBackend.recall()',
          useWhen: 'Before an agent answer that needs the raw ledger, the binding graph, beliefs, entities and the Atlas.',
        },
        {
          id: 'collection_routing',
          name: 'Collection routing',
          route: 'collection:<name> tags on raw events',
          useWhen: 'Store creative Theseus artifacts without polluting default operational recall.',
        },
        {
          id: 'source_drilldown',
          name: 'Source drill-down',
          route: 'sourceContext.locator.command',
          useWhen: 'Audit exact raw events behind any recalled item.',
        },
        {
          id: 'maintenance_tick',
          name: 'Maintenance tick',
          route: 'MemoryKernel.runMaintenanceTick() / cogmem memory tick',
          useWhen: 'Let the host decide when to decay activation, run dream, govern candidates, or re-embed.',
        },
        {
          id: 'memory_binding',
          name: 'Memory binding',
          route: 'MemoryKernel.listMemoryBindings(), listMemoryClusters(), listMemoryEdges(), bindRawEvents(), recallMemoryBindingGraph() / cogmem memory map|bind',
          useWhen: 'Inspect or backfill raw-event topic/entity bindings, claim-key clusters, correction edges, and graph-recall anchors.',
        },
        {
          id: 'memory_atlas',
          name: 'Memory Atlas navigation',
          route: 'MemoryKernel.graphOverview(), graphExplore(), graphNode(), graphNeighbors(), graphPath(), graphTimeline() / cogmem memory graph-*',
          useWhen: 'Inventory broad memory areas, combine query facets, navigate relationships, or revive cold source evidence before exact drill-down.',
        },
      ],
      bounds: [
        'kernel-only memory layer; no notes app, wiki, or UI ownership',
        'no hidden daemon; cron/systemd/agent adapters explicitly call dream tick or memory tick',
        'candidate-only self-improvement unless governance promotes the candidate',
        'sourceContext remains available for drill-down instead of replacing evidence with summaries',
        'default recall includes untagged and collection:anchor only; collection:theseus requires an explicit collection query',
      ],
      manual: {
        commands: [
          'cogmem memory recall --project <id> --query <q> --json',
          'cogmem memory recall --project <id> --collection theseus --query <q> --json',
          'cogmem memory show --event <event-id> --before 2 --after 2',
          'cogmem memory map --project <id> --json',
          'cogmem memory graph-explore --project <id> --query <q> --json',
          'cogmem memory graph-node --project <id> --id <node-id> --json',
          'cogmem memory graph-path --project <id> --from <node-id> --to <node-id> --json',
          'cogmem memory tick --project <id> --json',
          'cogmem memory bind --project <id> --json',
          'cogmem episode status --project <id> --json',
          'cogmem episode repair --project <id> --json',
          'cogmem dream tick --project <id> --mode auto --json',
        ],
        agentUsage: [
          'Call recall() before answering; it is the one agent-facing recall entry point (raw ledger, binding graph, Atlas).',
          'Use collection "theseus" for creative artifacts and collection "anchor" or no collection for operational memory.',
          'Use memory map for self-inspection; use maintenance tick for explicit host-owned upkeep signals.',
          'Run memory bind when maintenance tick reports bind_raw_events for imported or adapter-written raw user events.',
          'Use episode append/import for hookless agents; call dream tick only from an explicit host schedule or operator action.',
          'Use memory bindings, claim-key clusters, correction edges, and graph recall anchors as source-anchored organization hints, not as promoted long-term facts.',
          'Use graph explore for broad inventory or historical questions, then graph node/path/timeline to narrow the source-anchored slice before memory show.',
          'Treat Atlas activation as visibility ranking only; exact project-scoped facet matches can revive cold nodes without changing their truth status.',
        ],
      },
      counters: {
        rawEvents: rawPage.total,
        memoryBindings: memoryBindingStats.bindings,
        memoryBindingTopics: memoryBindingStats.topics,
        memoryBindingEntities: memoryBindingStats.entities,
        memoryBindingClusters: memoryBindingStats.clusters,
        memoryBindingEdges: memoryBindingStats.edges,
        episodes: episodes.length,
        unassignedRawEvents,
        episodeDream,
        dreamBacklog,
        dreamCandidateQueue,
      },
    };
  }

  runMaintenanceTick(options: MaintenanceTickOptions = {}): MaintenanceTickResult {
    const projectId = options.projectId;
    const ranAt = options.now ?? Date.now();
    const passDidNotProduce = (state: { skipped?: true; errors?: Array<{ projectId: string; error: string }> }) => ({
      documents: this.memoryAtlasStore.countDocuments(projectId),
      actions: 0,
      refreshed: false,
      ...state,
    });
    const runPass = (): MaintenanceTickResult['executed']['memoryAtlasRefresh'] => projectId !== undefined
      ? { ...this.ensureMemoryAtlas({ projectId }), errors: [] }
      : this.memoryAtlasIndexer.ensureAllFresh();
    let memoryAtlasRefresh: MaintenanceTickResult['executed']['memoryAtlasRefresh'];
    try {
      memoryAtlasRefresh = options.atlasRefresh === false ? passDidNotProduce({ skipped: true }) : runPass();
    } catch (error) {
      memoryAtlasRefresh = passDidNotProduce({
        errors: [{ projectId: projectId ?? '__all__', error: error instanceof Error ? error.message : String(error) }],
      });
    }
    const memoryAtlasActivationDecay = this.memoryAtlasStore.decay(projectId, options.activationDecayFactor ?? 0.85, ranAt);
    const memoryAtlasAccessPruned = this.memoryAtlasStore.cleanupAccess({
      projectId, before: ranAt - (options.atlasAccessRetentionMs ?? 90 * 24 * 60 * 60 * 1000),
    });
    const episodeIdleGapMs = this.episodeBoundaryPolicy.config.maxIdleGapMs;
    const episodeIdleBefore = ranAt - episodeIdleGapMs;
    const episodeSealing = {
      idleGapMs: episodeIdleGapMs,
      idleBefore: episodeIdleBefore,
      sealedEpisodes: this.episodeStore.sealIdleEpisodes({ projectId, idleBefore: episodeIdleBefore, now: ranAt }).length,
    };
    const confirmationTtlMs = options.confirmationTtlMs ?? CONFIRMATION_TTL_MS;
    const reviewQueueAging = this.deepWriteCandidateStore.expireNeedsConfirmation({
      projectId,
      before: ranAt - confirmationTtlMs,
      now: ranAt,
    });
    const backlog = this.getBacklogReadings(projectId, ranAt, confirmationTtlMs);
    const episodeDream = this.getEpisodeDreamStatus(projectId);
    const unassignedEpisodeRawEvents = this.episodeStore.countUnassignedRawEvents(projectId);
    const candidateQueue = backlog.candidateQueue.candidate + backlog.candidateQueue.needsConfirmation + backlog.candidateQueue.shadow;
    const bindingFailures = this.pipelineMetrics.getNonFatalCount('memory_binding_failed', { projectId });
    const suggestedActions: MaintenanceSuggestedAction[] = [];
    const suggestedAction = (
      kind: MaintenanceSuggestedAction['kind'],
      executable: string,
      args: string[],
      reason: string,
    ): MaintenanceSuggestedAction => ({
      kind,
      executable,
      args,
      command: [executable, ...args.map(cliArg)].join(' '),
      reason,
    });

    if (episodeDream.pending + episodeDream.failed > 0) {
      suggestedActions.push(suggestedAction('dream_curator', 'cogmem', [
        'dream', 'tick', ...(projectId !== undefined ? ['--project', projectId] : []), '--mode', 'auto'
      ], `${episodeDream.pending + episodeDream.failed} sealed episodes are waiting for candidate-only Dream processing.`));
    }
    if (unassignedEpisodeRawEvents > 0) {
      suggestedActions.push(suggestedAction('repair_episodes', 'cogmem', [
        'episode', 'repair', ...(projectId !== undefined ? ['--project', projectId] : []), '--json'
      ], `${unassignedEpisodeRawEvents} raw events are not assigned to an episode; the raw evidence remains intact.`));
    }
    if (candidateQueue > 0) {
      suggestedActions.push(suggestedAction('govern_candidates', 'cogmem', [
        'memory', 'govern', ...(projectId !== undefined ? ['--project', projectId] : [])
      ], `${candidateQueue} dream/deep-write candidates need CPU governance.`));
    }
    if (backlog.aliasConflicts > 0) {
      suggestedActions.push(suggestedAction('resolve_entities', 'cogmem', ['memory', 'map', '--json'], `${backlog.aliasConflicts} active entity alias conflicts need host or agent review.`));
    }
    if (backlog.unboundEvents > 0) {
      suggestedActions.push(suggestedAction('bind_raw_events', 'cogmem', [
        'memory', 'bind', ...(projectId !== undefined ? ['--project', projectId] : []), '--json'
      ], `${backlog.unboundEvents} high-value raw user events are not attached to memory binding clusters yet.`));
    }
    if (bindingFailures > 0) {
      suggestedActions.push(suggestedAction('inspect_binding_failures', 'cogmem', [
        'memory', 'tick', ...(projectId !== undefined ? ['--project', projectId] : []), '--json'
      ], `${bindingFailures} non-fatal memory binding failures were recorded; raw ledger writes were preserved.`));
    }
    return {
      version: 'maintenance_tick.v1',
      projectId,
      ranAt,
      hostOwned: true,
      chargeVector: {
        dreamBacklog: backlog.dreamBacklog,
        candidateQueue,
        entityConflicts: backlog.aliasConflicts,
        unboundRawEvents: backlog.unboundEvents,
        bindingFailures,
        expiredConfirmationCandidates: reviewQueueAging.expired,
        needsConfirmationExpiringSoon: backlog.candidateQueue.needsConfirmationExpiringSoon,
        highPrivilegeNeedsConfirmationExpiringSoon: backlog.candidateQueue.highPrivilege.needsConfirmationExpiringSoon,
        episodeDreamBacklog: episodeDream.pending + episodeDream.failed,
        unassignedEpisodeRawEvents,
      },
      executed: {
        episodeSealing,
        memoryAtlasRefresh,
        memoryAtlasActivationDecay,
        memoryAtlasAccessPruned,
        reviewQueueAging: {
          ...reviewQueueAging,
          ttlMs: confirmationTtlMs,
        },
        hiddenDaemonStarted: false,
      },
      suggestedActions,
    };
  }

  async exportSnapshot(outputPath: string): Promise<SnapshotMeta> {
    const exporter = new SnapshotExporter({
      embeddingDimension: this.getEmbeddingDimension(),
      coreVersion: CORE_VERSION,
    });
    return exporter.export(this.dbPath, outputPath);
  }

  async importSnapshot(snapshotPath: string, opts: ImportOptions = {}): Promise<ImportResult> {
    if (this.initialized) throw new KernelRunningError();
    if (this.dbPath === ':memory:') {
      throw new Error(
        'Cannot import a snapshot into an in-memory MemoryKernel (dbPath is ":memory:"). ' +
        'Provide a file-backed dbPath when creating the kernel.',
      );
    }
    this.close();
    const importer = new SnapshotImporter({ expectedEmbeddingDimension: this.getEmbeddingDimension() });
    return importer.import(snapshotPath, this.dbPath, opts);
  }

  getHealthStatus() {
    const lastRun = this.pipelineMetrics.getLastRun();
    const pipelineP99Ms = this.pipelineMetrics.getPipelineP99();
    const db = this.factStore.getDatabase();
    const count = (sql: string): number => Number((db.prepare(sql).get() as { count?: number } | null)?.count ?? 0);
    let recallDecisions: { rows: number; maxRows: number };
    try {
      recallDecisions = { rows: count(`SELECT COUNT(*) AS count FROM trace_events`), maxRows: RECALL_TRACE_MAX_ROWS };
    } catch {
      recallDecisions = { rows: 0, maxRows: RECALL_TRACE_MAX_ROWS };
    }
    return {
      status: 'ok',
      package: 'cogmem',
      dbPath: this.dbPath,
      stats: this.getStats(),
      storage: {
        rawEvents: count(`SELECT COUNT(*) AS count FROM memory_events`),
        embeddings: this.eventEmbeddingStore.getProgress(),
        recallDecisions,
      },
      backlog: this.getBacklogReadings(),
      vectorRecall: this.semanticIndexEnabled() ? 'active' : 'disabled',
      embeddingModelId: this.embeddingProvider?.modelId,
      hasStaleVectors: this.embeddingProvider
        ? this.eventEmbeddingStore.hasStaleVectors(this.embeddingProvider.modelId)
        : false,
      pipelineLastRunAt: lastRun?.completedAt,
      pipelineP99Ms: pipelineP99Ms > 0 ? pipelineP99Ms : undefined,
      pipelineLastRunAborted: lastRun?.aborted ?? false,
      extensionCount: this.extensions.size,
    };
  }

  getStats() {
    const db = this.factStore.getDatabase();
    const count = (sql: string): number => Number((db.prepare(sql).get() as { count?: number } | null)?.count ?? 0);
    return {
      rawEventCount: count(`SELECT COUNT(*) AS count FROM memory_events WHERE event_type = 'RAW_EVENT_RECORDED'`),
      episodeCount: count(`SELECT COUNT(*) AS count FROM memory_episodes`),
      beliefCount: count(`SELECT COUNT(*) AS count FROM beliefs WHERE status IN ('active','verified')`),
      frameCount: count(`SELECT COUNT(*) AS count FROM memory_frames WHERE status = 'active'`),
    };
  }

  getMetrics() {
    const stats = this.getStats();
    return {
      queryLatency: 0,
      queryType: 'STANDARD',
      rawEventCount: stats.rawEventCount,
      beliefCount: stats.beliefCount,
      energyPropagation: 0,
      memoryUsage: 0,
      modelInferenceHealth: 1,
      chainIntegrityScore: 1,
      fallbackCount: 0,
    };
  }

  async forgetUser(projectId: string, _reason = 'unspecified'): Promise<ForgetUserResult> {
    const db = this.factStore.getDatabase();
    const scope = projectScope(projectId);
    db.exec(`DROP TABLE IF EXISTS _forget_event_ids`);
    db.prepare(`CREATE TEMP TABLE _forget_event_ids AS
      SELECT event_id AS id FROM memory_events WHERE COALESCE(project_id, '') = ?`).run(scope);
    const auditId = `audit-${randomUUID()}`;
    const auditScope = `sha256:${createHash('sha256').update(scope).digest('hex')}`;
    const deleted = {
      events: 0,
      facts: 0,
      compiledEvents: 0,
      memoryBindings: 0,
      episodes: 0,
      brainProjections: 0,
      entityRecords: 0,
    };

    const projectMentionRows = db.prepare(`
      SELECT DISTINCT entity_id FROM entity_mentions
      WHERE COALESCE(project_id, '') = ? OR neuron_id IN (SELECT id FROM _forget_event_ids)
    `).all(scope) as Array<{ entity_id: string }>;
    const projectMentionEntityIds = new Set(projectMentionRows.map((row) => row.entity_id));
    const mentionScopes = new Map<string, Set<string>>();
    for (const row of db.prepare(`SELECT entity_id,COALESCE(project_id,'') AS scope FROM entity_mentions`).all() as Array<{ entity_id: string; scope: string }>) {
      const scopes = mentionScopes.get(row.entity_id) ?? new Set<string>();
      scopes.add(row.scope);
      mentionScopes.set(row.entity_id, scopes);
    }
    const projectEntityInstances = (db.prepare(`
      SELECT instance_id, canonical_entity_id, aliases_json, metadata_json
      FROM entity_instances
    `).all() as Array<{ instance_id: string; canonical_entity_id: string; aliases_json: string; metadata_json: string | null }>)
      .filter((row) => {
        const ownerProjectId = parseJsonObject(row.metadata_json).projectId;
        if (typeof ownerProjectId === 'string') return projectScope(ownerProjectId) === scope;
        const scopes = mentionScopes.get(row.instance_id) ?? new Set<string>();
        return projectMentionEntityIds.has(row.instance_id) && scopes.size > 0 && [...scopes].every((value) => value === scope);
      });
    const projectEntityIds = projectEntityInstances.map((row) => row.instance_id);
    const affectedCanonicalEntityIds = uniqueStrings([
      ...projectEntityInstances.map((row) => row.canonical_entity_id),
      ...(projectMentionEntityIds.size === 0 ? [] : (db.prepare(`
        SELECT DISTINCT canonical_entity_id FROM entity_instances
        WHERE instance_id IN (${[...projectMentionEntityIds].map(() => '?').join(',')})
      `).all(...projectMentionEntityIds) as Array<{ canonical_entity_id: string }>).map((row) => row.canonical_entity_id)),
    ]);

    const runDelete = (sql: string, params: Array<string | number> = []): number => {
      try {
        return Number(db.prepare(sql).run(...params).changes ?? 0);
      } catch (error) {
        if (error instanceof Error) {
          const missing = /no such table:\s*(?:main\.)?([\w]+)/i.exec(error.message)?.[1];
          const target = /^\s*DELETE\s+FROM\s+([\w]+)/i.exec(sql)?.[1];
          if (missing && target && missing.toLowerCase() === target.toLowerCase()) return 0;
        }
        throw error;
      }
    };
    const deleteScoped = (table: string): number => runDelete(
      `DELETE FROM ${table} WHERE COALESCE(project_id, '') = ?`,
      [scope]
    );

    db.exec(`PRAGMA secure_delete = ON`);
    const erase = db.transaction(() => {
      Object.assign(deleted, { privacyTables: deleteRegisteredProjectContent({
        scope,
        runDelete,
        listPersistentTables: () => (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((row) => row.name),
        hasColumn: (table, column) => Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, column)),
      }) });
      deleted.facts += runDelete(`DELETE FROM facts WHERE neuron_id IN (SELECT id FROM _forget_event_ids)`);
      deleted.compiledEvents += runDelete(`DELETE FROM compiled_events WHERE neuron_id IN (SELECT id FROM _forget_event_ids)`);
      deleted.episodes += this.episodeStore.deleteByProject(scope);
      for (const table of [
        'memory_atlas_supports', 'memory_atlas_aliases', 'memory_edge_supports', 'memory_edges', 'memory_atlas_fts',
        'memory_atlas_documents', 'memory_action_frame_evidence', 'memory_action_frames',
        'memory_atlas_access', 'memory_atlas_activation', 'memory_atlas_projection_state',
        'memory_frames'
      ]) deleteScoped(table);
      runDelete(`DELETE FROM memory_events_fts WHERE event_id IN (SELECT event_id FROM memory_events WHERE COALESCE(project_id, '') = ?)`, [scope]);
      runDelete(`DELETE FROM memory_event_cjk_terms WHERE event_id IN (SELECT event_id FROM memory_events WHERE COALESCE(project_id, '') = ?)`, [scope]);
      deleted.events += deleteScoped('memory_events');
      deleteScoped('compiler_confidence_runs');
      deleted.memoryBindings += this.memoryBindingStore.deleteByProject(scope);

      deleted.brainProjections += runDelete(`DELETE FROM prospective_memory_transitions WHERE candidate_id IN (SELECT candidate_id FROM prospective_memories WHERE COALESCE(project_id, '') = ?)`, [scope]);
      for (const table of ['prospective_memories', 'context_strategy_outcomes', 'context_activation_receipts', 'memory_timeline_entries']) {
        deleted.brainProjections += deleteScoped(table);
      }
      deleted.brainProjections += runDelete(`DELETE FROM belief_graph_evidence WHERE belief_id IN (SELECT belief_id FROM belief_graph_nodes WHERE COALESCE(project_id, '') = ?)`, [scope]);
      deleted.brainProjections += runDelete(`DELETE FROM belief_graph_versions WHERE belief_id IN (SELECT belief_id FROM belief_graph_nodes WHERE COALESCE(project_id, '') = ?)`, [scope]);
      for (const table of ['belief_graph_conflicts', 'belief_graph_nodes']) deleted.brainProjections += deleteScoped(table);
      deleted.brainProjections += runDelete(`DELETE FROM entity_resolution_log WHERE candidate_id IN (SELECT candidate_id FROM entity_merge_candidates WHERE COALESCE(project_id, '') = ?)`, [scope]);
      for (const table of ['entity_merge_candidates', 'memory_governance_audit']) deleted.brainProjections += deleteScoped(table);
      deleted.brainProjections += runDelete(`DELETE FROM memory_governance_plans WHERE COALESCE(project_id, '') = ? OR plan_id IN (SELECT plan_id FROM memory_governance_operations WHERE COALESCE(project_id, '') = ?)`, [scope, scope]);
      deleted.brainProjections += deleteScoped('memory_governance_operations');

      const sharedEntityIds = (db.prepare(`
        SELECT DISTINCT entity_id FROM entity_mentions target
        WHERE COALESCE(target.project_id,'')=?
          AND EXISTS (SELECT 1 FROM entity_mentions other WHERE other.entity_id=target.entity_id AND COALESCE(other.project_id,'')<>?)
      `).all(scope, scope) as Array<{ entity_id: string }>).map((row) => row.entity_id);
      for (const entityId of sharedEntityIds) {
        const survivingAlias = db.prepare(`SELECT alias_text FROM entity_aliases WHERE entity_id=? AND COALESCE(project_id,'')<>? ORDER BY updated_at DESC,alias_id LIMIT 1`)
          .get(entityId, scope) as { alias_text?: string } | null;
        db.prepare(`UPDATE entity_instances SET canonical_name=?,aliases_json='[]',metadata_json='{}',created_from=NULL WHERE instance_id=?`)
          .run(survivingAlias?.alias_text || `entity-${entityId.slice(-12)}`, entityId);
      }
      deleted.entityRecords += deleteScoped('entity_aliases');
      deleted.entityRecords += deleteScoped('entity_relations');
      deleted.entityRecords += deleteScoped('entity_alias_conflicts');
      deleted.entityRecords += deleteScoped('entity_mentions');
      if (projectEntityIds.length > 0) {
        const entityPlaceholders = projectEntityIds.map(() => '?').join(', ');
        deleted.entityRecords += runDelete(`DELETE FROM entity_resolution_log WHERE source_entity_id IN (${entityPlaceholders}) OR target_entity_id IN (${entityPlaceholders})`, [...projectEntityIds, ...projectEntityIds]);
        deleted.entityRecords += runDelete(`DELETE FROM entity_merge_candidates WHERE source_entity_id IN (${entityPlaceholders}) OR target_entity_id IN (${entityPlaceholders})`, [...projectEntityIds, ...projectEntityIds]);
        deleted.entityRecords += runDelete(`DELETE FROM entity_aliases WHERE entity_id IN (${entityPlaceholders})`, projectEntityIds);
        deleted.entityRecords += runDelete(`DELETE FROM entity_attributes WHERE entity_id IN (${entityPlaceholders})`, projectEntityIds);
        deleted.entityRecords += runDelete(`DELETE FROM entity_relations WHERE source_entity_id IN (${entityPlaceholders}) OR target_entity_id IN (${entityPlaceholders})`, [...projectEntityIds, ...projectEntityIds]);
        deleted.entityRecords += runDelete(`DELETE FROM pending_entity_resolution WHERE resolved_entity_id IN (${entityPlaceholders})`, projectEntityIds);
        deleted.entityRecords += runDelete(`DELETE FROM entity_instances WHERE instance_id IN (${entityPlaceholders})`, projectEntityIds);
        scrubEntityAliasConflicts(db, projectEntityIds);
      }
      deleted.entityRecords += runDelete(`DELETE FROM entity_attributes WHERE source_neuron_id IN (SELECT id FROM _forget_event_ids)`);
      deleted.entityRecords += runDelete(`DELETE FROM entity_relations WHERE source_neuron_id IN (SELECT id FROM _forget_event_ids)`);
      deleted.entityRecords += runDelete(`DELETE FROM pending_entity_resolution WHERE context_neuron_id IN (SELECT id FROM _forget_event_ids)`);
      for (const canonicalEntityId of affectedCanonicalEntityIds) {
        rebuildCanonicalEntityAfterForget(db, canonicalEntityId, runDelete);
      }
      const residualPrivacyTables = deleteResidualProjectOwnedContent({
        scope,
        runDelete,
        listPersistentTables: () => (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((row) => row.name),
        hasColumn: (table, column) => Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, column)),
      });
      Object.assign((deleted as typeof deleted & { privacyTables?: Record<string, number> }).privacyTables ??= {}, residualPrivacyTables);
      runDelete(`DELETE FROM governance_audit_log WHERE COALESCE(project_id,'') IN (?,?)`, [scope, auditScope]);
      db.prepare(`
        INSERT INTO governance_audit_log (
          audit_id, action, project_id, reason, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(auditId, 'forgetUser', auditScope, 'privacy_erasure_requested', JSON.stringify({ deleted }), Date.now());
    });
    try {
      erase();
    } finally {
      db.exec(`DROP TABLE IF EXISTS _forget_event_ids`);
    }

    db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    // #64: VACUUM needs temporary space, and the default is a file in a directory
    // the process may not be able to write, which surfaces as `unable to open
    // database file` and blames the database. In memory for the duration of the
    // rebuild, so forgetting a user works on a read-only temp filesystem; the
    // previous setting is restored afterwards, because this is the kernel's own
    // connection and an in-memory temp store is the wrong default for large sorts.
    const previousTempStore = (db.prepare('PRAGMA temp_store').get() as { temp_store?: number } | undefined)?.temp_store ?? 0;
    db.exec('PRAGMA temp_store = MEMORY');
    try {
      db.exec(`VACUUM`);
    } catch (error) {
      // #64: as in snapshot export, a temp-file failure here is reported by
      // SQLite as a database problem. Name it.
      throw describeSqliteTempDirectoryFailure('forgetting a user', error) ?? error;
    } finally {
      db.exec(`PRAGMA temp_store = ${previousTempStore}`);
    }
    // #303: VACUUM writes its new page images through the WAL, so the checkpoint above (taken
    // before the rebuild) is not enough: the main database file still holds the pre-VACUUM pages
    // until a later checkpoint, and a copy of that file still contains the deleted text.
    db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);

    return { projectId: scope, auditId, deleted };
  }

  getGovernanceAudit(projectId?: string): GovernanceAuditRecord[] {
    const db = this.factStore.getDatabase();
    this.ensureGovernanceAuditTable(db);
    const rows = projectId !== undefined
      ? db.prepare(`
          SELECT *
          FROM governance_audit_log
          WHERE COALESCE(project_id, '') = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(`sha256:${createHash('sha256').update(projectId).digest('hex')}`)
      : db.prepare(`
          SELECT *
          FROM governance_audit_log
          ORDER BY created_at DESC, rowid DESC
        `).all();
    return (rows as Array<{
      audit_id: string;
      action: string;
      project_id?: string | null;
      reason?: string | null;
      details_json?: string | null;
      created_at: number;
    }>).map((row) => ({
      auditId: row.audit_id,
      action: row.action,
      projectId: projectId ?? row.project_id ?? undefined,
      reason: row.reason || undefined,
      details: row.details_json ? JSON.parse(row.details_json) : undefined,
      createdAt: Number(row.created_at),
    }));
  }

  /**
   * Correct a life-sensitivity mark (#164). `daily` releases a false positive; `private` / `high`
   * adds a mark to a missed turn; `null` restores the write-time judgment.
   *
   * Reads are uncached, so the next recall or surfacing query sees the correction.
   */
  correctLifeSensitivity(eventId: string, tier: LifeSensitivityTier | null): { eventId: string; tier: LifeSensitivityTier | null } {
    if (!this.eventStore.correctLifeSensitivity(eventId, tier)) throw new Error('event_unknown');
    return { eventId, tier };
  }

  registerExtension(name: string, implementation: unknown): void {
    this.extensions.set(name, implementation);
    if (name === 'relationStore') {
      const store = implementation as GraphEdgeStoreLike;
      if (store.getDatabase() !== this.episodeStore.getDatabase()) throw new Error('relation_store_database_mismatch');
      this.deepWritePromotionPolicy.setRelationStore(store);
    }
  }

  hasExtension(name: string): boolean {
    return this.extensions.has(name);
  }

  getExtension<T = unknown>(name: string): T | undefined {
    return this.extensions.get(name) as T | undefined;
  }

  private getEmbeddingDimension(): number {
    return this.embeddingProvider?.dimensions ?? config.vector.dimension;
  }

  /**
   * Shared-memory methods for surfaces (host plugins via the public entry, the internal import bridge).
   *
   * Every method takes the caller's host identity explicitly, and each surface fills it from its
   * authenticated channel (the credentialed connection's identity, the bridge's configured agent):
   * sharing must never trust an identity the caller typed into a request (ADR-0006).
   *
   * Writes are refused while `[shared] enabled` is off, so a default install cannot share by accident;
   * reads return nothing in that state rather than throwing, because a read that finds nothing is a
   * normal outcome and an exception is not.
   */
  /** The vocabulary compilation uses, and where it came from (#132) — `doctor` reports the latter. */
  get taxonomy(): MemoryTaxonomy { return this.taxonomyResolution.taxonomy; }

  get taxonomyStatus(): TaxonomyResolution { return this.taxonomyResolution; }

  /** The language this project reads host-facing vocabulary in (#135). */
  get projectLanguage(): string | undefined { return this.language; }

  /** Whether the read-time phase projection is applied to the default lane (#130). Off by default. */
  get phaseProjectionEnabled(): boolean { return this.phaseProjection; }

  get sharedEnabled(): boolean {
    return this.options.sharedEnabled === true;
  }

  /** Publish items into shared collections. The first publisher of a collection becomes its owner. */
  async publishShared(items: SharedItem[]): Promise<number> {
    if (!this.sharedEnabled) throw new Error('shared_disabled');
    return this.sharedMemory.publish(items);
  }

  async retractShared(retraction: SharedRetraction): Promise<void> {
    if (!this.sharedEnabled) throw new Error('shared_disabled');
    return this.sharedMemory.retract(retraction);
  }

  async grantSharedReader(collection: string, readerHost: string, actorHost: string): Promise<void> {
    if (!this.sharedEnabled) throw new Error('shared_disabled');
    return this.sharedMemory.grantReader(collection, readerHost, actorHost);
  }

  async revokeSharedReader(collection: string, readerHost: string, actorHost: string): Promise<void> {
    if (!this.sharedEnabled) throw new Error('shared_disabled');
    return this.sharedMemory.revokeReader(collection, readerHost, actorHost);
  }

  /** Authorized in the adapter; an unauthorized collection is simply absent from the result. */
  async subscribeShared(collections: string[], readerHost: string | undefined, options: { limit?: number } = {}): Promise<SharedItem[]> {
    if (!this.sharedEnabled) return [];
    return this.sharedMemory.subscribe(collections, { readerHost, limit: options.limit });
  }

  /** Synchronous subscribe for recall, which cannot await. Same authorization, same code path. */
  subscribeSharedSync(collections: string[], readerHost: string | undefined, options: { limit?: number } = {}): SharedItem[] {
    if (!this.sharedEnabled) return [];
    return this.sharedMemory.subscribeSync(collections, { readerHost, limit: options.limit });
  }

  /**
   * How many shared items one recall may add. Unset means the derived default (a third of the
   * injection limit), which the recall lane computes; a number here is the fitted value.
   */
  get sharedRecallLimit(): number | undefined {
    return this.options.sharedRecallLimit;
  }

  async explainShared(itemHash: string): Promise<{ item: SharedItem; retractedAt: number | null } | null> {
    return this.sharedMemory.explain(itemHash);
  }

  async listSharedCollections(): Promise<SharedCollection[]> {
    return this.sharedMemory.listCollections();
  }

  /** Synchronous listing for recall, which cannot await. Same rows as the async form. */
  listSharedCollectionsSync(): SharedCollection[] {
    return this.sharedMemory.listCollectionsSync();
  }

  /**
   * Import state for one project: every registered source with its path, adapter kind, last processed
   * timestamp and how many records it has already ingested, newest first.
   *
   * On the kernel rather than behind a protocol tool (#63): the OpenClaw plugin loads the public
   * entry and builds its API from `createMemoryKernelFromConfig`, so a capability that exists only as
   * a protocol tool is one the automatic path cannot ask about. Read-only, so it carries no new authority.
   */
  importStatus(projectId: string, options: { limit?: number } = {}): {
    projectId: string;
    sources: Array<Record<string, unknown>>;
    totalSources: number;
    returnedSources: number;
    limit: number;
  } {
    const requested = options.limit;
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
      throw new Error('limit must be a positive integer');
    }
    const limit = requested ?? 50;
    const cursors = this.cursorStore.listRegisteredSources().filter((cursor) => cursor.projectId === projectId);
    const processed = cursors.map((cursor) => {
      const hashes = this.cursorStore.listProcessedRecordHashes(
        cursor.sourceId, cursor.contentWindowStart || 0, cursor.contentWindowEnd || 0, projectId,
      );
      return {
        sourceId: cursor.sourceId,
        sourcePath: cursor.sourcePath,
        sourceType: cursor.sourceType,
        lastProcessedAt: cursor.lastProcessedAt,
        lastSeenHash: cursor.lastSeenHash,
        lastSeenMtime: cursor.lastSeenMtime,
        contentWindowStart: cursor.contentWindowStart,
        contentWindowEnd: cursor.contentWindowEnd,
        processedRecordCount: hashes.size,
      };
    });
    // listRegisteredSources() is ordered updated_at DESC, source_id ASC, so slicing is stable and the
    // newest sources are the ones a caller with a small limit sees.
    const sources = processed.slice(0, limit);
    return { projectId, sources, totalSources: cursors.length, returnedSources: sources.length, limit };
  }
}

/**
 * SQLite creates the database file but not its parent directories, so a
 * `--db` pointing at a fresh path failed with `unable to open database file`
 * on any machine that had not created that path yet.
 */
function ensureDatabaseDirectory(dbPath?: string): void {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return;
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
}

export function createMemoryKernel(options: MemoryKernelOptions = {}): MemoryKernel {
  ensureDatabaseDirectory(options.dbPath);
  return new MemoryKernel(options);
}

export function createMemoryKernelFromConfig(configPath?: string): MemoryKernel;
export function createMemoryKernelFromConfig(options?: MemoryKernelFromConfigOptions): MemoryKernel;
export function createMemoryKernelFromConfig(input: string | MemoryKernelFromConfigOptions = {}): MemoryKernel {
  return createMemoryKernel(resolveMemoryKernelOptionsFromConfig(input));
}


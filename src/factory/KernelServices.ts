import { cliArg } from '../utils/CliArgument.js';
import { describeSqliteTempDirectoryFailure } from '../utils/SqliteTempDirectory.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'bun:sqlite';
import type { GraphEdgeStoreLike } from '../types/ExtensionPoints.js';

import { BeliefStore } from '../belief/BeliefStore.js';
import { stageFrameRelationCandidates } from '../belief/FrameRelationBeliefs.js';
import { BeliefGovernanceService } from '../belief/BeliefGovernanceService.js';
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
} from '../binding/index.js';
import { IngestionCursorStore } from '../batch/IngestionCursorStore.js';
import { NeuronFactory } from '../core/Neuron.js';
import { AtlasPathRetriever, MultidimensionalQueryPlanner } from '../recall/index.js';
import { ConsolidationPipeline } from '../engine/ConsolidationPipeline.js';
import { DeepWritePromotionPolicy, type DeepWritePromotionDecision } from '../engine/DeepWritePromotionPolicy.js';
import { DreamCuratorWorker, type DreamCuratorRunOptions, type DreamCuratorRunResult } from '../engine/DreamCuratorWorker.js';
import { EntityResolutionEngine } from '../engine/EntityResolutionEngine.js';
import { FactCompiler } from '../engine/FactCompiler.js';
import { InteractionBinder } from '../engine/InteractionBinder.js';
import { LocalSemanticCompiler } from '../engine/LocalSemanticCompiler.js';
import { PipelineMetrics } from '../engine/PipelineMetrics.js';
import type { EmbeddingProvider } from '../embedding/EmbeddingProvider.js';
import { EventEmbeddingStore } from '../embedding/EventEmbeddingStore.js';
import type { EncryptionProvider } from '../encryption/index.js';
import { TopicAliasRegistry, TopicGovernance, TopicPathRegistry as UserTopicPathRegistry, TopicRelationGraph } from '../topic/index.js';
import { CorrectionResolver } from '../episode/CorrectionResolver.js';
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
} from '../governance/index.js';

import { installRuntimeProvenanceGuards } from '../migrations/v3_7_4/FinalRuntimeGuards.js';
import {
  LATEST_SCHEMA_VERSION,
  assertSupportedDatabase,
  createFinalSchema,
  hasUserSchema,
} from '../migrations/v3_7_4/FinalSchema.js';
import { ensureUsableTempSpace } from '../utils/SqliteTempDirectory.js';
import { EntityGovernanceService } from '../entity/index.js';
import { DEFAULT_RHYTHM_SAMPLE_DAYS, TemporalMemoryService, WakeIntentionService, WakeScheduler, computeTemporalContext, evaluateDreamWindow as evaluateDreamWindowAt, type DreamWindow, type DreamWindowEvaluation, type TemporalAnchor, type TemporalContext, type WakeTickInput, type WakeTickResult } from '../temporal/index.js';
import { ConversationCaptureService, type ConversationTurnInput, type ConversationTurnQuery, type ConversationTurnRecord } from '../conversation/index.js';
import { SessionContextService, type SessionContextItem } from '../session/index.js';
import { PersonDirectory } from '../person/index.js';
import { ProfileCompiler } from '../profile/index.js';
import { SurfacingCandidates, SurfacingFeedback } from '../surfacing/index.js';
import { OccasionScope } from '../occasion/index.js';
import { DeliveryRouter } from '../delivery/index.js';
import { ProcedureCompiler } from '../procedure/index.js';
import { CommitmentBook, type CommitmentEntry } from '../commitment/index.js';
import { IntentionBook } from '../intention/index.js';
import { SoulService } from '../soul/index.js';
import { ContextCortex } from '../context/index.js';
import { ProspectiveMemoryService, type ProspectiveMemoryRecord } from '../prospective/index.js';
import type { AgentTurnReceiptAction } from '../agent/AgentMemoryTypes.js';
import { KernelEventStream, ledgerAppendEvent } from '../events/index.js';
import { ContextOutcomeStore, MemoryUseJudge, StrategyCortex } from '../strategy/index.js';
import { EpisodeAssembler, EpisodeStore, type EpisodeBoundaryDecisionRecord, type EpisodeClosureMode, type EpisodeClosureReceipt, type EpisodeDreamStatus, type EpisodeListOptions, type MemoryEpisode, type TurnRelationAdvisoryReviewer } from '../episode/index.js';
import { EpisodeBoundaryAuditService, type EpisodeBoundaryAuditResult } from '../episode/EpisodeBoundaryAuditService.js';
import { localDateFor, resolveProjectClockContext, type ProjectClockContext } from '../utils/LocalDateContext.js';
import { EpisodeBoundaryPolicy, normalizeEpisodeBoundaryConfig, type EpisodeBoundaryConfig } from '../episode/EpisodeBoundaryPolicy.js';
import { logicalTurnsFromPairs } from '../episode/EpisodeBoundaryReplayEngine.js';
import { EpisodeSplitPlanner, type EpisodeSplitPlan } from '../episode/EpisodeSplitPlanner.js';
import { DreamScheduler, type DreamTickOptions, type DreamTickResult } from '../dream/index.js';
import {
  loadCogmemConfig,
  resolveCogmemConfigPath,
  type EnvLike,
  type ConfigDiagnosticLike,
} from '../config/CogmemConfig.js';
import { ModelRegistry } from '../models/ModelRegistry.js';
import { DeepWriteCandidateStore, type DeepWriteCandidateStatus } from '../store/DeepWriteCandidateStore.js';
import { CandidateReviewStore, type CandidateReviewRecord } from '../store/CandidateReviewStore.js';
import { reviewKernelCommitmentReceipt } from '../store/CommitmentReceiptReview.js';
import { CompilerConfidenceStore } from '../store/CompilerConfidenceStore.js';
import { DreamLedgerStore, type DreamBacklogStatus } from '../store/DreamLedgerStore.js';
import { EntityStore } from '../store/EntityStore.js';
import { EventStore, type RawEventOrder } from '../store/EventStore.js';
import { FactStore } from '../store/FactStore.js';
import { InteractionUnitStore } from '../store/InteractionUnitStore.js';
import { MemoryBindingStore } from '../store/MemoryBindingStore.js';
import { MemoryAtlasStore } from '../store/MemoryAtlasStore.js';
import { MemoryFrameStore, frameSourceFingerprint } from '../store/MemoryFrameStore.js';
import { deterministicFrameFallback } from '../semantic/DeterministicFrameFallback.js';
import type { MemoryFrameV1 } from '../semantic/MemoryFrameTypes.js';
import {
  MemoryAtlasIndexer,
  MemoryAtlasService,
  type MemoryAtlasNodeDetail,
  type MemoryAtlasPathResult,
  type MemoryAtlasQueryOptions,
  type MemoryAtlasSlice,
  type MemoryAtlasTimelineResult,
} from '../atlas/index.js';
import { MemoryGovernanceStore } from '../store/MemoryGovernanceStore.js';
import { SummaryStore } from '../store/SummaryStore.js';
import { matchesProjectScope, projectScope } from '../topology/ProjectScope.js';
import { deleteRegisteredProjectContent, deleteResidualProjectOwnedContent } from '../governance/PrivacyDeletionRegistry.js';
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
} from '../types/index.js';
import { config } from '../utils/Config.js';
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
} from '../snapshot/index.js';
import { HealthService } from '../health/index.js';
import { CORE_VERSION } from '../version.js';
import { SqliteSharedMemory } from '../adapters/sqlite/SqliteSharedMemory.js';
import type { SharedCollection, SharedItem, SharedRetraction } from '../ports/index.js';
import { DEFAULT_TAXONOMY, type MemoryTaxonomy, type TaxonomyResolution } from '../config/MemoryTaxonomy.js';
import { setConfiguredLanguage } from '../config/LanguagePacks.js';
import { secretFindingsMetadata } from '../security/SecretPatterns.js';
import { lifeSensitivityMetadata, type LifeSensitivityTier } from '../security/LifeSensitivity.js';
import { MemorySovereigntyService } from '../sovereignty/index.js';
import type { MemoryKernelOptions, RawMemoryEventInput } from './KernelOptions.js';
import {
  eventPayloadText,
  optionalGovernancePayloadNumber,
  optionalGovernancePayloadString,
  requiredGovernancePayloadString,
} from './KernelSupport.js';

export abstract class KernelServices {
  abstract recordRawEvent(input: RawMemoryEventInput): MemoryEvent<{ text: string; metadata?: Record<string, unknown> }>;
  abstract assembleEpisodeTurn(
    events: MemoryEvent[],
    input: {
      projectId: string; sessionId: string; sourceAgent?: string; conversationThreadId?: string;
      now?: number; batchSeal?: boolean; forceBatchSeal?: boolean; allowNonUserEpisodeStart?: boolean;
    },
  ): unknown;

  readonly eventStore: EventStore;
  readonly events: KernelEventStream;
  readonly factStore: FactStore;
  readonly entityStore: EntityStore;
  readonly entityGovernanceService: EntityGovernanceService;
  readonly beliefStore: BeliefStore;
  readonly beliefGovernanceService: BeliefGovernanceService;
  readonly temporalMemoryService: TemporalMemoryService;
  readonly contextCortex: ContextCortex;
  readonly strategyCortex: StrategyCortex;
  readonly memoryUseJudge: MemoryUseJudge;
  readonly contextOutcomeStore: ContextOutcomeStore;
  readonly prospectiveMemoryService: ProspectiveMemoryService;
  readonly receiptsEnabled: boolean;
  readonly wakeIntentions: WakeIntentionService;
  readonly wakeScheduler: WakeScheduler;
  readonly conversationCapture: ConversationCaptureService;
  readonly sessionContext: SessionContextService;
  readonly persons: PersonDirectory;
  readonly profile: ProfileCompiler;
  readonly procedures: ProcedureCompiler;
  readonly commitments: CommitmentBook;
  readonly intentions: IntentionBook;
  readonly sovereignty: MemorySovereigntyService;
  readonly soul: SoulService;
  /**
   * The surfacing candidate query: the kernel's half of emergence, with deterministic sensitivity
   * grading. The shell decides whether to speak. Contract: `docs/surfacing-candidates.md`.
   */
  readonly surfacing: SurfacingCandidates;
  /**
   * Channel → occasion bindings (#162). A host registers once per connection; recall and
   * surfacing resolve the occasion from that registration, never from the call. Contract:
   * `docs/occasion-scope.md`.
   */
  readonly occasionScope: OccasionScope;
  /**
   * The owner's feedback on surfaced candidates and the deterministic modulation it applies to the
   * proactive channel (#161). Contract: `docs/surfacing-feedback.md`.
   */
  readonly surfacingFeedback: SurfacingFeedback;
  /**
   * The deterministic last mile between F6's candidates and F12's channels (#195, F18). It reads
   * the candidate, occasion, user state, channel and F7 level, and returns a traced decision.
   * Contract: `docs/delivery-routing.md`.
   */
  readonly deliveryRouter: DeliveryRouter;
  /**
   * The kernel's own condition (#196, F19): model route, Dream streak, database writability and
   * integrity, with one recorded transition per change. Contract: `docs/health-backup.md`.
   */
  readonly health: HealthService;
  /**
   * The nightly whole-brain snapshot and the machine-restorable bundle (#196, F19). It reuses the
   * one `.snap` DB copy and adds a manifest. Contract: `docs/health-backup.md`.
   */
  readonly backup: BrainBackup;
  /** The machine-restorable moving bundle: the same DB copy with its manifest in front (#196). */
  readonly bundle: BrainBundle;
  readonly cursorStore: IngestionCursorStore;
  readonly dreamLedgerStore: DreamLedgerStore;
  readonly memoryBindingStore: MemoryBindingStore;
  readonly memoryAtlasStore: MemoryAtlasStore;
  readonly memoryFrameStore: MemoryFrameStore;
  readonly memoryAtlasService: MemoryAtlasService;
  /** Shared region between hosts. Reads are authorized in the adapter; writes need the switch on. */
  readonly sharedMemory: SqliteSharedMemory;
  readonly multidimensionalQueryPlanner: MultidimensionalQueryPlanner;
  readonly memoryGovernanceStore: MemoryGovernanceStore;
  readonly memoryGovernanceExecutor: MemoryGovernanceExecutor;
  readonly pipelineMetrics: PipelineMetrics;
  readonly eventEmbeddingStore: EventEmbeddingStore;
  readonly episodeStore: EpisodeStore;
  readonly episodeAssembler: EpisodeAssembler;
  readonly episodeBoundaryPolicy: EpisodeBoundaryPolicy;
  readonly episodeBoundaryAuditService: EpisodeBoundaryAuditService;
  readonly episodeSplitPlanner: EpisodeSplitPlanner;
  readonly userTopicPathRegistry: UserTopicPathRegistry;
  readonly topicAliasRegistry: TopicAliasRegistry;
  readonly topicRelationGraph: TopicRelationGraph;
  readonly topicGovernance: TopicGovernance;
  readonly configDiagnostics: ConfigDiagnosticLike[];

  protected readonly dbPath: string;
  protected readonly projectClock: ProjectClockContext;

  /**
   * The file backing this kernel, so a read-only surface can open its own connection to the same
   * data instead of borrowing this one. `:memory:` has no second connection to open.
   */
  get databasePath(): string {
    return this.dbPath;
  }

  protected readonly embeddingProvider?: EmbeddingProvider;
  protected readonly modelRegistry: ModelRegistry;
  protected readonly encryptionProvider?: EncryptionProvider;
  protected readonly piiRedactor?: PiiRedactor;
  protected readonly interactionUnitStore: InteractionUnitStore;
  protected readonly compilerConfidenceStore: CompilerConfidenceStore;
  protected readonly summaryStore: SummaryStore;
  protected readonly deepWriteCandidateStore: DeepWriteCandidateStore;
  protected readonly deepWritePromotionPolicy: DeepWritePromotionPolicy;
  protected readonly candidateReviewStore: CandidateReviewStore;
  protected readonly candidateReviewService: CandidateReviewService;
  protected readonly dreamCuratorWorker: DreamCuratorWorker;
  protected readonly dreamScheduler: DreamScheduler;
  protected readonly memoryBindingService: MemoryBindingService;
  protected readonly memoryAtlasIndexer: MemoryAtlasIndexer;
  protected readonly atlasPathRetriever: AtlasPathRetriever;
  protected readonly localSemanticCompiler: LocalSemanticCompiler;
  protected readonly consolidationPipeline: ConsolidationPipeline;
  protected readonly extensions = new Map<string, unknown>();
  protected readonly taxonomyResolution: TaxonomyResolution;
  protected readonly language?: string;
  protected readonly phaseProjection: boolean;
  protected initialized = false;
  protected closed = false;

  constructor(protected readonly options: MemoryKernelOptions = {}) {
    this.configDiagnostics = [...(options.configDiagnostics || [])];
    const normalizedBoundary = normalizeEpisodeBoundaryConfig(options.episodeBoundary);
    this.configDiagnostics.push(...normalizedBoundary.diagnostics);
    if (options.projectTimeZone && normalizedBoundary.config.timezone && options.projectTimeZone !== normalizedBoundary.config.timezone) throw new Error('project_timezone_conflict');
    this.projectClock = resolveProjectClockContext({ projectTimeZone: options.projectTimeZone ?? normalizedBoundary.config.timezone });
    this.receiptsEnabled = options.receiptsEnabled !== false;
    this.taxonomyResolution = options.taxonomy ?? { taxonomy: DEFAULT_TAXONOMY, source: 'default', reasons: [] };
    this.language = options.language;
    this.phaseProjection = options.phaseProjectionEnabled === true;
    // The social gate and the inlined gate source read this at call time, so a project that declares its
    // language classifies its turns with that language's vocabulary (#135).
    setConfiguredLanguage(this.language);
    this.dbPath = options.dbPath ?? ':memory:';
    this.encryptionProvider = options.encryptionProvider;
    this.piiRedactor = options.redactionPolicy === false ? undefined : new PiiRedactor(options.redactionPolicy);

    // File-backed databases migrate before any Store can inspect an old table.
    // `:memory:` must migrate on the connection retained by FactStore.
    const migrateAfterCoreBootstrap = this.dbPath === ':memory:';
    if (!migrateAfterCoreBootstrap) {
      const migrationDb = new Database(this.dbPath);
      try {
        migrationDb.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        if (hasUserSchema(migrationDb)) {
          // 4.0 creates this file or refuses it; it never upgrades one. See
          // ADR-0007, and `assertSupportedDatabase` for what a refusal says.
          assertSupportedDatabase(migrationDb);
        } else {
          // Dropped first because a creation that was interrupted leaves this
          // marker behind, and `hasUserSchema` deliberately treats that as a new
          // database rather than as someone else's file.
          migrationDb.exec(`
            DROP TABLE IF EXISTS _cogmem_bootstrap_state;
            CREATE TABLE _cogmem_bootstrap_state (
              singleton INTEGER PRIMARY KEY CHECK(singleton=1),
              started_at INTEGER NOT NULL
            );
            INSERT INTO _cogmem_bootstrap_state(singleton,started_at) VALUES(1,unixepoch()*1000);
          `);
          createFinalSchema(migrationDb);
        }
      } finally {
        migrationDb.close();
      }
    }

    this.factStore = new FactStore(this.dbPath, this.encryptionProvider);
    const db = this.factStore.getDatabase();
    ensureUsableTempSpace(db);
    this.events = new KernelEventStream();
    this.eventStore = new EventStore(db, this.encryptionProvider, this.projectClock.timeZone);
    // Every ledger write routes through this store, so this one hook is the whole ledger-append
    // producer. It is registered before any of the kernel's own bootstrap appends.
    this.eventStore.onAppend((event) => this.events.emit(ledgerAppendEvent(event)));
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if ((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined)?.foreign_keys !== 1) {
      throw new Error('memory_kernel_foreign_keys_disabled');
    }
    // A read-only temporary directory makes an ordinary append fail with a message
    // that blames the database; where the directory is unusable, this connection
    // keeps its temporary space in memory instead. Where it is usable, nothing
    // changes.
    ensureUsableTempSpace(db);
    if (migrateAfterCoreBootstrap) {
      db.exec(`
        CREATE TABLE _cogmem_bootstrap_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          started_at INTEGER NOT NULL
        );
        INSERT INTO _cogmem_bootstrap_state(singleton,started_at) VALUES(1,unixepoch()*1000);
      `);
      createFinalSchema(db);
    }
    // Built after the schema phase on purpose: `createFinalSchema` detaches every view, trigger and
    // index it does not own and replays them afterwards, so a shared index created before it would be
    // saved and replayed against a table the final schema does not contain. Same connection as the
    // kernel (ADR-0004: the bridge/kernel holds the only one), tables created IF NOT EXISTS, so a 4.0
    // database opens unchanged and its version marker stays put — no migration.
    this.sharedMemory = new SqliteSharedMemory(db);
    this.entityStore = new EntityStore(db);
    this.ensureGovernanceAuditTable(db);
    this.soul = new SoulService(db);
    const vectorDimension = config.vector.dimension;
    this.modelRegistry = options.modelRegistry ?? ModelRegistry.defaults();
    this.beliefStore = new BeliefStore(db, this.eventStore);
    this.beliefGovernanceService = new BeliefGovernanceService(db, (eventId) => {
      const event = this.eventStore.getEvent(eventId);
      return event ? { eventId, projectId: event.projectId, role: event.role } : undefined;
    });
    this.temporalMemoryService = new TemporalMemoryService(db);
    this.contextCortex = new ContextCortex(db);
    this.strategyCortex = new StrategyCortex();
    this.memoryUseJudge = new MemoryUseJudge();
    this.contextOutcomeStore = new ContextOutcomeStore(db);
    this.prospectiveMemoryService = new ProspectiveMemoryService(db, (eventId) => {
      const event = this.eventStore.getEvent(eventId);
      return event ? {
        eventId,
        projectId: event.projectId,
        role: event.role,
        globalSeq: event.globalSeq,
        content: eventPayloadText(event.payload),
      } : undefined;
    });
    // The time-awareness face (F2 of #156): ledger-backed intentions, then the tick that fires them
    // and announces due prospective memories. Both take `now`; neither holds a timer.
    this.wakeIntentions = new WakeIntentionService(this.eventStore);
    this.wakeScheduler = new WakeScheduler({
      events: this.events,
      wakeIntentions: this.wakeIntentions,
      prospectiveMemories: this.prospectiveMemoryService,
    });
    // The conversation capture face (#157). Its ports are closured kernel calls rather than the
    // kernel object, so the service module does not import `factory.ts`. Contract:
    // `docs/conversation-capture.md`.
    this.conversationCapture = new ConversationCaptureService(db, {
      recordTurn: (input) => this.recordRawEvent(input),
      nextTurnSeq: (threadId, projectId) => this.eventStore.getNextTurnSeq(threadId, projectId),
      assembleTurn: (events, context) => {
        try {
          this.assembleEpisodeTurn(events, {
            projectId: context.projectId,
            sessionId: context.sessionId,
            sourceAgent: context.sourceAgent,
            conversationThreadId: context.conversationThreadId,
            now: context.now,
          });
        } catch (error) {
          // Episode assembly is an organizational index; the ledger row is already authoritative.
          this.pipelineMetrics.recordNonFatal('episode_assembly_failed', {
            projectId: context.projectId,
            message: error instanceof Error ? error.message : String(error),
            details: { eventIds: events.map((event) => event.eventId), sessionId: context.sessionId, lane: 'conversation' },
          });
        }
      },
    });
    this.cursorStore = new IngestionCursorStore(db);
    this.interactionUnitStore = new InteractionUnitStore(db);
    this.compilerConfidenceStore = new CompilerConfidenceStore(db);
    this.dreamLedgerStore = new DreamLedgerStore(db);
    this.episodeStore = new EpisodeStore(db, (eventId) => this.eventStore.getEvent(eventId), { initializeSchemaForTests: false });
    this.episodeBoundaryPolicy = new EpisodeBoundaryPolicy({ ...normalizedBoundary.config, timezone: this.projectClock.timeZone });
    this.episodeBoundaryAuditService = new EpisodeBoundaryAuditService(this.episodeStore, (eventId) => this.eventStore.getEvent(eventId), this.episodeBoundaryPolicy.config, this.configDiagnostics);
    this.episodeSplitPlanner = new EpisodeSplitPlanner(this.episodeStore, (eventId) => this.eventStore.getEvent(eventId), this.episodeBoundaryPolicy.config, this.configDiagnostics);
    this.userTopicPathRegistry = new UserTopicPathRegistry(db);
    this.topicAliasRegistry = new TopicAliasRegistry(db);
    this.topicRelationGraph = new TopicRelationGraph(db);
    this.topicGovernance = new TopicGovernance(db, this.userTopicPathRegistry, this.topicAliasRegistry, this.topicRelationGraph);
    this.episodeAssembler = new EpisodeAssembler(
      this.episodeStore,
      (eventId) => this.eventStore.getEvent(eventId),
      30 * 60_000,
      options.turnRelationReviewer,
      (primary, episode) => {
        const text = eventPayloadText(primary.payload);
        const matches = this.topicAliasRegistry.matchText(primary.projectId || '', text || '');
        if (!matches.length) return {};
        const matchedPaths = [...new Set(matches
          .map((match) => this.userTopicPathRegistry.get(match.topicId)?.topicPath)
          .filter((path): path is string => Boolean(path)))];
        return {
          topicPathMatch: Boolean(episode?.topicPath && matchedPaths.includes(episode.topicPath)),
          currentTopicPath: matchedPaths.length === 1 ? matchedPaths[0] : undefined,
        };
      },
      this.episodeBoundaryPolicy,
      this.taxonomyResolution.taxonomy.episodeTypes,
    );
    this.memoryBindingStore = new MemoryBindingStore(db);
    installRuntimeProvenanceGuards(db);
    this.memoryBindingService = new MemoryBindingService(this.memoryBindingStore, this.entityStore);
    this.memoryAtlasStore = new MemoryAtlasStore(db, this.projectClock.timeZone);
    this.memoryFrameStore = new MemoryFrameStore(db, this.taxonomyResolution.taxonomy);
    this.memoryFrameStore.setFrameActiveListener((frame, now) => {
      stageFrameRelationCandidates(this.deepWriteCandidateStore, frame, now);
    });
    this.memoryAtlasIndexer = new MemoryAtlasIndexer(db, this.eventStore, this.memoryAtlasStore, this.memoryFrameStore, this.taxonomyResolution.taxonomy);
    // The person facet reaches the person layer (#214): a query cue that names a person becomes an
    // entity entrance for every name that person answers to, including the ones a merge moved onto
    // the survivor. The closure reads `this.persons` lazily — the person layer is built below, and a
    // query runs long after this constructor finishes.
    this.memoryAtlasService = new MemoryAtlasService(
      this.memoryAtlasStore,
      this.eventStore,
      this.taxonomyResolution.taxonomy,
      (reference, projectId) => {
        try {
          const person = this.persons?.resolvePerson(reference, projectId);
          return person ? [person.canonicalName, ...person.aliases] : undefined;
        } catch (error) {
          // An ambiguous reference is not an entrance: an atlas read does not guess between people.
          // Anything else is a real fault and must stay loud rather than become an empty result.
          if (error instanceof Error && error.message.startsWith('ambiguous_person_reference')) return undefined;
          throw error;
        }
      },
    );
    this.multidimensionalQueryPlanner = new MultidimensionalQueryPlanner();
    this.atlasPathRetriever = new AtlasPathRetriever(this.memoryAtlasService, this.multidimensionalQueryPlanner);
    this.entityGovernanceService = new EntityGovernanceService(
      db,
      this.entityStore,
      (eventId) => {
        const event = this.eventStore.getEvent(eventId);
        return event ? { eventId, projectId: event.projectId, role: event.role } : undefined;
      },
    );
    // The person entity layer (#158). It owns no storage: a person is an `entity_instances` row with
    // `type = 'person'`, and merging rides the governed, audited `entityGovernanceService` above.
    // Contract: `docs/person-entities.md`.
    this.persons = new PersonDirectory({
      entities: this.entityStore,
      governance: this.entityGovernanceService,
      lookupMemory: (eventId) => {
        const event = this.eventStore.getEvent(eventId);
        return event ? { content: eventPayloadText(event.payload) } : null;
      },
    });
    this.profile = new ProfileCompiler({
      events: this.eventStore,
      facts: this.factStore,
      beliefs: this.beliefStore,
      entities: this.entityStore,
      sourceEventOfNeuron: (eventId) => eventId,
      // Every status, so the compiler's own owner-confirmed rule is the one that decides. A pending
      // candidate is not the owner's yet (F2), so it is not an ongoing item.
      listOngoing: (projectId) => this.prospectiveMemoryService.list({
        projectId,
        statuses: ['pending', 'confirmed', 'deferred', 'rejected', 'completed', 'expired'],
        limit: 200,
      }),
      supersedeFrames: (projectId, eventIds, now) => this.memoryFrameStore.supersedeReferencingEvents(projectId, eventIds, now),
    });
    this.surfacingFeedback = new SurfacingFeedback({ events: this.eventStore });
    this.occasionScope = new OccasionScope();
    this.deliveryRouter = new DeliveryRouter(this.surfacingFeedback);
    const brainConfig: BrainConfig = {
      vectorDimension,
      projectTimeZone: this.projectClock.timeZone,
      memoryProvider: this.modelRegistry.getRoleConfig('memory').provider,
      reasoningProvider: this.modelRegistry.getRoleConfig('reasoning').provider,
    };
    this.health = new HealthService({
      db,
      dbPath: this.dbPath,
      events: this.events,
      modelRegistry: this.modelRegistry,
    });
    this.backup = new BrainBackup({
      dbPath: this.dbPath,
      db,
      snapshotsDir: options.snapshotsDir,
      embeddingDimension: vectorDimension,
      coreVersion: CORE_VERSION,
      config: brainConfig,
    });
    this.bundle = new BrainBundle({
      dbPath: this.dbPath,
      embeddingDimension: vectorDimension,
      coreVersion: CORE_VERSION,
      config: brainConfig,
    });
    // The procedure book (#192). Like the profile, it owns no storage: a version is a ledger row.
    // Preferences are read through F5's own recall rather than copied into a second ledger.
    this.procedures = new ProcedureCompiler({
      events: this.eventStore,
      embedding: () => this.embeddingProvider,
      preferences: ({ projectId, query, now, limit }) => this.profile
        .recall({ projectId, query, ledger: 'preferences', now, limit })
        .map((entry) => ({
          entryId: entry.entryId,
          key: entry.key,
          value: entry.value,
          sourceRefs: entry.sourceRefs,
          recordedAt: entry.recordedAt,
        })),
    });
    // The commitment book (#193). Its state is its ledger; recognition is deterministic.
    this.commitments = new CommitmentBook({ events: this.eventStore });
    // The intention ledger (#216). It consumes F16's audit read for conversion and F2's register
    // for scheduling; it writes neither book.
    this.intentions = new IntentionBook({
      events: this.eventStore,
      commitments: this.commitments,
      wakeIntentions: this.wakeIntentions,
    });
    this.sovereignty = new MemorySovereigntyService({
      db,
      events: this.eventStore,
      profile: this.profile,
      procedures: this.procedures,
      commitments: this.commitments,
      intentions: this.intentions,
      snapshotsDir: options.snapshotsDir,
      exportsDir: options.exportsDir ?? (this.dbPath === ':memory:' ? undefined : join(dirname(this.dbPath), 'exports')),
      rebuildAtlas: (projectId) => this.memoryAtlasIndexer.rebuild({ projectId }),
    });
    this.surfacing = new SurfacingCandidates({
      events: this.eventStore,
      profile: this.profile,
      procedures: this.procedures,
      commitments: this.commitments,
      wakeIntentions: this.wakeIntentions,
      prospectiveMemories: this.prospectiveMemoryService,
      occasionScope: this.occasionScope,
      feedback: this.surfacingFeedback,
    });
    // The session-context face (#191). Open loops are read from the services that already own
    // them, so a restart re-surfaces F2 intentions and F6 candidates without the session face
    // importing either module.
    this.sessionContext = new SessionContextService(db, {
      deepGenerate: () => this.modelRegistry.isRuleOnly('memory')
        ? undefined
        : this.modelRegistry.getTextGenerator('memory'),
      openLoops: ({ projectId, agentId, now }) => {
        const items: SessionContextItem[] = [];
        for (const intention of this.wakeIntentions.list({ projectId, agentId, statuses: ['pending'] })) {
          items.push({
            id: `wake:${intention.intentionId}`,
            text: intention.reason,
            sourceRefs: intention.sourceRefs.map((ref) => ref.eventId).filter((id): id is string => Boolean(id)),
            protected: true,
          });
        }
        // The agent's own plans, separate from the promises it owes: active intentions re-enter
        // the wake assembly through the same open-loop port.
        for (const intention of this.intentions.activeForAgent({ projectId, agentId })) {
          items.push({
            id: `intention:${intention.intentionId}`,
            text: `意图：${intention.content}`,
            sourceRefs: intention.sourceRefs.map((ref) => ref.eventId).filter((id): id is string => Boolean(id)),
            protected: true,
          });
        }
        // The agent's own promises, symmetric with the owner's: an arrived one enters its wake
        // context through F14's open-loop port. This read is pure, so waking does not consume the
        // announce-once mark F6 uses.
        for (const commitment of this.commitments.dueForAgent({ projectId, agentId, now })) {
          items.push({
            id: `commitment:${commitment.commitmentId}`,
            text: `承诺：${commitment.content}`,
            sourceRefs: commitment.sourceRefs.map((ref) => ref.eventId).filter((id): id is string => Boolean(id)),
            protected: true,
          });
        }
        try {
          for (const candidate of this.surfacing.candidates({ projectId, channel: 'asked', now }).candidates) {
            if (candidate.source !== 'prospective-memory' && candidate.source !== 'wake-intention') continue;
            if (items.some((item) => item.id === candidate.candidateId)) continue;
            items.push({
              id: candidate.candidateId,
              text: candidate.content,
              sourceRefs: candidate.sourceRefs.map((ref) => ref.eventId).filter((id): id is string => Boolean(id)),
              protected: true,
            });
          }
        } catch {
          // F6 is a pull query over products that may not exist yet; the F2 half still stands.
        }
        return items;
      },
    });
    this.memoryGovernanceStore = new MemoryGovernanceStore(db);
    this.memoryGovernanceExecutor = new MemoryGovernanceExecutor(
      db,
      this.memoryGovernanceStore,
      new MemoryGovernanceValidator((eventId) => {
        const event = this.eventStore.getEvent(eventId);
        return event ? { eventId, projectId: event.projectId, role: event.role } : undefined;
      }),
      {
        BIND_EVENT: (operation) => {
          const eventId = typeof operation.payload.eventId === 'string' ? operation.payload.eventId : operation.evidenceEventIds[0];
          const event = eventId ? this.eventStore.getEvent(eventId) : null;
          if (!event) throw new Error(`BIND_EVENT requires an existing event: ${eventId || 'missing'}`);
          this.memoryBindingService.bindRawEvent(event);
        },
        CREATE_PROSPECTIVE_MEMORY: (operation, context) => {
          const projectId = operation.projectId ?? context.plan.projectId;
          if (!projectId) throw new Error('CREATE_PROSPECTIVE_MEMORY requires projectId');
          this.prospectiveMemoryService.propose({
            projectId,
            candidateType: operation.payload.candidateType as never,
            canonicalKey: requiredGovernancePayloadString(operation.payload, 'canonicalKey'),
            title: requiredGovernancePayloadString(operation.payload, 'title'),
            details: optionalGovernancePayloadString(operation.payload, 'details'),
            evidenceEventIds: operation.evidenceEventIds,
            proposedBy: context.plan.proposedBy,
            dueAt: optionalGovernancePayloadNumber(operation.payload, 'dueAt'),
          });
        },
        RESOLVE_PROSPECTIVE_MEMORY: (operation) => {
          const projectId = operation.projectId;
          if (!projectId) throw new Error('RESOLVE_PROSPECTIVE_MEMORY requires projectId');
          const candidateId = requiredGovernancePayloadString(operation.payload, 'candidateId');
          const action = requiredGovernancePayloadString(operation.payload, 'action');
          if (action === 'confirm') {
            const confirmationEvidenceEventId = requiredGovernancePayloadString(operation.payload, 'confirmationEvidenceEventId');
            if (!operation.evidenceEventIds.includes(confirmationEvidenceEventId)) {
              throw new Error('confirmation evidence must be included in governance operation evidence');
            }
            this.prospectiveMemoryService.resolve(candidateId, {
              action,
              confirmationEvidenceEventId,
            }, projectId);
          } else if (action === 'defer') {
            const deferredUntil = optionalGovernancePayloadNumber(operation.payload, 'deferredUntil');
            if (deferredUntil === undefined) throw new Error('RESOLVE_PROSPECTIVE_MEMORY defer requires deferredUntil');
            this.prospectiveMemoryService.resolve(candidateId, { action, deferredUntil }, projectId);
          } else if (action === 'reject' || action === 'complete' || action === 'expire') {
            this.prospectiveMemoryService.resolve(candidateId, { action }, projectId);
          } else {
            throw new Error(`invalid_prospective_memory_action:${action}`);
          }
        },
      },
    );
    this.pipelineMetrics = new PipelineMetrics(db);
    this.summaryStore = new SummaryStore(db);
    this.eventEmbeddingStore = new EventEmbeddingStore(db, options.semanticRelativeThreshold);
    this.summaryStore.migrateLegacyFactSummaries();
    this.deepWriteCandidateStore = new DeepWriteCandidateStore(db);
    this.dreamCuratorWorker = new DreamCuratorWorker({
      taxonomy: this.taxonomyResolution.taxonomy,
      eventStore: this.eventStore,
      dreamLedgerStore: this.dreamLedgerStore,
      candidateStore: this.deepWriteCandidateStore,
      modelRegistry: this.modelRegistry,
      pipelineMetrics: this.pipelineMetrics,
      correctionResolver: new CorrectionResolver(({ projectId, query, entities, limit }) => (
        this.beliefStore.getActiveBeliefsForQuery({ projectId, query, entities, limit }).map((belief) => ({
          beliefId: belief.id, canonicalKey: belief.canonicalKey,
          statement: `${belief.subject} ${belief.predicate} ${String(belief.objectValue)}`, projectId: belief.projectId,
        }))
      )),
      memoryFrameStore: this.memoryFrameStore,
    });
    this.dreamScheduler = new DreamScheduler(this.episodeStore, this.dreamCuratorWorker, this.deepWriteCandidateStore, this.memoryFrameStore);
    this.localSemanticCompiler = new LocalSemanticCompiler();
    this.embeddingProvider = options.embeddingProvider;
    this.deepWritePromotionPolicy = new DeepWritePromotionPolicy({
      candidateStore: this.deepWriteCandidateStore,
      factStore: this.factStore,
      entityStore: this.entityStore,
      beliefStore: this.beliefStore,
      summaryStore: this.summaryStore,
      minPromoteConfidence: 0.86,
    });
    this.candidateReviewStore = new CandidateReviewStore(db);
    this.candidateReviewService = new CandidateReviewService(
      db,
      this.deepWriteCandidateStore,
      this.candidateReviewStore,
      this.deepWritePromotionPolicy,
      (eventId) => this.eventStore.getEvent(eventId),
    );
    this.consolidationPipeline = new ConsolidationPipeline(
      this.beliefStore,
      new InteractionBinder(this.interactionUnitStore),
      new FactCompiler(this.factStore, this.entityStore),
      this.localSemanticCompiler,
      this.factStore,
      this.entityStore,
      this.compilerConfidenceStore,
      undefined
    );
    this.ensureMetaTable(db);
  }

  reviewCommitmentReceipt(input: {
    projectId: string;
    sourceEventId: string;
    action: AgentTurnReceiptAction;
    actor?: string;
    content?: string;
    dueAt?: number;
    now?: number;
    surface?: string;
  }): { review: CandidateReviewRecord; commitment?: CommitmentEntry; intention?: ProspectiveMemoryRecord } {
    const projectId = input.projectId.trim();
    if (!projectId) throw new Error('project_id_required');
    return reviewKernelCommitmentReceipt({
      events: this.eventStore,
      commitments: this.commitments,
      prospective: this.prospectiveMemoryService,
      review: this.candidateReviewService,
    }, { ...input, projectId, actor: input.actor ?? 'owner' });
  }

  protected ensureMetaTable(db: ReturnType<FactStore['getDatabase']>): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const write = db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`);
    write.run('schema_version', String(LATEST_SCHEMA_VERSION));
    write.run('core_version', CORE_VERSION);
  }

  protected ensureGovernanceAuditTable(db: ReturnType<FactStore['getDatabase']>): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS governance_audit_log (
        audit_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        project_id TEXT,
        reason TEXT,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_governance_audit_project
        ON governance_audit_log(project_id, created_at DESC);
    `);
  }
}

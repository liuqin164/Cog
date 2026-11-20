/**
 * Assembly: the three core pieces (state machine, plugin host, kernel connection) wired to the
 * plugins that carry every capability.
 *
 * The app is also the only place that knows the transition triggers' meanings — a message wakes the
 * shell, a due intent re-injects the clock, the cage's overrun leaves RUNNING. Plugins decide
 * behaviour; the app decides which transition that behaviour is.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelContract, createMemoryKernel, digestAnchors, KernelAgentMemoryBackend, readSessionToolCalls, readSessionTurns, type ChannelSession, type DeliveryCandidateInput, type EmbeddingProvider, type MemoryKernel, type SessionContextAssembly, type SessionContextItem, type SessionDigestEntry, type SessionToolCall, type SessionTurn, type SurfacingSource } from 'cogmem';
import { ModelRegistry, type ModelRoleConfig, type ModelRoleName, type ModelTextUsage } from 'cogmem/internal';
import { defaultShellConfig, type ShellConfig } from './config.ts';
import { StateMachine } from './state/machine.ts';
import { CheckpointStore, type InFlightToolCall } from './state/checkpoint.ts';
import { ShellStateLedger } from './state/state-ledger.ts';
import type { Trigger } from './state/table.ts';
import { ProcessLock } from './process-lock.ts';
import { TraceLog } from './trace.ts';
import { PluginHost } from './plugins/host.ts';
import { clockPlugin, ClockService } from './plugins/clock.ts';
import { providedModelPlugin } from './plugins/mg-provider.ts';
import { ModelRouter, modelRouterPlugin, routeLine } from './model/router.ts';
import { BUILTIN_ROUTE_NAME, RouteStore, redactUrl, type ModelRoute } from './model/routes.ts';
import { cagePlugin, RunCage, type CageTier } from './plugins/cage.ts';
import { builtinToolsPlugin } from './plugins/builtin-tools.ts';
import { coreCommandFor, availableCoreCommand, unknownCommandReply, type CommandHost, type CommandReply } from './commands.ts';
import { proposalPlugin } from './plugins/proposal.ts';
import { askPlugin } from './plugins/ask.ts';
import { CommandProposals, executeProposal, isProposableCommand, type CommandProposal, type ProposalConfirmation } from './proposals.ts';
import { capturePlugin } from './plugins/capture.ts';
import { sessionContextPlugin } from './plugins/session-context.ts';
import { assignmentPlugin } from './plugins/assignment.ts';
import { memoryToolPlugin } from './plugins/memory-tool.ts';
import { soulEditPlugin } from './plugins/soul-edit.ts';
import { dreamPlugin } from './plugins/dream.ts';
import { emergencePlugin } from './plugins/emergence.ts';
import { terminalPlugin, TerminalChannel, type ShellControl } from './channels/terminal.ts';
import { AgentRuntime, type AgentMessage, type ModelProvider, type RunSummary } from './state/agent-loop.ts';
import type { ToolOutputAccount } from './state/context-budget.ts';
import { laneAssemblyView, type ContextMetrics } from './state/session-lanes.ts';
import { SecretRedactor, startKernelHttpFace, type HttpFaceHandle } from './kernel-host.ts';
import { formatBytes, memoryPressureAction, readMemoryUsage } from './memory.ts';
import { rotateLogFile, SERVICE_LOG_MAX_BYTES } from './log-rotation.ts';
import { AttachServer, defaultSocketPath, type AttachShell } from './attach/server.ts';
import { enqueueAway } from './presence.ts';
import { loadNativePlugins, type PluginLoadResult } from './plugins/load.ts';
import { UpgradeAdmin } from './upgrade/admin.ts';
import type { StageUpgradeInput, StagedTree } from './upgrade/stage.ts';
import type { SpawnSupervisorResult } from './upgrade/spawn.ts';
import type { UpgradeOutcome, UpgradeRequest } from './upgrade/records.ts';
import type { PresenceReport, StatusState, WorkState } from './tui/view.ts';
import type { EmbeddingStatus } from './embedding/model.ts';
import { createEmbeddingProvider, resolveEmbeddingDimensions, type ShellEmbeddingProvider } from './embedding/provider.ts';
import { ContextLanes } from './context-lanes.ts';
import { PluginsAdmin } from './plugins-admin.ts';
import { RunLoop } from './run-loop.ts';
import { ProposalsHandlers } from './proposals-handlers.ts';
import { SovereigntyCommands } from './sovereignty.ts';
import { StatusFace } from './status-face.ts';

/**
 * A task-exit stub (#263) quotes each source ledger row as an exact prefix; the full row stays one
 * `read mem:<eventId>` away. The list is bounded because a resident may finish tasks forever.
 */
const MAX_TASK_STUB_QUOTE_CHARS = 240;
const MAX_TASK_STUBS = 20;
/** If the run's ledger row never arrives (capture paused), stop retrying the stub after an hour. */
const TASK_STUB_RETRY_MS = 60 * 60_000;
const DREAM_RETRY_BASE_MS = 5 * 60_000;
const DREAM_RETRY_CAP_MS = 30 * 60_000;
const DREAM_MAX_ATTEMPTS_PER_NIGHT = 5;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Emergence's stop-bleed (#229): a candidate is spoken or queued at most once, and at most eight
 * times in a configured-zone day (#285). The count is checkpointed, so a restart cannot reset
 * today's silence. Per-source frequency is F7's job.
 *
 * shortcut: the consumed-key list keeps the newest 500; an event older than that may surface once
 * more. Raise the cap if a resident ever accumulates candidates faster than 500 per lifetime.
 */
const EMERGENCE_DAILY_LIMIT = 8;
const MAX_EMERGENCE_CONSUMED = 500;

export interface CompanionShellOptions {
  config?: Partial<ShellConfig>;
  /** Tests inject a deterministic provider; production uses the mg plugin. */
  modelProvider?: ModelProvider;
  /** Tests and an embedding host may supply the kernel's model registry; production builds it below. */
  modelRegistry?: ModelRegistry;
  /** The re-embed migration path for a brain written before an embedding role existed. */
  embeddingProvider?: EmbeddingProvider;
  /**
   * Production starts the local embedder in the background. Tests and embedders that supply their
   * own provider leave it off, so constructing a shell never loads a model or touches the network.
   */
  embedding?: boolean;
  now?: () => number;
  tick?: boolean;
  /** Called when a checkpoint write fails; the CLI turns it into a non-zero exit. */
  onAlarm?: (error: Error) => void;
  terminalInput?: NodeJS.ReadableStream;
  terminalOutput?: NodeJS.WritableStream;
  /** Tests drive the supervisor handoff; production starts a real detached process. */
  upgradeSpawner?: (request: UpgradeRequest, requestPath: string) => Promise<SpawnSupervisorResult>;
  /** Tests drive staging; production installs the package from npm or copies a source tree. */
  stageUpgrade?: (input: StageUpgradeInput) => StagedTree;
  /** Tests drive the plugin restart; production restarts through the service manager. */
  restartResident?: () => void | Promise<void>;
}

/**
 * The kernel's embedding role is what `semanticIndexEnabled()` reads. The role has no "local model"
 * value, so the honest switch is the one the kernel already uses: `deterministic_local` while no
 * vectors exist, and a real provider only after the model has loaded and re-embedding can run.
 */
class ShellModelRegistry extends ModelRegistry {
  embeddingReady = false;
  routeTarget?: () => ModelRoute | undefined;

  override getRoleConfig(role: ModelRoleName): ModelRoleConfig {
    const config = super.getRoleConfig(role);
    if (role === 'embedding') {
      return this.embeddingReady ? config : { ...config, provider: 'deterministic_local', modelName: 'deterministic_local' };
    }
    const route = this.routeTarget?.();
    return route
      ? { ...config, provider: 'openai_compatible', baseUrl: route.baseUrl, apiKey: route.apiKey, modelName: route.model }
      : config;
  }
}

export class CompanionShell implements ShellControl, AttachShell {
  readonly config: ShellConfig;
  readonly trace: TraceLog;
  readonly machine: StateMachine;
  readonly host: PluginHost;
  readonly kernel: MemoryKernel;
  readonly backend: KernelAgentMemoryBackend;
  readonly lock: ProcessLock;
  /** The agent's command offers and the user's answers; the transcript element's source of truth. */
  readonly proposals: CommandProposals;
  readonly sovereignty: SovereigntyCommands;
  readonly proposalsHandlers: ProposalsHandlers;
  readonly pluginsAdmin: PluginsAdmin;
  readonly upgradeAdmin: UpgradeAdmin;
  readonly statusFace: StatusFace;
  readonly contextLanes: ContextLanes;
  readonly runLoop: RunLoop;
  runtime?: AgentRuntime;
  cage?: RunCage;
  clock?: ClockService;
  private dream?: { integrate(...args: [string, string, number?]): Promise<{ localDate: string; eventCount: number; sourceRefs: unknown[]; summary: string; memoryModelUsed?: boolean; memoryModelDegraded?: string; kernelNightRan?: boolean }> };
  private emergence?: {
    hasDue?(now?: number): boolean;
    decide(now?: number): {
      candidates: Array<{
        id: string;
        text: string;
        reason: string;
        source?: SurfacingSource;
        sensitivity?: 'daily' | 'private' | 'high';
        confidence?: number;
        freshness?: { observedAt: number; ageMs: number; expiresAt: number | null; expired: boolean };
        observedAt?: number;
        sourceRefs?: Array<{ eventId?: string; sourceId?: string; contentHash?: string }>;
      }>;
      suppressed: unknown[];
    };
  };
  /** The last candidate spoken per F6 source, so the owner's next line can close F7's loop. */
  private readonly surfacedByType = new Map<SurfacingSource, {
    candidateId: string;
    sourceRefs: Array<{ eventId?: string; sourceId?: string; contentHash?: string }>;
  }>();
  private http?: HttpFaceHandle;
  private terminal?: TerminalChannel;
  private readonly channelContract: ChannelContract;
  private readonly terminalSession: ChannelSession;
  attach?: AttachServer;
  modelLabel = 'unknown';
  /** Present only when this process built its own provider; an injected test provider has no routes. */
  modelRouter?: ModelRouter;
  /** The request-side estimate, calibrated by the provider's reported prompt count. */
  contextTokenEstimate = 0;
  /** The newest request's tool-output account (#319), shown beside the lane budget. */
  private lastToolOutput?: ToolOutputAccount;
  /** The newest six-lane assembly; `/context` and the TUI read this, not a second accounting. */
  lastLaneAssembly?: SessionContextAssembly;
  private contextAssemblyFailures = 0;
  private contextAssemblyConsecutive = 0;
  private contextAssemblyLastFailure?: { at: number; message: string };
  /** The projection actions that produced it (#268); reset when the next assembly is recorded. */
  lastContextMetrics?: ContextMetrics;
  /** `mem:` reads since the previous assembly; the next trace reports and clears it. */
  private drillsSinceAssembly = 0;
  /** The latest project event the compiled books were last brought up to. */
  private compiledThroughEventId?: string;
  /** Whether a soul-read failure has been traced; the read itself is retried on the next turn. */
  private soulFailureTraced = false;
  workLabel = '';
  runTurns = 0;
  runTokens = 0;
  /** The tier this process last started a run with; the work bar shows that tier's limits. */
  runTier: CageTier = 'autonomous';
  currentRunUserText = '';
  /**
   * The provider's own prompt-cache account for the run in flight (#165 round 21): `hit` is what the
   * endpoint reported served from cache, `miss` the remainder of the prompt, `percent` their ratio.
   * Absent until a provider reports a cache field — and absent is shown as nothing, never as 0%, so a
   * provider that never reports caching cannot look like a provider that always misses. Round 17's
   * estimate is not this number and never fills it.
   */
  promptCache?: { hit: number; miss: number; percent: number };
  runStartedAt?: number;
  /**
   * The killed run's prompt, rebuilt from the session log at recovery (#210). Delivery is a product
   * decision the shell does not make; holding it means the interrupted turn is reconstructable.
   */
  interrupted?: { runId: string; text: string; chars: number };
  /** An upgrade outcome already spoken by this process; attaches read it once, then it is gone. */
  lastUpgrade?: UpgradeOutcome;
  /** One memory notice per crossing, reset after we drop below 90% of the ceiling. */
  private memoryWarned = false;
  /** The day whose daily-budget stop was already spoken to the user (#233). */
  dailyNotifiedDay?: string;
  /** The Dream model's spend for the current night, charged to the same day counter (#231). */
  private nightSpent = 0;
  private nightCap = 0;
  private nightDay?: string;
  private nightStartTokens = 0;
  private dreamModelActive = false;
  /**
   * A question the run registered through `ask_user` (#228). It is process-local because the run is
   * still in this process; `settleAssignment` turns it into the checkpointed suspension.
   */
  pendingQuestion?: { text: string; contextRef?: string };
  /**
   * An autonomous wake that is backed off must not continue the open assignment, so its prompt must
   * not carry the assignment block either — otherwise the model would try anyway.
   */
  hideAssignmentContext = false;
  private readonly redactor = new SecretRedactor();
  /**
   * The CLI config this process writes for its own bash children. `COGMEM_CONFIG` points at it, so a
   * `cogmem` invocation inside the companion resolves `<dataDir>/memory.sqlite` rather than the
   * operator's global config (#277).
   */
  private readonly cliConfigPath: string;
  private tickTimer?: ReturnType<typeof setInterval>;
  private started = false;
  readonly now: () => number;
  /** This process's native plugin load outcomes; `/plugins` and `/health` read it. */
  readonly pluginResults: PluginLoadResult[] = [];
  private readonly embedding?: ShellEmbeddingProvider;
  /** Any host-supplied embedder, so the install's semantic probe is not limited to the local one. */
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly shellRegistry?: ShellModelRegistry;
  readonly modelRegistry: ModelRegistry;
  readonly stateLedger: ShellStateLedger;
  memoryModelFailed = false;
  /** A degraded provider must not claim the index; only a warm provider over a current index may. */
  private embeddingReadyAllowed = false;

  constructor(readonly options: CompanionShellOptions = {}) {
    this.config = defaultShellConfig(options.config);
    this.now = options.now ?? Date.now;
    this.trace = new TraceLog(this.config.dataDir);
    this.cliConfigPath = join(this.config.dataDir, 'cogmem-cli.toml');
    this.writeCliConfig();
    this.lock = new ProcessLock(this.config.dataDir);
    // The nightly snapshot lives beside the resident's other state, so a default install keeps the
    // last seven nights without an extra config key (#196).
    const registry = options.modelRegistry ?? this.buildModelRegistry();
    this.modelRegistry = registry;
    this.shellRegistry = registry instanceof ShellModelRegistry ? registry : undefined;
    const embedding = options.embedding && !options.embeddingProvider
      ? createEmbeddingProvider(this.config.embedding, this.config.dataDir, (status) => this.onEmbeddingState(status))
      : undefined;
    const embeddingProvider = options.embeddingProvider ?? embedding;
    this.embeddingProvider = embeddingProvider;
    this.embedding = embedding;
    this.kernel = createMemoryKernel({
      dbPath: this.config.dbPath,
      projectTimeZone: this.config.timeZone,
      snapshotsDir: join(this.config.dataDir, 'snapshots'),
      exportsDir: join(this.config.dataDir, 'exports'),
      modelRegistry: registry,
      ...(embeddingProvider ? { embeddingProvider } : {}),
    });
    this.stateLedger = new ShellStateLedger(this.kernel.eventStore, this.config.projectId);
    this.machine = new StateMachine({
      checkpoint: new CheckpointStore(this.config.dataDir, this.stateLedger),
      trace: this.trace,
      clock: this.now,
      onAlarm: (error) => {
        console.error(`[companion-shell] ALARM: ${error.message}; halting`);
        this.options.onAlarm?.(error);
      },
    });
    // A host-supplied provider is ready by definition; the local one flips this when it loads. The
    // flip comes after the kernel is built so its write-path embedder stays deterministic.
    if (options.embeddingProvider && this.shellRegistry) this.shellRegistry.embeddingReady = true;
    // The WAL is mmap'd and counts against RSS. The 4 MB default lets it grow to the threshold on a
    // busy turn stream; 256 pages (~1 MB) keeps the native footprint bounded without a shell timer.
    this.kernel.factStore.getDatabase().exec('PRAGMA wal_autocheckpoint=256');
    // The resident's own terminal is a private conversation (#162), registered through F12's
    // contract (#166). A future channel registers its own session here; a connection that never
    // registers answers as `public`.
    // shortcut: the whole resident shares one `terminal`/`private` backend; a second channel needs
    // its own backend instead of widening this one.
    this.channelContract = new ChannelContract(this.kernel.occasionScope);
    this.terminalSession = this.channelContract.register({
      channelId: 'terminal',
      occasion: 'private',
      accounts: [{ accountId: 'terminal-owner', role: 'owner' }],
      reachability: 'online',
      interruptibility: 'high',
    });
    this.backend = new KernelAgentMemoryBackend(this.kernel, {
      binding: this.terminalSession.binding,
      agentId: this.config.agentId,
    });
    this.host = new PluginHost({ trace: this.trace });
    this.host.seedService('stateMachine', this.machine);
    this.host.seedService('eventBus', this.host.bus);
    this.host.seedService('memory', this.backend);
    this.host.seedService('kernel', this.kernel);
    this.host.seedService('shell', this);
    this.host.seedService('commands', this.host.commands);
    this.host.seedService('trace', this.trace);
    this.sovereignty = new SovereigntyCommands(this);
    this.proposalsHandlers = new ProposalsHandlers(this);
    this.pluginsAdmin = new PluginsAdmin(this);
    this.upgradeAdmin = new UpgradeAdmin(this);
    this.statusFace = new StatusFace(this);
    this.contextLanes = new ContextLanes(this);
    this.runLoop = new RunLoop(this);
    this.proposals = new CommandProposals(
      (command) =>
        isProposableCommand(command) &&
        availableCoreCommand(command, 'resident', { multipleRoutes: this.modelRoutes().length > 1 }) !== undefined,
      this.trace,
      this.now,
      (proposal) => void this.host.bus.emit('companion_command_proposal', { proposal }),
    );
    this.host.seedService('proposals', this.proposals);
    // Every transition is also a bus event, so a plugin can observe the lifecycle without reading the
    // checkpoint file. This one carries the companion prefix.
    this.machine.onTransition((record) => {
      if (record.to === 'RUNNING') {
        this.runStartedAt = record.at;
        this.runTurns = 0;
        this.runTokens = 0;
        // A new run's cache account starts empty: the previous run's ratio is not evidence about this
        // one, and a stale percentage in the footer would read as if it were.
        this.promptCache = undefined;
        this.workLabel = '思考中';
      }
      void this.host.bus.emit('companion_transition', { ...record, state: record.to });
      this.statusFace.emitWork();
      this.statusFace.emitStatus();
    });
  }

  get state(): string {
    return this.machine.state;
  }

  /** How many TUI clients are attached; zero is what makes the shell hold emergence. */
  get attachedClients(): number {
    return this.attach?.clientCount ?? 0;
  }

  isRunning(): boolean {
    return this.machine.state === 'RUNNING';
  }

  /** The `/pause` gate, read from the checkpoint so a restart cannot forget it. */
  get capturePaused(): boolean {
    return this.machine.runtime.capturePaused === true;
  }

  get runtimeInstance(): AgentRuntime | undefined {
    return this.runtime;
  }

  /** The loopback HTTP face's address (status + star map), when this process started one. */
  get httpUrl(): string | undefined {
    return this.http?.baseUrl;
  }

  private buildModelRegistry(): ShellModelRegistry {
    const model = this.config.model;
    const registry = new ShellModelRegistry({
      memory: {
        role: 'memory',
        provider: 'openai_compatible',
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelName: model.model,
        timeoutMs: model.timeoutMs,
        maxTokens: 16_384,
        fallback: 'rule_only',
      },
      reasoning: {
        role: 'reasoning',
        provider: 'rule_only',
        modelName: 'rule_only',
        timeoutMs: 60_000,
        fallback: 'memory',
      },
      embedding: {
        role: 'embedding',
        provider: 'openai_compatible',
        modelName: this.config.embedding.model,
        timeoutMs: 30_000,
      },
    }, {
      beforeGenerate: () => this.beforeDreamModelCall(),
      onUsage: (_role, usage) => this.chargeDreamModelUsage(usage),
    });
    registry.routeTarget = () => this.modelRouter?.activeRoute;
    return registry;
  }

  private beginDreamModelBudget(at: number): void {
    const day = this.statusFace.localDay(at);
    const spent = this.statusFace.dailySpent(at);
    const persisted = this.machine.runtime.dreamNightDate === day
      ? this.machine.runtime.dreamNightStartTokens
      : undefined;
    this.nightStartTokens = persisted ?? spent;
    if (persisted === undefined) {
      this.machine.updateRuntime({ dreamNightDate: day, dreamNightStartTokens: this.nightStartTokens });
    }
    this.nightDay = day;
    this.nightSpent = Math.max(0, spent - this.nightStartTokens);
    const dailyRemaining = Math.max(0, this.config.dailyBudget.maxTokensPerDay - spent);
    this.nightCap = Math.min(this.config.nightBudget.maxTokensPerNight, dailyRemaining);
    this.dreamModelActive = true;
    this.trace.append('dream_model_budget', {
      day: this.nightDay,
      cap: this.nightCap,
      nightLimit: this.config.nightBudget.maxTokensPerNight,
      dailyRemaining,
    });
  }

  private endDreamModelBudget(): void {
    if (!this.dreamModelActive) return;
    this.dreamModelActive = false;
    this.trace.append('dream_model_spent', { day: this.nightDay, spent: this.nightSpent, cap: this.nightCap });
  }

  private beforeDreamModelCall(): void {
    if (!this.dreamModelActive) return;
    if (this.statusFace.dailyBudgetExceeded()) {
      this.trace.append('dream_model_budget_exceeded', {
        day: this.nightDay, spent: this.nightSpent, cap: this.nightCap, reason: 'daily_token_budget',
      });
      throw new Error('dream_model_budget_exceeded: daily_token_budget');
    }
    if (this.nightSpent >= this.nightCap) {
      this.trace.append('dream_model_budget_exceeded', {
        day: this.nightDay, spent: this.nightSpent, cap: this.nightCap, reason: 'night_token_budget',
      });
      throw new Error(`dream_model_budget_exceeded: ${this.nightSpent} >= ${this.nightCap}`);
    }
  }

  private chargeDreamModelUsage(usage: ModelTextUsage): void {
    if (!this.dreamModelActive) return;
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (tokens <= 0) return;
    // One counter for the day (#233). The night cap limits this run; it is not a second ledger.
    this.statusFace.chargeCost(tokens);
    this.nightSpent = Math.max(0, this.statusFace.dailySpent() - this.nightStartTokens);
    this.trace.append('dream_model_usage', {
      day: this.nightDay,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimated: usage.estimated === true,
      spent: this.nightSpent,
      cap: this.nightCap,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    const lock = this.lock.acquire(process.pid, this.now());
    if (lock.recoveredStalePid) this.trace.append('stale_lock_recovered', { pid: lock.recoveredStalePid });
    let restored: ReturnType<StateMachine['restore']>;
    let traceScan: ReturnType<TraceLog['recover']>;
    try {
      // The session log is read before the state machine is: a log damaged while nothing was watching
      // is repaired and written down here, and a checkpoint that cannot be recovered still leaves that
      // record behind (the lock goes with the failure, since this process will not run).
      traceScan = this.trace.recover();
      restored = this.machine.restore();
    } catch (error) {
      this.lock.release(process.pid);
      throw error;
    }
    // The loadout the checkpoint's transcript declared, read before any plugin registers a tool so
    // the comparison below sees what the previous process promised, not what this one just built.
    const restoredTools = this.machine.runtime.declaredTools ? [...this.machine.runtime.declaredTools] : undefined;
    if (restored.previous && ['RUNNING', 'DREAMING', 'WAKING'].includes(restored.previous)) {
      const recoveredRunId = this.machine.activeRunId;
      this.trace.append('recovery', { previous: restored.previous, seq: this.machine.seq, runId: recoveredRunId ?? null });
      if (restored.previous === 'RUNNING' && recoveredRunId) {
        // Pi #10000's durable prompt is what the interrupted turn hangs on; the session log holds all of it.
        const prompt = traceScan.records.find((record) => record.kind === 'run_prompt' && record.runId === recoveredRunId);
        if (prompt && typeof prompt.text === 'string') {
          this.interrupted = { runId: recoveredRunId, text: prompt.text, chars: Number(prompt.chars ?? prompt.text.length) };
          this.trace.append('prompt_recovered', { runId: recoveredRunId, chars: this.interrupted.chars });
        }
      }
      await this.machine.dispatch('recovered_run', { reason: `recovered_after_kill:${restored.previous}` });
    }
    // A pause survives the process (#228). With the object present the shell stays SUSPENDED and
    // waits; without it there is nothing to wait for, and the recovered_run edge returns to standby.
    if (restored.previous === 'SUSPENDED') {
      const suspension = this.machine.runtime.suspension;
      if (!suspension) {
        this.trace.append('suspension_missing', { seq: this.machine.seq });
        await this.machine.dispatch('recovered_run', { reason: 'suspended_without_object' });
      } else {
        this.trace.append('suspension_restored', { id: suspension.id, kind: suspension.kind, assignmentId: suspension.assignmentId });
      }
    }
    try {
      await this.startPlugins();
    } catch (error) {
      this.lock.release(process.pid);
      throw error;
    }
    if (this.config.http.enabled) {
      this.http = await startKernelHttpFace(this.kernel, {
        ...this.config.http,
        // The plugin half is read from this process's own load results, so "installed" is a fact the
        // owner can curl instead of a claim the model makes. `results` is filled by startPlugins
        // below; the closure reads it lazily.
        health: () => ({
          state: this.machine.state,
          plugins: this.pluginHealth(),
          embedding: this.embeddingStatus(),
          memoryModel: this.statusFace.memoryModelHealth(),
          contextAssembly: {
            failures: this.contextAssemblyFailures,
            consecutive: this.contextAssemblyConsecutive,
            lastFailure: this.contextAssemblyLastFailure ?? null,
          },
          suspension: this.machine.runtime.suspension
            ? { ...this.statusFace.suspendedLine(this.machine.runtime.suspension), id: this.machine.runtime.suspension.id, createdAt: this.machine.runtime.suspension.createdAt }
            : null,
        }),
        healthStatus: () => (this.contextAssemblyConsecutive >= 3 ? 'degraded' : 'ok'),
        connectedAgents: () => [this.config.agentId],
        tracePath: join(this.config.dataDir, 'shell-events.jsonl'),
      });
      this.trace.append('http_face_started', { url: this.http.baseUrl, port: this.http.port });
    }
    // The executable set is complete only now (built-in tools, then registry plugins). A checkpoint
    // that declared a different loadout is a loud failure, and the current one becomes the declaration.
    const mismatch = this.declaredToolMismatch(restoredTools);
    if (mismatch) {
      this.trace.append('tool_set_mismatch', mismatch);
      // Unwind what start built before refusing, so an embedder does not inherit a half-started shell;
      // the lock goes last, since releasing it is what admits the next process.
      this.http?.stop();
      await this.host.stop();
      this.lock.release(process.pid);
      throw new Error(`tool_set_mismatch: the checkpoint declared [${mismatch.declared.join(', ')}] but this process can execute [${mismatch.executable.join(', ')}]`);
    }
    this.refuseRecoveryReplay(restored.previous);
    this.machine.updateRuntime({ declaredTools: this.executableToolNames() });
    if (this.machine.state === 'DORMANT') {
      await this.machine.dispatch('boot', { reason: 'process_start' });
      this.injectTimeContext('process_start');
      await this.machine.dispatch('context_injected', { reason: 'waking_complete' });
    }
    // The upgrade's report is owed to the user, not to the next command: it is settled here and on
    // every tick until it lands. It runs *after* the plugins because the report is spoken through the
    // line channel's `terminal_print` subscription, which `startPlugins` is what installs.
    this.settleUpgradeReport(this.now());
    this.clock!.scheduleIdleWake();
    this.terminal?.start();
    if (this.config.attach.enabled) {
      this.attach = new AttachServer({
        socketPath: this.config.attach.socketPath ?? defaultSocketPath(this.config.dataDir),
        shell: this,
        bus: this.host.bus,
        trace: this.trace,
      });
      await this.attach.start();
    }
    if (this.options.tick !== false) {
      // The tick is what keeps a headless resident process alive: it is the scheduler that fires a
      // persisted wake intent, not an unref'd convenience timer. An unref here let `--no-terminal`
      // exit immediately and leave its lock behind.
      this.tickTimer = setInterval(() => {
        void this.tick().catch((error) => this.trace.append('tick_error', { message: error instanceof Error ? error.message : String(error) }));
      }, this.config.tickIntervalMs);
    }
    // The queue is state (#210), so a non-empty one comes back item by item; the recovery fact is
    // written down rather than silent. The queue's own text stays in the checkpoint, not the log.
    const restoredQueue = {
      steering: [...(this.machine.runtime.pendingSteering ?? [])],
      followUps: [...(this.machine.runtime.pendingFollowUps ?? [])],
    };
    if (restoredQueue.steering.length > 0 || restoredQueue.followUps.length > 0) {
      this.trace.append('steering_restored', {
        steering: restoredQueue.steering.length,
        followUps: restoredQueue.followUps.length,
        steeringChars: restoredQueue.steering.reduce((sum, line) => sum + line.length, 0),
      });
    }
    this.started = true;
    this.rotateServiceLog();
    this.trace.append('shell_started', { state: this.machine.state, mi: this.machine.wakeIntents.length });
    // Loading the model (and the one-time download on an upgrade) is deliberately not awaited: the
    // health face and the first turns must be ready before the 99 MiB arrives. Until it does, recall
    // is lexical and `semanticIndexEnabled()` is false.
    void this.warmEmbedding();
    // The offer is in-memory, the pause is not: a restart re-offers the approval for a budget pause.
    if (this.machine.state === 'SUSPENDED' && this.machine.runtime.suspension?.kind === 'budget') {
      this.offerResume(this.machine.runtime.suspension.id);
    }
    // A restart the plugin surface asked for is the one restart that continues the open assignment
    // on its own. Deferred so the HTTP/attach faces are serving before the run begins; a kill (no
    // request) never sets the flag, so recovery still lands in IDLE and waits.
    this.resumeAfterRequestedRestart();
  }

  /** The embedder's state for `/health`; a missing embedder says so rather than looking active. */
  private embeddingStatus(): EmbeddingStatus | { state: 'absent'; modelId: string; dimensions: number; detail: string } {
    return this.embedding?.status() ?? {
      state: 'absent',
      modelId: this.config.embedding.model,
      dimensions: resolveEmbeddingDimensions(this.config.embedding),
      detail: 'embedding host not enabled for this process',
    };
  }

  private setEmbeddingReady(ready: boolean): void {
    if (this.shellRegistry) this.shellRegistry.embeddingReady = ready;
  }

  private onEmbeddingState(status: EmbeddingStatus): void {
    if (status.state === 'degraded') this.setEmbeddingReady(false);
    else if (status.state === 'active' && this.embeddingReadyAllowed) this.setEmbeddingReady(true);
  }

  /** Only a warm provider over a current index may claim the semantic lane. */
  private markEmbeddingReady(): void {
    this.embeddingReadyAllowed = true;
    this.setEmbeddingReady(true);
  }

  private async warmEmbedding(): Promise<void> {
    if (!this.embedding) return;
    try {
      await this.embedding.warm();
      const status = this.embedding.status();
      this.markEmbeddingReady();
      this.trace.append('embedding_ready', {
        modelId: status.modelId,
        dimensions: status.dimensions,
        loadMs: status.loadMs ?? null,
      });
      const backfill = await this.kernel.backfillEventEmbeddings({ projectId: this.config.projectId });
      if (backfill.completed > 0 || backfill.failed > 0) {
        this.trace.append('embedding_backfill', { projectId: this.config.projectId, ...backfill });
      }
    } catch (error) {
      // A missing model, a failed download or a broken ONNX file all land here. The companion keeps
      // answering with lexical recall; health and this trace record why.
      const message = error instanceof Error ? error.message : String(error);
      this.trace.append('embedding_unavailable', {
        modelId: this.config.embedding.model,
        message,
      });
      // The service log is inherited stdout/stderr; the trace is the durable record. Say it on both
      // faces so a worker that never starts is not only a `/health` line nobody reads (#280).
      console.error(`[companion-shell] embedding degraded: ${message}`);
    }
  }

  /** Idempotent: rewritten on every start so `--db` and a data-dir move stay in sync. */
  private writeCliConfig(): void {
    try {
      mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(this.cliConfigPath, `[core]\ndb_path = ${JSON.stringify(this.config.dbPath)}\n`, { mode: 0o600 });
    } catch (error) {
      this.trace.append('cli_config_write_failed', {
        path: this.cliConfigPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The migration for a brain written before this process had vectors (#231 Route A). The pipeline
   * is idempotent and checkpoints its cursor, so a second run is a no-op and a killed run resumes.
   * Batches are yielded between passes so a recall never waits for a whole brain.
   */
  private async startPlugins(): Promise<void> {
    // An injected provider (tests, an embedding host) is used as-is and has no route table. The real
    // resident gets a router: the mg route from env plus whatever named routes the user stored.
    let provider = this.options.modelProvider ? providedModelPlugin(this.options.modelProvider) : undefined;
    if (!provider) {
      this.modelRouter = new ModelRouter({
        store: new RouteStore(join(this.config.dataDir, 'routes.json')).load(),
        builtin: { name: 'mg', baseUrl: this.config.model.baseUrl, apiKey: this.config.model.apiKey, model: this.config.model.model, targetTokens: this.config.contextSweetSpot },
        builtinAvailable: process.env.MG_BASE_URL !== undefined,
        timeoutMs: this.config.model.timeoutMs,
        // A 429 the gateway could not absorb is retried by the provider, not the run ladder (#282).
        onRetry: ({ attempt, status, delayMs }) => this.trace.append('provider_retry', { attempt, status, delayMs }),
      });
      // A routes file that did not parse is a real problem the user must see, but it must not stop the
      // resident: mg is available either way.
      if (this.modelRouter.storeError) this.trace.append('model_routes_load_failed', { message: this.modelRouter.storeError });
      provider = modelRouterPlugin(this.modelRouter);
    }
    this.host.register(clockPlugin({
      timeZone: this.config.timeZone,
      idleWakeIntervalMs: this.config.idleWakeIntervalMs,
      dreamWindow: { startHour: this.config.dream.windowStartHour, endHour: this.config.dream.windowEndHour },
      ...(this.config.quiet ? { quietWindow: this.config.quiet } : {}),
      now: this.now,
    }));
    this.host.register(provider, this.config.model);
    this.host.register(cagePlugin(this.config.budgets, this.trace, { ...this.config.workBudget, toolWhitelist: this.config.budgets.toolWhitelist }));
    this.host.register(builtinToolsPlugin(), {
      workspaceRoot: this.config.workspaceRoot,
      dataDir: this.config.dataDir,
      cliConfigPath: this.cliConfigPath,
      trace: this.trace,
      kernel: this.kernel,
      onMemoryRead: () => {
        this.drillsSinceAssembly += 1;
      },
    });
    this.host.register(proposalPlugin());
    this.host.register(askPlugin());
    this.host.register(assignmentPlugin());
    this.host.register(capturePlugin({ agentId: this.config.agentId, projectId: this.config.projectId, sessionId: this.config.sessionId, paused: () => this.capturePaused }));
    this.host.register(sessionContextPlugin({
      agentId: this.config.agentId,
      projectId: this.config.projectId,
      sessionId: this.config.sessionId,
      targetTokens: () => this.targetTokens(),
      tailTurns: this.config.tailTurns,
      pinned: () => this.lanePinned(),
      profile: () => this.laneProfile(),
      openLoops: () => this.laneOpenLoops(),
      digestStubs: () => this.laneDigestStubs(),
      ledgerSeq: () => this.kernel.eventStore.getLatestGlobalSeq(),
      variablePrompt: () => this.systemPromptSections().tail,
      onAssembly: (assembly) => {
        this.lastLaneAssembly = assembly;
        this.lastContextMetrics = {
          folds: assembly.decisionTrace.length,
          drills: this.drillsSinceAssembly,
          autoExpands: assembly.autoExpanded.length,
        };
        this.drillsSinceAssembly = 0;
        this.statusFace.emitStatus();
      },
      onAssemblyFailure: (message) => {
        this.contextAssemblyFailures += 1;
        this.contextAssemblyConsecutive += 1;
        this.contextAssemblyLastFailure = { at: this.now(), message };
      },
      onAssemblySuccess: () => {
        this.contextAssemblyConsecutive = 0;
      },
      recallLimit: 3,
    }));
    this.host.register(memoryToolPlugin({
      agentId: this.config.agentId,
      projectId: this.config.projectId,
      sessionId: this.config.sessionId,
      onMemoryRead: () => {
        this.drillsSinceAssembly += 1;
      },
    }));
    this.host.register(soulEditPlugin());
    this.host.register(dreamPlugin({
      agentId: this.config.agentId,
      projectId: this.config.projectId,
      sessionId: this.config.sessionId,
      runKernelNight: this.config.dream.runKernelNight,
      maxEpisodes: this.config.dream.maxEpisodes,
      beforeKernelNight: (now) => this.beginDreamModelBudget(now),
      afterKernelNight: () => this.endDreamModelBudget(),
    }));
    this.host.register(emergencePlugin({ agentId: this.config.agentId, projectId: this.config.projectId }));
    if (this.config.terminalEnabled) {
      this.host.register(terminalPlugin({
        shell: this,
        input: this.options.terminalInput,
        output: this.options.terminalOutput,
        trace: this.trace,
        contract: this.channelContract,
        session: this.terminalSession,
        accountId: 'terminal-owner',
        captureTerminalRecord: async (text: string) => {
          await this.captureService?.captureTerminalRecord(text, `companion-day:${this.clock!.localDate()}`);
        },
      }));
    }
    this.pluginResults.push(...(await loadNativePlugins(this.host, this.config.plugins, {
      cwd: this.config.workspaceRoot,
      trace: this.trace,
    })));
    await this.host.start();
    // The host has run every `apply`, so the registrations each plugin actually made are readable.
    for (const result of this.pluginResults) {
      if (result.status !== 'loaded' || !result.name) continue;
      result.tools = this.host.tools.list().filter((tool) => tool.source === `plugin:${result.name}`).map((tool) => tool.name);
      result.commands = this.host.commands.list().filter((command) => command.source === `plugin:${result.name}`).map((command) => command.name);
    }
    for (const result of this.pluginResults) {
      if (result.status !== 'failed') continue;
      // A failure a user cannot see is a failure they will blame on the plugin that did load.
      void this.host.bus.emit('terminal_print', { text: `plugin ${result.spec} failed to load: ${result.reason}\n` });
    }
    this.clock = this.host.getService<ClockService>('clock');
    this.cage = this.host.getService<RunCage>('cage');
    const model = this.host.getService<ModelProvider>('model');
    this.runtime = new AgentRuntime({
      bus: this.host.bus,
      // Pi #10000: the whole prompt is durable before the model call, redacted before it reaches the trace.
      onPrompt: (input) => this.recordPrompt(input),
      tools: this.host.tools,
      provider: model,
      budget: this.cage,
      maxIdleTurns: this.config.maxIdleTurns,
      systemPrompt: () => this.systemPrompt(),
      trace: this.trace,
      clock: this.now,
      // A mid-run hot-plug declares the delta in the transcript; the checkpoint keeps the same set so
      // the next recovery can compare it against what the process can run.
      onToolsDeclared: (names) => this.machine.updateRuntime({ declaredTools: [...names].sort() }),
      // The queues are state, not memory (#210): the checkpoint written before the process dies is
      // what the next start drains, in order.
      initialQueues: { steering: this.machine.runtime.pendingSteering, followUps: this.machine.runtime.pendingFollowUps },
      onQueueChange: ({ steering, followUps }) => this.machine.updateRuntime({
        pendingSteering: steering.length > 0 ? [...steering] : undefined,
        pendingFollowUps: followUps.length > 0 ? [...followUps] : undefined,
      }),
      // The context gauge is the measured request, not a running total of message events: the system
      // prompt, the tool schemas and a `transformContext`-injected recall block are all part of what
      // the model was charged for, and none of them is a message this process emits.
      onContextAssembled: (account, toolOutput) => {
        this.contextTokenEstimate = account.totalTokens;
        this.lastToolOutput = toolOutput;
        this.statusFace.emitStatus();
      },
      // One stated whole-request ceiling, the same number the lanes are fitted to. The tool cap
      // is a ceiling inside it, not an extra allowance on top of it (#319, #318's unit).
      requestBudget: () => this.targetTokens(),
      contextLanes: () => (this.lastLaneAssembly ? laneAssemblyView(this.lastLaneAssembly) : undefined),
      contextMetrics: () => this.lastContextMetrics,
    });
    this.modelLabel = `${this.host.getService<ModelProvider>('model').name}/${model.model}`;
    this.statusFace.attachWorkListeners();
    this.dream = this.host.getService('dream');
    this.emergence = this.host.getService('emergence');
    // Crash recovery needs to know what was running. The checkpoint records the calls that started and
    // have not finished, which is the list a replay would have to be judged against (see
    // `refuseRecoveryReplay`). ponytail: two checkpoint writes per tool call; batch them if a run ever
    // issues tools fast enough for the fsyncs to show up.
    this.host.bus.on('tool_execution_start', (event: { toolCallId?: string; toolName?: string }) => {
      if (!event.toolCallId || !event.toolName) return;
      const inFlight = this.machine.runtime.inFlightToolCalls ?? [];
      if (inFlight.some((call) => call.toolCallId === event.toolCallId)) return;
      const started: InFlightToolCall = { toolCallId: event.toolCallId, toolName: event.toolName };
      this.machine.updateRuntime({ inFlightToolCalls: [...inFlight, started] });
    });
    this.host.bus.on('tool_execution_end', (event: { toolCallId?: string }) => {
      const inFlight = this.machine.runtime.inFlightToolCalls ?? [];
      if (!event.toolCallId || !inFlight.some((call) => call.toolCallId === event.toolCallId)) return;
      this.machine.updateRuntime({ inFlightToolCalls: inFlight.filter((call) => call.toolCallId !== event.toolCallId) });
    });
    // The terminal channel prints what the shell says; the app is the only place that knows a reply
    // finished, so it forwards the assistant text on the bus the channel already listens to.
    this.host.bus.on('message_end', (event: { message?: { role?: string; content?: string } }) => {
      if (event.message?.role === 'assistant' && event.message.content) {
        void this.host.bus.emit('terminal_print', { text: `${event.message.content}\n` });
      }
    });
    this.terminal = this.host.hasService('terminal') ? this.host.getService<TerminalChannel>('terminal') : undefined;
  }

  private get captureService() {
    return this.host.hasService('capture') ? this.host.getService<{ captureTerminalRecord(text: string, threadId: string): Promise<unknown> }>('capture') : undefined;
  }

  /** The names the process can actually execute, which is what a transcript declaration must match. */
  private executableToolNames(): string[] {
    return this.host.tools.list().map((tool) => tool.name).sort();
  }

  /**
   * Crash recovery must not replay an effect whose outcome is unknown. Nothing in the shell replays a
   * tool call today; this makes the refusal explicit and names what it would have replayed, using the
   * policy each tool declares (`read` is safe; bash/write/edit and anything undeclared are not).
   */
  private refuseRecoveryReplay(previous: string | undefined): void {
    const inFlight = this.machine.runtime.inFlightToolCalls ?? [];
    if (previous !== 'RUNNING' || inFlight.length === 0) return;
    const judged = inFlight.map((call) => ({ ...call, replay: this.host.tools.get(call.toolName)?.replay ?? 'never' }));
    this.trace.append('recovery_no_replay', { previous, inFlight: judged, refused: judged.filter((call) => call.replay === 'never').map((call) => call.toolName) });
    this.machine.updateRuntime({ inFlightToolCalls: [] });
  }

  /**
   * Pi restores the loadout a transcript declared (`_restoreToolsFromTranscript`). Here the rule is
   * about executability, not equality: if the checkpoint declared a tool this process cannot run — a
   * plugin removed, or failed to load — the shell refuses to start with a transcript that names it,
   * rather than run degraded and quiet.
   *
   * An *addition* is accepted and re-declared below. The registry (#223) makes "the plugin set
   * changed between two starts" a normal, owner-confirmed operation, and an exact-equality check
   * turned every such restart into a refused boot. A superset can execute everything the transcript
   * named, so it is not the case this guard exists for.
   */
  private declaredToolMismatch(restored: string[] | undefined): { declared: string[]; executable: string[] } | undefined {
    if (!restored) return undefined;
    const executable = this.executableToolNames();
    const missing = restored.filter((name) => !executable.includes(name));
    if (missing.length === 0) return undefined;
    return { declared: [...restored].sort(), executable };
  }

  systemPromptSections(): { pinned: string; tail: string } {
    return this.contextLanes.systemPromptSections();
  }

  systemPrompt(): string {
    return this.contextLanes.systemPrompt();
  }

  targetTokens(): number {
    return this.contextLanes.targetTokens();
  }

  lanePinned(): string[] {
    return this.contextLanes.lanePinned();
  }

  laneProfile(): string[] {
    return this.contextLanes.laneProfile();
  }

  laneOpenLoops(): SessionContextItem[] {
    return this.contextLanes.laneOpenLoops();
  }

  laneProcedures(): SessionContextItem[] {
    return this.contextLanes.laneProcedures();
  }

  laneDigestStubs(): SessionDigestEntry[] {
    return this.contextLanes.laneDigestStubs();
  }

  materializeTaskProcedure(final: boolean): void {
    this.contextLanes.materializeTaskProcedure(final);
  }

  materializeTaskEndStub(turnId?: string, runId?: string, deferRunId?: string): void {
    this.contextLanes.materializeTaskEndStub(turnId, runId, deferRunId);
  }

  private recordPrompt(input: { runId: string; sessionId: string; text: string }): void {
    this.contextLanes.recordPrompt(input);
  }

  async submit(text: string): Promise<RunSummary | undefined> {
    return this.runLoop.submit(text);
  }

  private async wakeIfNeeded(trigger: 'message_received' | 'wake_intent_due' | 'emergence_due'): Promise<void> {
    return this.runLoop.wakeIfNeeded(trigger);
  }

  async executeRun(
    text: string,
    trigger: 'message_received' | 'emergence_due',
    reason: string,
    dispatchTrigger: Trigger = trigger,
    grant?: { tokens: number; turns: number },
  ): Promise<RunSummary> {
    return this.runLoop.executeRun(text, trigger, reason, dispatchTrigger, grant);
  }

  async tick(at = this.now()): Promise<void> {
    this.rotateServiceLog();
    // An owed upgrade report is not gated on the lifecycle: a promise that came due has to be
    // honoured whatever else is happening.
    this.settleUpgradeReport(at);
    // A paused shell is waiting for its owner, not for the clock: no wake intent, dream window or
    // emergence decision may fire out of SUSPENDED (#228).
    if (this.machine.state === 'RUNNING' || this.machine.state === 'WAKING' || this.machine.state === 'SUSPENDED') return;
    this.reportHealth(at);
    if (this.machine.state === 'DORMANT') {
      await this.maybeSnapshot(at);
      await this.applyDueWakeIntent(at);
      return;
    }
    if (this.machine.state === 'DREAMING') return;
    await this.applyDueWakeIntent(at);
    const quiet = this.clock!.quietWindowOpen(at);
    if (!quiet && this.machine.state === 'IDLE') {
      const queue = [...(this.machine.runtime.awayQueue ?? [])];
      const deferred = queue.findIndex((entry) => entry.deferred === 'quiet');
      if (deferred >= 0) {
        const [entry] = queue.splice(deferred, 1);
        this.machine.updateRuntime({ awayQueue: queue });
        this.consumeEmergence({ id: entry!.id, source: entry!.source, observedAt: entry!.observedAt, sourceRefs: entry!.sourceRefs }, at);
        await this.speakEmergence({
          id: entry!.id,
          text: entry!.text,
          reason: entry!.reason,
          ...(entry!.source === undefined ? {} : { source: entry!.source as SurfacingSource }),
          ...(entry!.sourceRefs === undefined ? {} : { sourceRefs: entry!.sourceRefs }),
        }, at);
        this.trace.append('emergence_quiet_delivered', { projectId: this.config.projectId, id: entry!.id, at });
        return;
      }
    }
    if (this.dreamDue(at)) {
      const empty = this.emptyCatchupTarget(at);
      if (empty) {
        this.trace.append('dream_catchup', { dream_catchup: true, localDate: empty, skippedDays: this.dreamSkippedDays(empty), empty: true });
        this.clock!.markDreamed(at);
      } else {
        await this.runDream(at);
        await this.maybeSnapshot(at);
        return;
      }
    }
    await this.maybeSnapshot(at);
    if (this.machine.state === 'IDLE') {
      this.compileProactiveBooks(at);
      // The candidate query must run before F2's tick: a due wake intention is still pending at
      // the query, while the tick that follows marks it fired. A prospective memory stays listed
      // after its notification, so both first-class lanes are seen once.
      // A test double without `hasDue` is asked every tick, which is the old injected behaviour.
      const due = this.emergence!.hasDue?.(at) ?? true;
      const allowed = due && this.emergenceAllowed(at);
      const decision = allowed ? this.emergence!.decide(at) : undefined;
      if (due) this.runKernelWakeTick(at);
      if (decision) {
        const absent = this.statusFace.shouldHoldForAbsence();
        const userState = quiet ? 'night-dnd' : absent ? 'idle' : 'in-conversation';
        const channel = { reachability: 'online' as const, interruptibility: quiet || absent ? 'low' as const : 'high' as const };
        const routed = new Map<string, ReturnType<KernelAgentMemoryBackend['deliveryRoute']>>();
        if (decision.candidates.length === 1) {
          const only = decision.candidates[0]!;
          routed.set(only.id, this.backend.deliveryRoute({ projectId: this.config.projectId, candidate: this.deliveryInput(only, at), userState, channel, now: at }));
        } else {
          const batch = this.backend.deliveryRouteBatch({
            projectId: this.config.projectId,
            candidates: decision.candidates.map((item) => this.deliveryInput(item, at)),
            userState,
            channel,
            now: at,
          });
          for (const entry of batch.decisions) routed.set(entry.candidateId, entry);
        }
        for (const item of decision.candidates) {
          if (this.emergenceConsumed(item)) continue;
          const delivery = routed.get(item.id);
          if (delivery?.decision === 'deliver') {
            // Consume before acting: a crash during the run must not free the same candidate to run again.
            this.consumeEmergence(item, at);
            await this.speakEmergence(item, at);
            break;
          }
          if (delivery?.decision === 'accumulate') {
            if (!quiet) this.consumeEmergence(item, at);
            if (!(this.machine.runtime.awayQueue ?? []).some((entry) => entry.id === item.id)) {
              this.machine.updateRuntime({
                awayQueue: enqueueAway(this.machine.runtime, {
                  id: item.id,
                  text: item.text,
                  reason: item.reason,
                  at,
                  ...(item.source ? { source: item.source } : {}),
                  ...(item.observedAt === undefined ? {} : { observedAt: item.observedAt }),
                  ...(item.sourceRefs ? { sourceRefs: item.sourceRefs } : {}),
                  deferred: quiet ? 'quiet' : 'absence',
                }),
              });
            }
            this.trace.append('emergence_accumulated', {
              projectId: this.config.projectId,
              id: item.id,
              reason: item.reason,
              at,
              destination: delivery.destination,
              ...(quiet ? { reason: 'quiet_window' } : {}),
            });
            break;
          }
        }
      } else if (due && !allowed) {
        this.trace.append('emergence_skipped', {
          projectId: this.config.projectId,
          at,
          reason: this.statusFace.dailyBudgetExceeded(at) ? 'daily_token_budget' : 'cooldown_or_daily_cap',
        });
      }
    }
  }

  private compileProactiveBooks(at: number): void {
    const projectId = this.config.projectId;
    try {
      const latest = this.latestEventId(projectId);
      if (latest === (this.compiledThroughEventId ?? '')) return;
      this.kernel.commitments.compile({ projectId, now: at });
      this.kernel.intentions.compile({ projectId, now: at });
      for (const intention of this.kernel.intentions.list({ projectId, statuses: ['active'], now: at })) {
        if (intention.dueAt === undefined || intention.wakeIntentionId !== undefined) continue;
        this.kernel.intentions.schedule({ projectId, intentionId: intention.intentionId, now: at });
        this.trace.append('intention_scheduled_for_wake', { intentionId: intention.intentionId, dueAt: intention.dueAt, at });
      }
      const profile = this.kernel.profile.compile({ projectId, now: at });
      this.trace.append('profile_compiled', { projectId, at, written: profile.written, entries: profile.entries });
      this.compiledThroughEventId = this.latestEventId(projectId);
    } catch (error) {
      this.trace.append('proactive_compile_failed', { at, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private latestEventId(projectId: string): string {
    return this.kernel.eventStore.queryEvents(1, 1, { projectId: [projectId], order: 'desc' }).records[0]?.eventId ?? '';
  }

  /** F2's clock: fire due intentions and announce due prospective memories. It never speaks. */
  private runKernelWakeTick(at: number): void {
    try {
      const result = this.backend.runWakeTick({ projectId: this.config.projectId, agentId: this.config.agentId, now: at });
      if (result.emitted > 0) {
        this.trace.append('wake_tick', {
          at,
          firedWakeIntentions: result.firedWakeIntentions.map((intention) => intention.intentionId),
          prospectiveDue: result.prospectiveDue.map((entry) => entry.candidateId),
        });
      }
    } catch (error) {
      this.trace.append('wake_tick_failed', { at, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The event, when the candidate names one, is a stabler key than a lane's own id. The observed
   * instant rides along because a snoozed commitment resumes as the same id at a new occurrence.
   */
  private emergenceKey(candidate: { id: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }): string {
    if (candidate.source === 'commitment') {
      const commitmentId = candidate.id.slice('surfacing:commitment:'.length);
      const entry = this.kernel.commitments
        .list({ projectId: this.config.projectId, now: this.now() })
        .find((item) => item.commitmentId === commitmentId);
      if (entry) return `${candidate.id}@${entry.resumeAt ?? entry.dueAt ?? ''}`;
    }
    return `${candidate.sourceRefs?.[0]?.eventId ?? candidate.id}@${candidate.observedAt ?? ''}`;
  }

  private emergenceConsumed(candidate: { id: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }): boolean {
    return (this.machine.runtime.emergence?.consumed ?? []).includes(this.emergenceKey(candidate));
  }

  /** The configured day's count; it survives a restart because it lives in the checkpoint. */
  private emergenceAllowed(at: number): boolean {
    // #233 and #229 share one day boundary and one hard stop: when the day's tokens are gone,
    // autonomy does not start another run, exactly as the emergence count cap does.
    if (this.statusFace.dailyBudgetExceeded(at)) return false;
    const state = this.machine.runtime.emergence;
    if (!state) return true;
    return state.day !== this.statusFace.localDay(at) || state.count < EMERGENCE_DAILY_LIMIT;
  }

  private consumeEmergence(candidate: { id: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }, at: number): void {
    const key = this.emergenceKey(candidate);
    const day = this.statusFace.localDay(at);
    const prior = this.machine.runtime.emergence;
    const count = prior?.day === day ? prior.count + 1 : 1;
    const consumed = [...(prior?.consumed ?? []).filter((entry) => entry !== key), key].slice(-MAX_EMERGENCE_CONSUMED);
    this.machine.updateRuntime({ emergence: { day, count, consumed } });
    this.trace.append('emergence_consumed', { projectId: this.config.projectId, id: candidate.id, key, day, count });
  }

  private deliveryInput(candidate: { id: string; source?: SurfacingSource; sensitivity?: 'daily' | 'private' | 'high'; confidence?: number; freshness?: { observedAt: number; ageMs: number; expiresAt: number | null; expired: boolean }; observedAt?: number }, at: number): DeliveryCandidateInput {
    return {
      candidateId: candidate.id,
      source: candidate.source ?? 'commitment',
      sensitivity: candidate.sensitivity ?? 'daily',
      confidence: candidate.confidence ?? 0.9,
      freshness: candidate.freshness ?? { observedAt: candidate.observedAt ?? at, ageMs: 0, expiresAt: null, expired: false },
    };
  }

  private async speakEmergence(candidate: { id: string; text: string; reason: string; source?: SurfacingSource; sourceRefs?: Array<{ eventId?: string; sourceId?: string; contentHash?: string }> }, at: number): Promise<void> {
    if (candidate.source !== undefined && candidate.sourceRefs !== undefined) {
      const prior = this.surfacedByType.get(candidate.source);
      if (prior && prior.candidateId !== candidate.id) this.writeSurfacingFeedback(prior, 'ignored');
      this.surfacedByType.set(candidate.source, { candidateId: candidate.id, sourceRefs: candidate.sourceRefs });
    }
    void this.host.bus.emit('companion_emergence', { id: candidate.id, reason: candidate.reason, text: candidate.text });
    let ok = false;
    try {
      const summary = await this.executeRun(candidate.text, 'emergence_due', `emergence:${candidate.id}`);
      ok = summary.stopReason === 'run_complete';
    } finally {
      this.trace.append('emergence_run', { projectId: this.config.projectId, id: candidate.id, ok });
    }
  }

  private writeSurfacingFeedback(prior: { candidateId: string; sourceRefs: Array<{ eventId?: string; sourceId?: string; contentHash?: string }> }, outcome: 'engaged' | 'ignored' | 'stopped'): void {
    try {
      this.backend.recordSurfacingFeedback({
        projectId: this.config.projectId,
        candidateId: prior.candidateId,
        outcome,
        sourceRefs: prior.sourceRefs,
        now: this.now(),
      });
      this.trace.append('surfacing_feedback', { projectId: this.config.projectId, candidateId: prior.candidateId, outcome });
    } catch (error) {
      this.trace.append('surfacing_feedback_failed', { candidateId: prior.candidateId, outcome, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The owner's next line closes F7's loop for the last thing the companion said on its own. */
  acknowledgeSurfacing(): void {
    for (const [source, prior] of [...this.surfacedByType]) {
      this.writeSurfacingFeedback(prior, 'engaged');
      this.surfacedByType.delete(source);
    }
  }

  /**
   * The kernel's own condition (#196, F19): refresh the four checks, and once per failed Dream
   * streak route the health notice through F18's highest tier. Delivery reuses the existing
   * emergence speak path; when the owner is away the notice accumulates instead of talking to an
   * empty room. The decision trace is written so the notice is auditable, not just felt.
   */
  private reportHealth(at: number): void {
    try {
      this.kernel.health.check({ now: at });
      if (this.clock!.quietWindowOpen(at)) return;
      this.reportMemoryPressure(at);
      const away = this.statusFace.shouldHoldForAbsence();
      const notice = this.backend.healthNotice({
        projectId: this.config.projectId,
        userState: away ? 'idle' : 'in-conversation',
        channel: { reachability: 'online', interruptibility: away ? 'low' : 'high' },
        now: at,
      });
      if (!notice.due || !notice.decision) return;
      this.trace.append('health_notice', {
        streak: notice.streak,
        decision: notice.decision.decision,
        destination: notice.decision.destination,
        urgency: notice.decision.urgency,
        reasonCode: notice.decision.reasonCode,
        trace: notice.decision.decisionTrace,
      });
      if (notice.decision.decision !== 'deliver') return;
      const text = `我最近 ${notice.streak} 晚的夜间整合都失败了，记忆可能不完整。我不会假装正常——你回来时我们先补这一块。`;
      void this.host.bus.emit('companion_emergence', { id: 'health:dream-streak', reason: 'health_notice', text });
    } catch (error) {
      this.trace.append('health_check_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The process half of the health face (#226). The kernel's frozen four checks stay four; this
   * reads the resident's own RSS against the unit ceiling and routes one notice through the same
   * emergence path the Dream-streak notice uses. The reading itself is also on `GET /health`.
   */
  private reportMemoryPressure(at: number): void {
    const memory = readMemoryUsage();
    const action = memoryPressureAction(memory, this.memoryWarned);
    if (action === 'reset') {
      this.memoryWarned = false;
      return;
    }
    if (action === 'hold') return;
    const ceiling = (memory.highBytes ?? memory.limitBytes)!;
    this.memoryWarned = true;
    const kind = memory.highBytes === undefined ? '硬顶' : '高水位';
    const text = `常驻进程占用 ${formatBytes(memory.rssBytes)}，已到安装时设的 ${formatBytes(ceiling)} ${kind}；再涨会被限流或重启。我先说一声。`;
    this.trace.append('memory_pressure', {
      rssBytes: memory.rssBytes,
      limitBytes: memory.limitBytes,
      highBytes: memory.highBytes,
      source: memory.source,
    }, at);
    void this.host.bus.emit('companion_emergence', { id: 'health:memory-pressure', reason: 'memory_notice', text });
  }

  /** Keep the inherited stdout/stderr file bounded between restarts. */
  private rotateServiceLog(): void {
    const path = join(this.config.dataDir, 'service.log');
    try {
      if (!rotateLogFile(path, SERVICE_LOG_MAX_BYTES)) return;
      this.trace.append('service_log_rotated', { path, maxBytes: SERVICE_LOG_MAX_BYTES, rotated: `${path}.1` });
    } catch (error) {
      this.trace.append('service_log_rotate_failed', { path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** WAKING means the block is written into runtime state, not just into the trace. */
  injectTimeContext(reason: string, at = this.now()): void {
    let kernelLine: string[] = [];
    try {
      const context = this.backend.temporalContext({ projectId: this.config.projectId, now: at });
      kernelLine = [`activity: ${context.rhythm.phase}; density: ${context.density.label}`];
    } catch (error) {
      this.trace.append('temporal_context_failed', { message: error instanceof Error ? error.message : String(error) });
    }
    const block = this.clock!.timeContextBlock(at, kernelLine);
    this.machine.updateRuntime({ lastTimeContext: block });
    this.trace.append('time_context_injected', { block, reason });
  }

  /** One due intent is one WAKING->IDLE pass; both the dormant and the standby path use it. */
  private async applyDueWakeIntent(at: number): Promise<void> {
    const due = this.clock!.dueWakeIntent(at);
    if (!due) return;
    this.clock!.consumeWakeIntent(due.id);
    await this.machine.dispatch('wake_intent_due', { reason: due.reason });
    this.injectTimeContext(`wake_intent:${due.id}`, at);
    await this.machine.dispatch('context_injected', { reason: 'wake_intent' });
  }

  private async maybeSnapshot(at: number): Promise<void> {
    const last = this.machine.runtime.lastSnapshotAt;
    if (last !== undefined && at - last < SNAPSHOT_INTERVAL_MS) return;
    this.machine.updateRuntime({ lastSnapshotAt: at });
    try {
      const manifest = await this.kernel.backup.snapshot();
      if (manifest) {
        this.trace.append('snapshot_taken', {
          file: manifest.snapshot.file,
          createdAt: manifest.createdAt,
          verification: manifest.verification.ok,
        });
      }
    } catch (error) {
      this.trace.append('snapshot_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private dreamDue(at: number): boolean {
    const clock = this.clock!;
    if (clock.dreamedNight(at)) return false;
    const retry = this.machine.runtime.dreamRetry;
    return !retry
      || retry.night !== clock.dreamNightDate(at)
      || (!retry.gaveUp && retry.nextAt <= at);
  }

  private emptyCatchupTarget(at: number): string | undefined {
    if (this.clock!.dreamWindowOpen(at)) return undefined;
    const localDate = this.clock!.dreamTargetDate(at);
    const events = this.kernel.getThreadEvents(`companion-day:${localDate}`, {
      projectId: this.config.projectId,
      limit: 1,
    });
    return events.length === 0 ? localDate : undefined;
  }

  private dreamSkippedDays(localDate: string): number {
    const last = this.machine.runtime.lastDreamDate;
    return last ? Math.max(0, this.clock!.daysBetween(last, localDate) - 1) : 0;
  }

  private scheduleDreamRetry(night: string, at: number): { attempts: number; nextAt?: number; gaveUp: boolean } {
    const prior = this.machine.runtime.dreamRetry;
    const attempts = prior?.night === night ? prior.attempts + 1 : 1;
    if (attempts >= DREAM_MAX_ATTEMPTS_PER_NIGHT) {
      this.machine.updateRuntime({ dreamRetry: { night, attempts, nextAt: at, gaveUp: true } });
      this.trace.append('dream_retry_scheduled', { night, attempts, gaveUp: true, clockAt: at });
      return { attempts, gaveUp: true };
    }
    const nextAt = at + Math.min(DREAM_RETRY_BASE_MS * 2 ** (attempts - 1), DREAM_RETRY_CAP_MS);
    this.machine.updateRuntime({ dreamRetry: { night, attempts, nextAt } });
    this.trace.append('dream_retry_scheduled', { night, attempts, nextAt, delayMs: nextAt - at, gaveUp: false, clockAt: at });
    return { attempts, nextAt, gaveUp: false };
  }

  async runDream(at = this.now()): Promise<void> {
    const localDate = this.clock!.dreamTargetDate(at);
    const night = this.clock!.dreamNightDate(at);
    const catchup = !this.clock!.dreamWindowOpen(at);
    const skippedDays = this.dreamSkippedDays(localDate);
    if (catchup) this.trace.append('dream_catchup', { dream_catchup: true, localDate, skippedDays });
    await this.machine.dispatch('dream_window_open', { reason: 'dream_window' });
    try {
      const result = await this.dream!.integrate(localDate, `companion-day:${localDate}`, at);
      if (result.memoryModelDegraded === 'semantic_processor_failed') this.memoryModelFailed = true;
      else if (result.memoryModelUsed) this.memoryModelFailed = false;
      this.clock!.markDreamed(at);
      try {
        const promotion = this.kernel.promoteDreamCandidates({ projectId: this.config.projectId, limit: 100 });
        this.trace.append('dream_promotion', { promoted: promotion.promotedCandidates, decisions: promotion.decisions.length });
      } catch (error) {
        this.trace.append('dream_promotion_failed', { message: error instanceof Error ? error.message : String(error) });
      }
      this.machine.updateRuntime({
        dreamRetry: undefined,
        ...(result.kernelNightRan ? { lastSnapshotAt: at } : {}),
      });
      this.clock!.setWakeIntent(at + 8 * 60 * 60_000, 'morning_after_dream');
      this.trace.append('dream_complete', {
        localDate,
        eventCount: result.eventCount,
        sourceRefs: result.sourceRefs.length,
        dream_catchup: catchup,
        skippedDays,
      });
      void this.host.bus.emit('companion_dream', { product: { localDate, eventCount: result.eventCount, summary: result.summary } });
      // A message that arrived while the integration was awaiting wakes the shell out of DREAMING.
      // The product is already written; the transition belongs to whoever moved the state, not to us.
      if (this.machine.state !== 'DREAMING') {
        this.trace.append('dream_finished_after_wake', { localDate, state: this.machine.state });
        return;
      }
      await this.machine.dispatch('dream_complete', { reason: `dream:${localDate}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retry = this.scheduleDreamRetry(night, at);
      this.trace.append('dream_failed', {
        localDate,
        message,
        clockAt: at,
        attempt: retry.attempts,
        nextAt: retry.nextAt ?? null,
        gaveUp: retry.gaveUp,
      });
      await this.machine.dispatch('run_error', { reason: `dream_failed:${message}` });
    }
  }

  currentStatus(): StatusState {
    return this.statusFace.currentStatus();
  }

  currentWork(): WorkState {
    return this.statusFace.currentWork();
  }

  currentQueued(): string[] {
    return this.statusFace.currentQueued();
  }

  withdrawSteering(): string | undefined {
    return this.statusFace.withdrawSteering();
  }

  interruptedRun(): { runId: string; text: string; chars: number } | undefined {
    return this.statusFace.interruptedRun();
  }

  async sleep(): Promise<void> {
    return this.statusFace.sleep();
  }

  awayReport(): PresenceReport {
    return this.statusFace.awayReport();
  }

  attachChanged(count: number): void {
    this.statusFace.attachChanged(count);
  }

  // ---- The install's first-wake probe (#203), asked over the same control socket. ----
  //
  // The installer is out of process and the resident holds the one writer on the database, so the
  // probe is a request to the resident rather than a second kernel opened on the same file. Both
  // halves are deterministic (`rememberTurnWithResult` / `recall`), so nothing here needs a model.

  async probeRemember(text: string, turnId?: string): Promise<{ ok: boolean; text: string }> {
    try {
      const result = await this.backend.rememberTurnWithResult({
        agentId: this.config.agentId,
        projectId: this.config.projectId,
        sessionId: this.config.sessionId,
        ...(turnId ? { turnId } : {}),
        userText: text,
      });
      return { ok: true, text: result.rawEventIds.join(',') };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  }

  async probeRecall(query: string): Promise<{ ok: boolean; text: string }> {
    try {
      const result = this.backend.recall({ agentId: this.config.agentId, projectId: this.config.projectId, query, limit: 5 });
      return { ok: true, text: result.items.map((item) => item.text).join('\n') };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The install's semantic probe (#280): run one real embedding and report its dimension. A lexical
   * recall cannot stand in for this, because the whole failure mode is recall silently falling back
   * to lexical while the self-check still looks green.
   */
  async probeEmbed(text: string): Promise<{ ok: boolean; text: string; dimensions?: number }> {
    if (!this.embeddingProvider) return { ok: false, text: 'embedding host not enabled for this process' };
    try {
      const vector = await this.embeddingProvider.embed(text);
      return { ok: true, text: `dimensions=${vector.length}`, dimensions: vector.length };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  }

  commitments(): Array<{ candidateId: string; title: string; status: string; updatedAt: number }> {
    try {
      return this.kernel.prospectiveMemoryService
        .list({ projectId: this.config.projectId, statuses: ['pending', 'confirmed', 'deferred', 'completed'], limit: 100 })
        .map((record) => ({ candidateId: record.candidateId, title: record.title, status: record.status, updatedAt: record.updatedAt }));
    } catch (error) {
      this.trace.append('commitments_read_failed', { message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  candidateQueue(): ReturnType<CommandHost['candidateQueue']> {
    const projectId = this.config.projectId;
    return {
      counts: this.kernel.getDreamCandidateQueue(projectId),
      items: this.kernel
        .listDreamCandidates({ projectId, statuses: ['candidate', 'needs_confirmation', 'shadow'], limit: 50 })
        .map((candidate) => ({
          candidateId: candidate.candidateId,
          runId: candidate.runId,
          candidateType: candidate.candidateType,
          status: candidate.status,
          confidence: candidate.confidence,
          createdAt: candidate.createdAt,
          statusReason: candidate.statusReason,
          promotionTargetType: candidate.promotionTargetType,
        })),
    };
  }

  stopSurfacing(type?: string): CommandReply {
    const last = type === undefined ? [...this.surfacedByType.entries()].at(-1) : undefined;
    const source = (type ?? last?.[0]) as SurfacingSource | undefined;
    const entry = type === undefined ? last?.[1] : this.surfacedByType.get(type as SurfacingSource);
    if (!entry) return { text: '还没有浮现过该来源，无法停下。', receipt: true };
    this.writeSurfacingFeedback(entry, 'stopped');
    if (source !== undefined) this.surfacedByType.delete(source);
    return { text: `已停下 ${source} 的主动浮现；/surfacing resume <来源> 恢复。`, receipt: true };
  }

  resumeSurfacing(type: string): CommandReply {
    try {
      this.backend.resumeSurfacingType({ projectId: this.config.projectId, type: type as SurfacingSource, now: this.now() });
      return { text: `已恢复 ${type} 的主动浮现。`, receipt: true };
    } catch (error) {
      return { text: `恢复失败：${error instanceof Error ? error.message : String(error)}`, receipt: true };
    }
  }

  snooze(minutes: number, commitmentId?: string): CommandReply {
    const projectId = this.config.projectId;
    const now = this.now();
    const surfaced = this.surfacedByType.get('commitment')?.candidateId;
    const surfacedId = surfaced?.startsWith('surfacing:commitment:') ? surfaced.slice('surfacing:commitment:'.length) : undefined;
    const entries = this.backend.listCommitments({ projectId, statuses: ['due_soon', 'overdue'], now });
    const target = commitmentId ?? surfacedId;
    const entry = target === undefined
      ? entries[0]
      : entries.find((item) => item.commitmentId === target);
    if (!entry) return { text: target === undefined ? '没有到期的承诺可以顺延。' : `没找到到期的承诺：${target}`, receipt: true };
    try {
      const snoozed = this.backend.snoozeCommitment({ projectId, commitmentId: entry.commitmentId, resumeAt: now + minutes * 60_000, reason: 'owner_snooze', now });
      return {
        text: `已顺延「${snoozed.content}」到 ${new Date(snoozed.resumeAt ?? now + minutes * 60_000).toISOString()}。`,
        receipt: true,
        data: { companion_snooze: { commitmentId: snoozed.commitmentId, resumeAt: snoozed.resumeAt, snoozeCount: snoozed.snoozeCount } },
      };
    } catch (error) {
      return { text: `顺延失败：${error instanceof Error ? error.message : String(error)}`, receipt: true };
    }
  }

  wake(minutes: number, reason: string): CommandReply {
    const now = this.now();
    try {
      const intention = this.backend.registerWakeIntention({
        projectId: this.config.projectId,
        agentId: this.config.agentId,
        at: now + minutes * 60_000,
        reason,
        sourceRefs: [{ sourceId: `${this.config.agentId}:wake-command` }],
        now,
      });
      this.trace.append('wake_intention_registered', { intentionId: intention.intentionId, at: intention.at, reason });
      return {
        text: `醒来意图已登记：${new Date(intention.at).toISOString()}（${reason}）。`,
        receipt: true,
        data: { companion_wake: { intentionId: intention.intentionId, at: intention.at, reason } },
      };
    } catch (error) {
      return { text: `登记失败：${error instanceof Error ? error.message : String(error)}`, receipt: true };
    }
  }


  forgetPreview(start: number, end: number): CommandReply {
    return this.sovereignty.forgetPreview(start, end);
  }

  forgetConfirm(): CommandReply {
    return this.sovereignty.forgetConfirm();
  }

  exportMemory(path: string | undefined): CommandReply {
    return this.sovereignty.exportMemory(path);
  }

  correctProfile(key: string, value: string): Promise<CommandReply> {
    return this.sovereignty.correctProfile(key, value);
  }

  confirmProcedureCorrection(): Promise<CommandReply> {
    return this.sovereignty.confirmProcedureCorrection();
  }

  /** The TUI route list; with no router (an injected provider) it is just the one label, as before. */
  modelRoutes(): string[] {
    return this.modelRouter ? this.modelRouter.labels() : [this.modelLabel];
  }

  /**
   * Switch the active route in place. The runtime holds this router object, so the next turn's request
   * uses the new endpoint: no restart, no checkpoint rewrite, the session is untouched. A stored
   * switch is remembered by the route store; the built-in mg route is not persisted because it is not
   * user configuration.
   */
  switchModelRoute(name: string): { ok: true; name: string; model: string } | { ok: false; message: string } {
    if (!this.modelRouter) return { ok: false, message: '本进程用的是注入的模型提供者，没有路线表可切。' };
    try {
      const route = this.modelRouter.switchTo(name);
      this.modelLabel = `${route.name}/${route.model}`;
      this.memoryModelFailed = false;
      // The key is not in any of these fields; the URL is redacted in case it carries one.
      this.trace.append('model_route_switched', { name: route.name, model: route.model, baseUrl: redactUrl(route.baseUrl, [route.apiKey]) });
      void this.host.bus.emit('companion_model_routes', { routes: this.modelRoutes(), active: route.name });
      return { ok: true, name: route.name, model: route.model };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  snapshotNote(): string | undefined {
    return `checkpoint seq ${this.machine.seq}`;
  }

  /**
   * The resident's one command entry point, shared by the attach socket and the terminal channel.
   * Core names come from the table (`commands.ts`); plugin commands from the host registry; anything
   * else gets the same unknown-command receipt the other two faces give. A handler that throws is
   * attributed to its command name in both the receipt and the trace — never a nameless error.
   */
  async runCommand(name: string, args = ''): Promise<CommandReply> {
    const core = coreCommandFor(name, 'resident');
    if (core) return this.runCommandGuarded(name, () => core.run(this.commandHost, args));
    if (this.host.commands.has(name)) {
      return this.runCommandGuarded(name, async () => ({ text: (await this.host.commands.run(name, args, this)) ?? '', receipt: true }));
    }
    return unknownCommandReply(name);
  }

  private async runCommandGuarded(name: string, invoke: () => CommandReply | Promise<CommandReply>): Promise<CommandReply> {
    try {
      return await invoke();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace.append('command_failed', { command: name, message });
      return { text: `命令 /${name} 失败：${message}`, receipt: true };
    }
  }

  async confirmProposal(id: string): Promise<{ ok: boolean; proposal?: CommandProposal; reason?: string; reply?: CommandReply }> {
    return this.proposalsHandlers.confirmProposal(id);
  }

  discardProposal(id: string): CommandProposal | undefined {
    return this.proposalsHandlers.discardProposal(id);
  }

  currentProposals(): CommandProposal[] {
    return this.proposalsHandlers.currentProposals();
  }

  offerResume(suspensionId: string): void {
    this.proposalsHandlers.offerResume(suspensionId);
  }

  continueSuspended(): CommandReply {
    return this.proposalsHandlers.continueSuspended();
  }

  supersedeSuspension(reason: string): void {
    this.proposalsHandlers.supersedeSuspension(reason);
  }

  askUser(input: { question: string; context?: string }): { ok: boolean; text: string } {
    return this.proposalsHandlers.askUser(input);
  }

  declareTask(input: { action?: string; runId?: string; domain?: string; key?: string; checklist?: boolean }): { ok: boolean; text: string } {
    return this.proposalsHandlers.declareTask(input);
  }

  /**
   * What the palette's command table may ask of the shell. It exists so the handlers can live in
   * `commands.ts` (one table for every face) without moving the shell's private state out of the
   * class: each arrow reads `this` at call time.
   */
  private readonly commandHost: CommandHost = {
    config: () => this.config,
    lifecycle: () => ({ state: this.machine.state, seq: this.machine.seq, costDayTokens: this.machine.runtime.costDayTokens ?? 0, sandbox: this.statusFace.sandboxState() }),
    contextTokens: () => this.contextTokenEstimate,
    contextToolOutput: () => this.lastToolOutput,
    contextLanes: () => (this.lastLaneAssembly ? laneAssemblyView(this.lastLaneAssembly) : undefined),
    contextMetrics: () => this.lastContextMetrics,
    promptCache: () => this.promptCache,
    lastDream: () => this.lastDreamProduct(),
    contextTools: () => this.executableToolNames(),
    commitments: () => this.commitments(),
    candidateQueue: () => this.candidateQueue(),
    surfacingFeedback: () => this.backend.surfacingFeedbackState({ projectId: this.config.projectId, now: this.now() }),
    stopSurfacing: (type: string | undefined) => this.stopSurfacing(type),
    resumeSurfacing: (type: string) => this.resumeSurfacing(type),
    snooze: (minutes: number, commitmentId: string | undefined) => this.snooze(minutes, commitmentId),
    wake: (minutes: number, reason: string) => this.wake(minutes, reason),
    quietWindow: () => (this.config.quiet ? { ...this.config.quiet, active: this.clock!.quietWindowOpen() } : undefined),
    whyReport: () => this.whyReport(),
    capturePaused: () => this.capturePaused,
    setCapturePaused: (paused: boolean) => {
      this.machine.updateRuntime({ capturePaused: paused });
      this.trace.append(paused ? 'capture_paused_command' : 'capture_resumed_command', { at: this.now() });
      this.statusFace.emitStatus();
    },
    continueSuspended: () => this.continueSuspended(),
    forgetPreview: (start: number, end: number) => this.forgetPreview(start, end),
    forgetConfirm: () => this.forgetConfirm(),
    exportMemory: (path: string | undefined) => this.exportMemory(path),
    correctProfile: (key: string, value: string) => this.correctProfile(key, value),
    confirmProcedureCorrection: () => this.confirmProcedureCorrection(),
    sessionModel: () => this.modelLabel,
    modelRoutes: () => this.modelRoutes(),
    modelRouter: () =>
      this.modelRouter
        ? {
            active: this.modelRouter.active,
            lines: this.modelRouter.routes().map((route) => routeLine(
              route,
              route.name === this.modelRouter!.active,
              route.name === BUILTIN_ROUTE_NAME && this.modelRouter!.builtinUnavailable,
            )),
            storeError: this.modelRouter.storeError,
          }
        : undefined,
    switchRoute: (name: string) => this.switchModelRoute(name),
    sleep: () => this.sleep(),
    upgrade: (source: string) => this.upgrade(source),
    pluginReport: () => this.pluginReport(),
    installPlugin: (spec: string) => this.installPlugin(spec),
  };

  /** The palette's plugin half: the resident is the only process that holds the registry. */
  pluginCommands(): Array<{ name: string; description?: string; argumentHint?: string }> {
    return this.host.commands.list().map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
  }

  pluginReport(): CommandReply {
    return this.pluginsAdmin.pluginReport();
  }

  pluginHealth(): {
    registered: string[];
    results: Array<{ spec: string; status: string; version?: string; reason?: string; tools: string[]; commands: string[] }>;
  } {
    return this.pluginsAdmin.pluginHealth();
  }

  installPlugin(spec: string): Promise<CommandReply> {
    return this.pluginsAdmin.installPlugin(spec);
  }

  resumeAfterRequestedRestart(): void {
    this.pluginsAdmin.resumeAfterRequestedRestart();
  }

  whyReport(): string {
    return this.pluginsAdmin.whyReport();
  }

  private lastDreamProduct(): { localDate: string; eventCount: number; summary: string } | undefined {
    return this.pluginsAdmin.lastDreamProduct();
  }

  upgrade(source: string): Promise<CommandReply> {
    return this.upgradeAdmin.upgrade(source);
  }

  private settleUpgradeReport(at: number): void {
    this.upgradeAdmin.settleUpgradeReport(at);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.attach?.stop();
    this.attach = undefined;
    this.terminal?.stop();
    try {
      if (this.machine.state === 'RUNNING') {
        this.runtime?.abort('shutdown');
        await this.machine.dispatch('run_aborted', { reason: 'shutdown' });
      }
      if (this.machine.state === 'DREAMING') await this.machine.dispatch('run_error', { reason: 'shutdown' });
      // A pause outlives the process (#228): writing DORMANT here would drop a question or budget
      // request the owner never answered. The next start restores SUSPENDED and re-offers it; only
      // an explicit decision (approve, refuse, answer) or `/sleep` from IDLE ends a pause.
      if (this.machine.state !== 'DORMANT' && this.machine.state !== 'SUSPENDED') {
        await this.machine.dispatch('shutdown', { reason: 'process_stop' });
      }
    } finally {
      this.http?.stop();
      await this.host.stop();
      this.kernel.close();
      this.lock.release(process.pid);
      this.trace.append('shell_stopped', { state: this.machine.state });
    }
  }
}


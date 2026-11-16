/**
 * Assembly: the three core pieces (state machine, plugin host, kernel connection) wired to the
 * plugins that carry every capability.
 *
 * The app is also the only place that knows the transition triggers' meanings — a message wakes the
 * shell, a due intent re-injects the clock, the cage's overrun leaves RUNNING. Plugins decide
 * behaviour; the app decides which transition that behaviour is.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChannelContract, createMemoryKernel, KernelAgentMemoryBackend, type ChannelSession, type EmbeddingProvider, type MemoryKernel, type ProcedureWorkflow, type SessionContextAssembly, type SessionContextItem } from 'cogmem';
import { ModelRegistry, TraceStore, type ModelRoleConfig, type ModelRoleName, type ModelTextUsage } from 'cogmem/internal';
import { defaultShellConfig, type ShellConfig } from './config.ts';
import { StateMachine } from './state/machine.ts';
import { CheckpointStore, type InFlightToolCall, type Suspension } from './state/checkpoint.ts';
import type { Trigger } from './state/table.ts';
import { ProcessLock } from './process-lock.ts';
import { TraceLog } from './trace.ts';
import { PluginHost } from './plugins/host.ts';
import { clockPlugin, ClockService } from './plugins/clock.ts';
import { providedModelPlugin } from './plugins/mg-provider.ts';
import { ModelRouter, modelRouterPlugin, routeLine } from './model/router.ts';
import { RouteStore, redactUrl } from './model/routes.ts';
import { cagePlugin, estimateBudgetGrant, RunCage, type CageTier } from './plugins/cage.ts';
import { builtinToolsPlugin } from './plugins/builtin-tools.ts';
import { webPlugin } from './plugins/web.ts';
import { coreCommandFor, availableCoreCommand, unknownCommandReply, type CommandHost, type CommandReply } from './commands.ts';
import { proposalPlugin } from './plugins/proposal.ts';
import { askPlugin } from './plugins/ask.ts';
import { hygienePlugin } from './plugins/hygiene.ts';
import { WorkflowService, workflowsPlugin } from './plugins/workflows.ts';
import { CommandProposals, executeProposal, type CommandProposal, type ProposalConfirmation } from './proposals.ts';
import { capturePlugin } from './plugins/capture.ts';
import { sessionContextPlugin } from './plugins/session-context.ts';
import { assignmentPlugin } from './plugins/assignment.ts';
import { recallPlugin } from './plugins/recall.ts';
import { soulEditPlugin } from './plugins/soul-edit.ts';
import { HygienePipeline } from './hygiene.ts';
import { dreamPlugin } from './plugins/dream.ts';
import { emergencePlugin } from './plugins/emergence.ts';
import { terminalPlugin, TerminalChannel, type ShellControl } from './channels/terminal.ts';
import { AgentRuntime, type AgentMessage, type ModelProvider, type RunSummary, type TurnUsage } from './state/agent-loop.ts';
import { laneAssemblyView } from './state/session-lanes.ts';
import { SecretRedactor, startKernelHttpFace, type HttpFaceHandle } from './kernel-host.ts';
import { formatBytes, memoryPressureAction, readMemoryUsage } from './memory.ts';
import { rotateLogFile, SERVICE_LOG_MAX_BYTES } from './log-rotation.ts';
import { defaultRunner } from './install/installer.ts';
import { AttachServer, defaultSocketPath, type AttachShell } from './attach/server.ts';
import { buildAwayReport, enqueueAway } from './presence.ts';
import { readInstallState, readTreeVersion, serviceFileExists, shellDirOfTree, treeOfThisProcess } from './upgrade/paths.ts';
import { restartService, servicePath, type Platform, type ServiceSpec } from './install/service.ts';
import { pluginsConfigPath, readPluginRegistry, writePluginRegistry } from './plugins/registry.ts';
import { loadNativePlugins, type PluginLoadResult } from './plugins/load.ts';
import { stageUpgradeTree } from './upgrade/stage.ts';
import { spawnUpgradeSupervisor, type SpawnSupervisorResult } from './upgrade/spawn.ts';
import {
  clearUpgradeRequest,
  describeUpgradeOutcome,
  isUpgradePromise,
  newUpgradeId,
  readUpgradeOutcome,
  readUpgradeRequest,
  upgradeOutcomePath,
  supervisorIsAlive,
  upgradePromiseReason,
  upgradeRequestPath,
  writeUpgradeJson,
  type UpgradeOutcome,
  type UpgradeRequest,
} from './upgrade/records.ts';
import type { PresenceReport, StatusState, WorkState } from './tui/view.ts';
import { XenovaEmbeddingProvider, type EmbeddingStatus } from './embedding/xenova.ts';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './embedding/model.ts';

/**
 * How long the resident gives the supervisor before the promise's due instant arrives. The report is
 * what the promise is for; this is the "how long is still working" half of it. The supervisor's own
 * pid decides the rest (see `settleUpgradeReport`).
 */
const UPGRADE_REPORT_GRACE_MS = 60_000;

/**
 * The plugin restart's grace. The reply to `/plugins add` (and its trace) must reach the attach
 * socket and the log before systemd's SIGTERM takes the process down, or the user sees a command
 * that neither answered nor left a record. Same spirit as the upgrade's handoff grace, sized for one
 * socket write rather than a whole announcement.
 */
const PLUGIN_RESTART_GRACE_MS = 300;

/** The findings handoff is a prompt line, not a transcript: one bounded paragraph. */
const MAX_ASSIGNMENT_FINDINGS = 600;

/**
 * Autonomous continuation backoff (#228): 5 min × 2^n, capped at 6 h. The base is the shortest wait
 * that still lets a transient provider failure clear; the cap is what a stuck task costs at most —
 * after the ladder saturates, an unattended assignment is retried about four times a day instead of
 * every wake, which is the repeated-recon burn the ticket names. A user line, an approved budget, or
 * a successful tool result resets the count, so the cap never applies to work that is moving.
 */
const RESUME_BACKOFF_BASE_MS = 5 * 60_000;
const RESUME_BACKOFF_CAP_MS = 6 * 60 * 60_000;

/**
 * Emergence's stop-bleed (#229). A candidate is spoken or queued at most once, never twice within
 * two minutes, and at most eight times in a Tokyo day. The count is checkpointed, so a restart
 * cannot reset today's silence. The cooldown stays below #228's 5-minute resume backoff, or a
 * deferred surfacing run could never happen while an assignment is waiting.
 *
 * shortcut: the consumed-key list keeps the newest 500; an event older than that may surface once
 * more. Raise the cap if a resident ever accumulates candidates faster than 500 per lifetime.
 */
const EMERGENCE_COOLDOWN_MS = 2 * 60_000;
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

  override getRoleConfig(role: ModelRoleName): ModelRoleConfig {
    const config = super.getRoleConfig(role);
    if (role !== 'embedding' || this.embeddingReady) return config;
    return { ...config, provider: 'deterministic_local', modelName: 'deterministic_local' };
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
  /** The hygiene gate every self-written skill, plugin or rule proposal passes before review (#228). */
  readonly hygiene: HygienePipeline;
  private runtime?: AgentRuntime;
  private cage?: RunCage;
  private workflows?: WorkflowService;
  private clock?: ClockService;
  private dream?: { integrate(...args: [string, string, number?]): Promise<{ localDate: string; eventCount: number; sourceRefs: unknown[]; summary: string }> };
  private emergence?: {
    hasDue?(now?: number): boolean;
    decide(now?: number): {
      candidates: Array<{ id: string; text: string; reason: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }>;
      suppressed: unknown[];
    };
  };
  private http?: HttpFaceHandle;
  private terminal?: TerminalChannel;
  private readonly channelContract: ChannelContract;
  private readonly terminalSession: ChannelSession;
  private attach?: AttachServer;
  private modelLabel = 'unknown';
  /** Present only when this process built its own provider; an injected test provider has no routes. */
  private modelRouter?: ModelRouter;
  /** The request-side estimate, calibrated by the provider's reported prompt count. */
  private contextTokenEstimate = 0;
  /** The newest six-lane assembly; `/context` and the TUI read this, not a second accounting. */
  private lastLaneAssembly?: SessionContextAssembly;
  /** The latest project event the compiled books were last brought up to. */
  private compiledThroughEventId?: string;
  /** Whether a soul-read failure has been traced; the read itself is retried on the next turn. */
  private soulFailureTraced = false;
  private workLabel = '';
  private runTurns = 0;
  private runTokens = 0;
  /** The tier this process last started a run with; the work bar shows that tier's limits. */
  private runTier: CageTier = 'autonomous';
  /**
   * The provider's own prompt-cache account for the run in flight (#165 round 21): `hit` is what the
   * endpoint reported served from cache, `miss` the remainder of the prompt, `percent` their ratio.
   * Absent until a provider reports a cache field — and absent is shown as nothing, never as 0%, so a
   * provider that never reports caching cannot look like a provider that always misses. Round 17's
   * estimate is not this number and never fills it.
   */
  private promptCache?: { hit: number; miss: number; percent: number };
  private runStartedAt?: number;
  /**
   * The killed run's prompt, rebuilt from the session log at recovery (#210). Delivery is a product
   * decision the shell does not make; holding it means the interrupted turn is reconstructable.
   */
  private interrupted?: { runId: string; text: string; chars: number };
  /** An upgrade outcome already spoken by this process; attaches read it once, then it is gone. */
  private lastUpgrade?: UpgradeOutcome;
  /** One memory notice per crossing, reset after we drop below 90% of the ceiling. */
  private memoryWarned = false;
  /** The day whose daily-budget stop was already spoken to the user (#233). */
  private dailyNotifiedDay?: string;
  /** The Dream model's spend for the current night, charged to the same day counter (#231). */
  private nightSpent = 0;
  private nightCap = 0;
  private nightDay?: string;
  private nightStartTokens = 0;
  private dreamModelActive = false;
  /**
   * The window `/forget` previewed and `/forget confirm` may execute. Process-local: a restart
   * asks for a fresh preview rather than resuming a confirmation the owner can no longer see.
   */
  private pendingForget?: { start: number; end: number };
  /**
   * The practice `/correct` proposed and `/correct confirm` may write (#264). Process-local for the
   * same reason as the forget window: a confirmation must belong to a proposal the owner just saw.
   */
  private pendingProcedureCorrection?: { domain: string; key: string; value: string; title: string; steps: string[] };
  /**
   * A question the run registered through `ask_user` (#228). It is process-local because the run is
   * still in this process; `settleAssignment` turns it into the checkpointed suspension.
   */
  private pendingQuestion?: { text: string; contextRef?: string; approvalId?: string };
  /** The proposal that offers `/continue` for the current pause; Esc on it is the owner's refusal. */
  private suspensionProposalId?: string;
  /**
   * An autonomous wake that is backed off must not continue the open assignment, so its prompt must
   * not carry the assignment block either — otherwise the model would try anyway.
   */
  private hideAssignmentContext = false;
  private readonly redactor = new SecretRedactor();
  private tickTimer?: ReturnType<typeof setInterval>;
  private started = false;
  private readonly now: () => number;
  /** This process's native plugin load outcomes; `/plugins` and `/health` read it. */
  readonly pluginResults: PluginLoadResult[] = [];
  private readonly embedding?: XenovaEmbeddingProvider;
  private readonly shellRegistry?: ShellModelRegistry;
  private reEmbedRunning = false;

  constructor(private readonly options: CompanionShellOptions = {}) {
    this.config = defaultShellConfig(options.config);
    this.now = options.now ?? Date.now;
    this.trace = new TraceLog(this.config.dataDir);
    this.hygiene = new HygienePipeline({
      trace: this.trace,
      now: this.now,
      askOwner: (input) => this.askUser(input),
    });
    this.machine = new StateMachine({
      checkpoint: new CheckpointStore(this.config.dataDir),
      trace: this.trace,
      clock: this.now,
      onAlarm: (error) => {
        console.error(`[companion-shell] ALARM: ${error.message}; halting`);
        this.options.onAlarm?.(error);
      },
    });
    this.lock = new ProcessLock(this.config.dataDir);
    // The nightly snapshot lives beside the resident's other state, so a default install keeps the
    // last seven nights without an extra config key (#196).
    const registry = options.modelRegistry ?? this.buildModelRegistry();
    this.shellRegistry = registry instanceof ShellModelRegistry ? registry : undefined;
    const embeddingProvider = options.embeddingProvider
      ?? (options.embedding ? new XenovaEmbeddingProvider(this.config.dataDir) : undefined);
    this.embedding = embeddingProvider instanceof XenovaEmbeddingProvider ? embeddingProvider : undefined;
    this.kernel = createMemoryKernel({
      dbPath: this.config.dbPath,
      projectTimeZone: this.config.timeZone,
      snapshotsDir: join(this.config.dataDir, 'snapshots'),
      modelRegistry: registry,
      ...(embeddingProvider ? { embeddingProvider } : {}),
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
    this.host.seedService('hygiene', this.hygiene);
    // The proposal registry (spec §7, #165 round 22). Its availability rule is the palette's, asked
    // on the resident's face — the face a confirmed proposal executes on — so the panel and the
    // proposal path cannot disagree about what is runnable.
    this.proposals = new CommandProposals(
      (command) => availableCoreCommand(command, 'resident', { multipleRoutes: this.modelRoutes().length > 1 }) !== undefined,
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
      this.emitWork();
      this.emitStatus();
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

  /**
   * The shell's memory role is the mg route it already uses for its own turns. The embedding role
   * names the local model, but `ShellModelRegistry` keeps it deterministic until the model has
   * actually loaded: the kernel then reports `semanticIndex: false` rather than claiming an index it
   * does not have (#231/#250).
   */
  private buildModelRegistry(): ShellModelRegistry {
    const model = this.config.model;
    return new ShellModelRegistry({
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
        modelName: EMBEDDING_MODEL,
        timeoutMs: 30_000,
      },
    }, {
      beforeGenerate: () => this.beforeDreamModelCall(),
      onUsage: (_role, usage) => this.chargeDreamModelUsage(usage),
    });
  }

  private beginDreamModelBudget(at: number): void {
    const day = tokyoDate(at);
    const spent = this.dailySpent(at);
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
    if (this.dailyBudgetExceeded()) {
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
    this.chargeCost(tokens);
    this.nightSpent = Math.max(0, this.dailySpent() - this.nightStartTokens);
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
        // Pi #10000's durable prompt is what the interrupted turn hangs on: the checkpoint's display
        // copy stops at 500 chars, the session log does not.
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
          suspension: this.machine.runtime.suspension
            ? { ...this.suspendedLine(this.machine.runtime.suspension), id: this.machine.runtime.suspension.id, createdAt: this.machine.runtime.suspension.createdAt }
            : null,
        }),
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
      modelId: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      detail: 'embedding host not enabled for this process',
    };
  }

  private async warmEmbedding(): Promise<void> {
    if (!this.embedding) return;
    try {
      await this.embedding.warm();
      if (this.shellRegistry) this.shellRegistry.embeddingReady = true;
      this.trace.append('embedding_ready', {
        modelId: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        loadMs: this.embedding.status().loadMs ?? null,
      });
      await this.reEmbedExisting();
    } catch (error) {
      // A missing model, a failed download or a broken ONNX file all land here. The companion keeps
      // answering with lexical recall; health and this trace record why.
      this.trace.append('embedding_unavailable', {
        modelId: EMBEDDING_MODEL,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The migration for a brain written before this process had vectors (#231 Route A). The pipeline
   * is idempotent and checkpoints its cursor, so a second run is a no-op and a killed run resumes.
   * Batches are yielded between passes so a recall never waits for a whole brain.
   */
  private async reEmbedExisting(): Promise<void> {
    if (this.reEmbedRunning) return;
    this.reEmbedRunning = true;
    const projectId = this.config.projectId;
    let processed = 0;
    try {
      for (let pass = 0; pass < 1_000; pass += 1) {
        const result = await this.kernel.reEmbed(projectId);
        processed += result.processed;
        if (result.processed === 0 && result.remaining === 0) {
          this.trace.append('re_embed_skipped', { projectId });
          break;
        }
        this.trace.append('re_embed_progress', {
          projectId,
          processed: result.processed,
          remaining: result.remaining,
          totalProcessed: processed,
        });
        if (result.remaining === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.trace.append('re_embed_completed', { projectId, processed });
    } catch (error) {
      this.trace.append('re_embed_failed', {
        projectId,
        processed,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.reEmbedRunning = false;
    }
  }

  private async startPlugins(): Promise<void> {
    // An injected provider (tests, an embedding host) is used as-is and has no route table. The real
    // resident gets a router: the mg route from env plus whatever named routes the user stored.
    let provider = this.options.modelProvider ? providedModelPlugin(this.options.modelProvider) : undefined;
    if (!provider) {
      this.modelRouter = new ModelRouter({
        store: new RouteStore(join(this.config.dataDir, 'routes.json')).load(),
        builtin: { name: 'mg', baseUrl: this.config.model.baseUrl, apiKey: this.config.model.apiKey, model: this.config.model.model, targetTokens: this.config.contextSweetSpot },
        timeoutMs: this.config.model.timeoutMs,
      });
      // A routes file that did not parse is a real problem the user must see, but it must not stop the
      // resident: mg is available either way.
      if (this.modelRouter.storeError) this.trace.append('model_routes_load_failed', { message: this.modelRouter.storeError });
      provider = modelRouterPlugin(this.modelRouter);
    }
    this.host.register(clockPlugin({ timeZone: this.config.timeZone, idleWakeIntervalMs: this.config.idleWakeIntervalMs, dreamWindow: { startHour: this.config.dream.windowStartHour, endHour: this.config.dream.windowEndHour } }));
    this.host.register(provider, this.config.model);
    this.host.register(cagePlugin(this.config.budgets, this.trace, { ...this.config.workBudget, toolWhitelist: this.config.budgets.toolWhitelist }));
    this.host.register(builtinToolsPlugin(), {
      workspaceRoot: this.config.workspaceRoot,
      dataDir: this.config.dataDir,
      trace: this.trace,
      kernel: this.kernel,
    });
    this.host.register(workflowsPlugin({
      agentId: this.config.agentId,
      projectId: this.config.projectId,
      sessionId: this.config.sessionId,
      workspaceRoot: this.config.workspaceRoot,
      tools: this.host.tools,
      prompt: (input) => this.recordPrompt(input),
    }));
    this.host.register(webPlugin({ dataDir: this.config.dataDir }));
    this.host.register(proposalPlugin());
    this.host.register(askPlugin());
    this.host.register(assignmentPlugin());
    this.host.register(hygienePlugin());
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
      variablePrompt: () => this.systemPromptSections().tail,
      onAssembly: (assembly) => {
        this.lastLaneAssembly = assembly;
        this.emitStatus();
      },
      recallLimit: 3,
    }));
    this.host.register(recallPlugin({ agentId: this.config.agentId, projectId: this.config.projectId, limit: 3 }));
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
      if (result.status === 'failed') {
        // A failure a user cannot see is a failure they will blame on the plugin that did load. The
        // notice waits until here because the terminal plugin subscribes during `host.start()`.
        void this.host.bus.emit('terminal_print', { text: `plugin ${result.spec} failed to load: ${result.reason}\n` });
      }
      if (result.status !== 'loaded' || !result.name) continue;
      result.tools = this.host.tools.list().filter((tool) => tool.source === `plugin:${result.name}`).map((tool) => tool.name);
      result.commands = this.host.commands.list().filter((command) => command.source === `plugin:${result.name}`).map((command) => command.name);
    }
    this.clock = this.host.getService<ClockService>('clock');
    this.cage = this.host.getService<RunCage>('cage');
    this.workflows = this.host.getService<WorkflowService>('workflows');
    const model = this.host.getService<ModelProvider>('model');
    this.runtime = new AgentRuntime({
      bus: this.host.bus,
      // Pi #10000: the whole prompt is durable before the model call, redacted so the log never holds a
      // secret the ledger would have stripped. The checkpoint keeps only the 500-char display copy.
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
      onContextAssembled: (account) => {
        this.contextTokenEstimate = account.totalTokens;
        this.emitStatus();
      },
      contextLanes: () => (this.lastLaneAssembly ? laneAssemblyView(this.lastLaneAssembly) : undefined),
    });
    this.modelLabel = `${this.host.getService<ModelProvider>('model').name}/${model.model}`;
    this.attachWorkListeners();
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

  /**
   * The system prompt is assembled from two sections, and the split is a contract, not a layout
   * choice. The **pinned zone** is the soul (verbatim, at its head), the identity and the rules: its
   * bytes must be identical from one request to the next, which is what F14's lane order starts with
   * (#191) and the half of it a provider-side prompt cache can hit. The **variable tail** is the only
   * place per-turn content may live; today that is the time context, which is why it is rebuilt from
   * the live clock on every call instead of reusing the block written at the last wake — a prompt
   * that froze "now" at boot kept telling the model it was still morning three hours later.
   *
   * Pi holds the same property structurally: named sections rendered in a fixed order, diffed so a
   * changed section travels as an update instead of the prompt being re-sent (`core/system-prompt.js`
   * `buildSystemPromptSections` / `diffSystemPromptSections`), and a tool list frozen so "the cached
   * prefix survives every tool change" (`pi-ai/dist/api/anthropic-messages.js:947-951`). The shell has
   * one seam and no mid-run prompt mutation, so the pinned zone is what plays that part.
   */
  systemPromptSections(): { pinned: string; tail: string } {
    const pinned = [
      this.soulText(),
      'You are a resident companion agent whose memory is Cogmem. Memory comes first: recall before you answer, and let what you remember shape how you say it.',
      'You are present at all hours; when nothing needs you, you are quiet rather than chatty.',
      'You have four basic tools (read, write, edit, bash). Use them when the moment needs real work; otherwise just talk.',
      'To hand the user a shell command, call `propose_command` with the command and a one-line reason. It is only an offer: the command runs when the user confirms it, never before, so never say it already ran.',
      'A new user line continues the open task by default. Call `declare_task` with action "start" only when the newest line begins a different task, and with "end" when the open task is finished. Judge by meaning, never by a word.',
      'Never invent a memory. If recall is empty, say so plainly.',
    ].filter(Boolean);
    const tail = [this.clock ? this.clock.timeContextBlock(this.now()) : '', this.openAssignmentBlock(), this.suspensionBlock()].filter(Boolean);
    return { pinned: pinned.join('\n\n'), tail: tail.join('\n\n') };
  }

  /**
   * The open assignment as the `working_set` lane's first open loop. A budget stop writes where it
   * stopped and what is next; the next run (user or autonomous wake) reads it verbatim, so the work
   * does not restart from the same file read.
   */
  private openAssignmentBlock(): string {
    const assignment = this.machine.runtime.openAssignment;
    if (!assignment || this.hideAssignmentContext) return '';
    return [
      '<open-assignment>',
      `user-assigned task: ${assignment.text}`,
      assignment.stoppedStep ? `stopped at: ${assignment.stoppedStep}` : '',
      assignment.nextStep ? `next: ${assignment.nextStep}` : '',
      assignment.findings ? `confirmed findings: ${assignment.findings}` : '',
      '</open-assignment>',
    ].filter(Boolean).join('\n');
  }

  /**
   * The resumed run's half of a question pause (#228): the answer is the run's user text, and this
   * block is what makes that answer answerable. It is rendered only while the object exists, which
   * is until the resumed run settles — the question object is gone from an idle shell.
   */
  private suspensionBlock(): string {
    const suspension = this.machine.runtime.suspension;
    if (!suspension || suspension.kind !== 'question' || suspension.question === undefined) return '';
    return [
      '<pending-question>',
      `you asked: ${suspension.question.text}`,
      suspension.question.contextRef ? `about: ${suspension.question.contextRef}` : '',
      "the user's next line is the answer; continue the open task from it.",
      '</pending-question>',
    ].filter(Boolean).join('\n');
  }

  systemPrompt(): string {
    const { pinned, tail } = this.systemPromptSections();
    return [pinned, tail].filter(Boolean).join('\n\n');
  }

  /** The active model route's sweet spot, with the shell config as the built-in route's value. */
  private targetTokens(): number {
    return this.modelRouter?.targetTokens ?? this.config.contextSweetSpot;
  }

  /** The stable pinned lane: the soul and the shell's rules, split into renderable paragraphs. */
  private lanePinned(): string[] {
    return this.systemPromptSections().pinned.split('\n\n').filter(Boolean);
  }

  /** The compiled profile's current entries, one renderable line per entry. */
  private laneProfile(): string[] {
    try {
      return this.kernel.profile
        .entries({ projectId: this.config.projectId })
        .map((entry) => `${entry.ledger}/${entry.key}: ${entry.value}`);
    } catch (error) {
      this.trace.append('profile_lane_failed', { message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /** The open loops that must survive a restart: the open assignment and unconsumed wake intents. */
  private laneOpenLoops(): SessionContextItem[] {
    const items: SessionContextItem[] = [];
    const assignment = this.machine.runtime.openAssignment;
    const assignmentText = this.openAssignmentBlock();
    if (assignment && assignmentText) {
      items.push({ id: `assignment:${assignment.id}`, text: assignmentText });
    }
    for (const intent of this.machine.wakeIntents) {
      if (intent.consumedAt) continue;
      items.push({
        id: `wake:${intent.id}`,
        text: `wake intent: ${intent.reason} (scheduled ${new Date(intent.at).toISOString()})`,
        protected: true,
      });
    }
    return items;
  }

  /**
   * The newest soul row, read where it is: it is the pinned zone's head, so it is injected verbatim,
   * and F17's editor has to reach the next request without a restart. A database with no row is not
   * a turn failure — the pinned zone is simply shorter. A real read failure is recorded once, so an
   * absent soul and a soul that failed to load stay distinguishable.
   */
  private soulText(): string {
    try {
      return this.kernel.soul.read(this.config.agentId)?.content ?? '';
    } catch (error) {
      // The read is retried every turn — a lock held for a moment must not cost the soul for the rest
      // of the process's life — but the trace entry is one-shot, or a database the installer never
      // wrote would file the same record on every turn forever.
      if (!this.soulFailureTraced) {
        this.soulFailureTraced = true;
        this.trace.append('soul_read_failed', { message: error instanceof Error ? error.message : String(error) });
      }
      return '';
    }
  }

  /**
   * The durable prompt log. The model loop and a workflow run write the same record, because both
   * are runs a restart has to be able to reconstruct.
   */
  private recordPrompt(input: { runId: string; sessionId: string; text: string }): void {
    const marked = this.redactor.mark(input.text);
    this.trace.append('run_prompt', {
      runId: input.runId,
      sessionId: input.sessionId,
      chars: input.text.length,
      text: marked.value,
      ...marked.metadata,
    });
  }

  async submit(text: string): Promise<RunSummary | undefined> {
    if (this.machine.state === 'RUNNING') {
      this.runtime!.steer(text);
      this.emitSteering();
      return undefined;
    }
    if (this.dailyBudgetExceeded()) this.announceDailyBudget('user_message');
    if (this.machine.state === 'SUSPENDED') return this.submitWhileSuspended(text);
    // The user's message is the assignment's provenance. It is written before the run so an
    // autonomous wake after a budget stop can inherit the work tier from the ledger, not from a
    // guess about what the wake's text means.
    this.beginUserAssignment(text);
    this.clock!.markInteraction(text, this.now());
    await this.wakeIfNeeded('message_received');
    if (this.machine.state !== 'IDLE') throw new Error(`submit_requires_idle: state is ${this.machine.state}`);
    return this.executeRun(text, 'message_received', 'user_message');
  }

  /**
   * A line typed while paused (#228). For a question the line is the answer: the same assignment
   * continues, no new assignment record is written, and the object is marked answered so the
   * resumed prompt can still name the question. For a budget request a typed line is a new
   * instruction: the paused task closes as budget_exceeded (traced) and the line starts fresh work.
   * There is no timeout for either kind — see `Suspension`'s comment.
   */
  private async submitWhileSuspended(text: string): Promise<RunSummary | undefined> {
    const suspension = this.machine.runtime.suspension;
    this.clock!.markInteraction(text, this.now());
    if (suspension?.kind === 'question') {
      // The owner's answer to an external-rule proposal is the decision itself (#228 item 5). It
      // is resolved before the resumed run so the rule cannot take effect just because the model
      // saw an encouraging word.
      if (suspension.question?.approvalId) this.hygiene.answer(suspension.question.approvalId, text);
      this.machine.updateRuntime({ suspension: { ...suspension, answeredAt: this.now() } });
      this.trace.append('suspension_answered', { id: suspension.id, assignmentId: suspension.assignmentId, chars: text.trim().length });
      return this.executeRun(text, 'message_received', 'question_answered', 'answer_received');
    }
    if (suspension) this.supersedeSuspension('new_input');
    this.beginUserAssignment(text);
    return this.executeRun(text, 'message_received', 'user_message');
  }

  private async wakeIfNeeded(trigger: 'message_received' | 'wake_intent_due' | 'emergence_due'): Promise<void> {
    if (this.machine.state === 'DORMANT') await this.machine.dispatch('message_received', { reason: 'message_while_dormant' });
    if (this.machine.state === 'DREAMING') await this.machine.dispatch('message_received', { reason: 'message_while_dreaming' });
    if (this.machine.state === 'WAKING') {
      this.injectTimeContext(trigger);
      await this.machine.dispatch('context_injected', { reason: `${trigger}_time_context` });
    }
  }

  private async executeRun(
    text: string,
    trigger: 'message_received' | 'emergence_due',
    reason: string,
    dispatchTrigger: Trigger = trigger,
    fallback?: { reason: string; workflow: ProcedureWorkflow; failedStep?: number },
  ): Promise<RunSummary> {
    const runId = `run-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const origin = trigger === 'emergence_due' ? 'emergence' : 'user';
    const tier = this.budgetTier(trigger);
    this.runTier = tier;
    // The owner's grant widens this one run's cage and is spent when it settles (#228).
    this.cage!.beginRun(runId, tier, tier === 'work' ? this.machine.runtime.openAssignment?.grant : undefined);
    // A backed-off autonomous wake still runs (F7's surfacing decision is untouched) but it does not
    // inherit the work tier or the assignment, so it cannot keep retrying the same continuation.
    this.hideAssignmentContext = trigger === 'emergence_due' && tier === 'autonomous' && this.machine.runtime.openAssignment !== undefined;
    if (this.hideAssignmentContext) {
      const assignment = this.machine.runtime.openAssignment!;
      this.trace.append('assignment_resume_deferred', {
        assignmentId: assignment.id,
        attempts: assignment.attempts ?? 0,
        nextResumeAt: assignment.nextResumeAt ?? null,
        now: this.now(),
      });
    }
    await this.machine.dispatch(dispatchTrigger, { runId, reason });

    // An active workflow runs as the deterministic half of this turn. It is a normal run on the same
    // bus and tool pipeline, so the cage and capture see it; a failure ends it at the failed step and
    // the task falls back to the model with the failure in front of it.
    const workflow = fallback ? undefined : this.workflows?.match(text);
    if (workflow) {
      let result;
      try {
        result = await this.workflows!.execute(workflow, { runId, userText: text, origin });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.trace.append('workflow_execution_failed', { runId, entryId: workflow.entryId, message });
        await this.machine.dispatch('run_error', { reason: `workflow_execution_failed: ${message}`, runId });
        return this.executeRun(text, trigger, 'workflow_execution_failed', trigger, {
          reason: `workflow_execution_failed: ${message}`,
          workflow,
        });
      }
      if (result.ok) {
        this.settleAssignment(result.summary, tier, trigger);
        await this.machine.dispatch(result.summary.stopReason, { reason: 'workflow_complete', runId });
        this.hideAssignmentContext = false;
        if (!this.clock!.nextPendingIntent()) this.clock!.scheduleIdleWake();
        return result.summary;
      }
      await this.machine.dispatch(result.summary.stopReason, { reason: result.reason ?? 'workflow_failed', runId });
      this.trace.append('workflow_fallback', {
        runId,
        entryId: workflow.entryId,
        failedStep: result.failedStep,
        reason: result.reason,
      });
      return this.executeRun(text, trigger, `workflow_failed: ${result.reason ?? 'step failed'}`, trigger, {
        reason: result.reason ?? 'step failed',
        workflow,
        ...(result.failedStep !== undefined ? { failedStep: result.failedStep } : {}),
      });
    }

    let summary: RunSummary;
    try {
      summary = await this.runtime!.run({
        runId,
        sessionId: this.config.sessionId,
        userText: text,
        origin,
        ...(fallback ? { seed: [this.workflowFallbackMessage(fallback)] } : {}),
      });
    } finally {
      this.hideAssignmentContext = false;
    }
    const outcome = this.settleAssignment(summary, tier, trigger);
    if (summary.stopReason === 'run_error' && summary.error?.startsWith('model_timeout:')) this.announceModelTimeout(summary);
    if (summary.stopReason === 'run_error' && summary.error?.startsWith('no_progress:')) this.announceNoProgress(summary);
    await this.machine.dispatch(outcome, { reason: summary.error ?? reason, runId });
    if (this.machine.state === 'SUSPENDED' && this.machine.runtime.suspension?.kind === 'budget') {
      this.offerResume(this.machine.runtime.suspension.id);
    }
    if (!this.clock!.nextPendingIntent()) this.clock!.scheduleIdleWake();
    return summary;
  }

  /**
   * What the model sees after a workflow stopped. The workflow ran in its own run, so the failed
   * step's tool results are not in this context; the note says which steps already succeeded instead
   * of pretending the model can read them.
   */
  private workflowFallbackMessage(input: { reason: string; workflow: ProcedureWorkflow; failedStep?: number }): AgentMessage {
    const completed = input.failedStep === undefined ? 0 : input.failedStep - 1;
    return {
      role: 'system',
      content: [
        '<workflow-fallback>',
        `The active workflow ${input.workflow.domain}/${input.workflow.key} v${input.workflow.version} stopped`
          + `${input.failedStep !== undefined ? ` at step ${input.failedStep}` : ''}: ${input.reason}`,
        completed > 0
          ? `Steps 1-${completed} already ran successfully; do not repeat them.`
          : 'No step completed before the stop.',
        'Continue the task with the model. The procedure entry and the workflow are unchanged by this fallback.',
        '</workflow-fallback>',
      ].join('\n'),
    };
  }

  /**
   * Which cage this run gets. A user message is an assignment by definition. An autonomous wake
   * inherits the work tier only when the ledger still holds an unfinished user-assigned task; the
   * check reads that task's `origin`, never the wake's words.
   */
  private budgetTier(trigger: 'message_received' | 'emergence_due'): CageTier {
    if (trigger === 'message_received') return 'work';
    const assignment = this.machine.runtime.openAssignment;
    if (assignment?.origin !== 'user_message') return 'autonomous';
    // A continuation that keeps failing waits longer (#228); while it waits, an autonomous wake is a
    // plain surfacing run, not a retry of the assignment.
    if (assignment.nextResumeAt !== undefined && assignment.nextResumeAt > this.now()) return 'autonomous';
    return 'work';
  }

  private beginUserAssignment(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const open = this.machine.runtime.openAssignment;
    if (open) {
      // A new message continues the open task by default (#246 A2): the budget stop's place and the
      // confirmed findings are the handoff, and a follow-up like "继续" must not erase them. The
      // model says "this is a different task" through `declare_task`, not the shell guessing.
      this.machine.updateRuntime({ openAssignment: { ...open, latestUserText: trimmed.slice(0, 500) } });
      this.trace.append('assignment_attached', { assignmentId: open.id, chars: trimmed.length });
      return;
    }
    this.machine.updateRuntime({
      openAssignment: {
        id: `assignment-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        origin: 'user_message',
        text: trimmed.slice(0, 500),
        latestUserText: trimmed.slice(0, 500),
        startedAt: this.now(),
      },
    });
  }

  /**
   * A whole-turn timeout stops the run instead of retrying (#240), so the transcript says why and
   * with which cap; otherwise a stopped turn leaves only the idle status behind.
   */
  private announceModelTimeout(summary: RunSummary): void {
    const seconds = Math.round(this.config.model.timeoutMs / 1_000);
    const reason = (summary.error ?? '').replace(/^model_timeout:\s*/u, '');
    const text = `模型超时（整轮上限 ${seconds} 秒），已停止本轮、不再重试${reason ? `：${reason}` : ''}`;
    void this.host.bus.emit('terminal_print', { text: `${text}\n` });
    void this.host.bus.emit('companion_notice', { text, tone: 'warn' });
  }

  /**
   * The no-progress stop (#241): name the turn it stopped on and the tool call it was repeating, so
   * the stop is not mistaken for the cage's budget or a provider failure.
   */
  private announceNoProgress(summary: RunSummary): void {
    const lastCall = summary.toolCalls.at(-1);
    const where = lastCall
      ? `${lastCall.toolName} ${truncate(JSON.stringify(lastCall.input ?? {}), 120)}`
      : `turn ${summary.turns}`;
    const text = `连续 ${this.config.maxIdleTurns} 回合无用户可见产出，已停止本轮（无进展判据 maxIdleTurns=${this.config.maxIdleTurns}）；停在 ${where}`;
    void this.host.bus.emit('terminal_print', { text: `${text}\n` });
    void this.host.bus.emit('companion_notice', { text, tone: 'warn' });
  }

  /**
   * A completed run closes the assignment; a budget stop keeps it open and writes the place and the
   * next move. A run error or abort keeps it open too: the work is unfinished, and the next wake
   * must not mistake it for a fresh autonomous idea.
   */
  private settleAssignment(summary: RunSummary, tier: CageTier, trigger: 'message_received' | 'emergence_due'): Trigger {
    const question = this.pendingQuestion;
    this.pendingQuestion = undefined;
    const assignment = this.machine.runtime.openAssignment;
    // A question can only be waited on by a work run; the tool refuses the autonomous tier, and this
    // is the second half of that guard rather than a second policy.
    if (!assignment || tier !== 'work') return summary.stopReason;
    if (summary.stopReason === 'run_complete' && question) {
      const suspension: Suspension = {
        id: `suspension-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        kind: 'question',
        assignmentId: assignment.id,
        createdAt: this.now(),
        runId: summary.runId,
        question,
      };
      this.machine.updateRuntime({
        suspension,
        openAssignment: { ...assignment, lastRunId: summary.runId, stoppedAt: this.now(), nextStep: 'continue the open task with the answer' },
      });
      this.trace.append('assignment_paused', {
        runId: summary.runId,
        assignmentId: assignment.id,
        suspensionId: suspension.id,
        kind: 'question',
        questionChars: question.text.length,
      });
      return 'question_paused';
    }
    if (summary.stopReason === 'run_complete') {
      this.machine.updateRuntime({ openAssignment: undefined, suspension: undefined });
      return 'run_complete';
    }
    // The run's own closing words are the handoff: bounded, collapsed to one line, and carried into
    // the next run's prompt so a continuation does not re-read the same sources. A run that ends
    // without text (an abort mid-tool) keeps the earlier findings rather than erasing them.
    const findings = this.captureFindings(summary, assignment);
    // Only an autonomous continuation counts an attempt, and a successful tool result is the
    // progress that resets it (#228). A user-driven run resets the count: the owner is present.
    const progressed = summary.toolResults.some((result) => !result.isError);
    const attempts = trigger === 'emergence_due' && !progressed ? (assignment.attempts ?? 0) + 1 : 0;
    const nextResumeAt = attempts > 0 ? this.now() + Math.min(RESUME_BACKOFF_BASE_MS * 2 ** (attempts - 1), RESUME_BACKOFF_CAP_MS) : undefined;
    if (summary.stopReason !== 'budget_exceeded') {
      // A no-progress stop is unfinished work like a budget stop, but it ends through the existing
      // run_error edge. It writes the same handoff fields so the next run knows where it stalled.
      const noProgress = summary.error?.startsWith('no_progress:') === true;
      const lastCall = summary.toolCalls.at(-1);
      const stoppedStep = noProgress
        ? lastCall
          ? `${lastCall.toolName} ${truncate(JSON.stringify(lastCall.input ?? {}), 240)}`
          : `after turn ${summary.turns}`
        : undefined;
      const nextStep = noProgress
        ? `continue the open task, but report user-visible progress before repeating the same tool call (the previous run stopped after ${summary.turns} turns with no output)`
        : undefined;
      this.machine.updateRuntime({
        suspension: undefined,
        openAssignment: {
          ...assignment,
          lastRunId: summary.runId,
          grant: undefined,
          attempts,
          nextResumeAt,
          ...(findings ? { findings } : {}),
          ...(stoppedStep ? { stoppedStep, nextStep } : {}),
        },
      });
      if (noProgress) this.trace.append('assignment_stopped', { runId: summary.runId, assignmentId: assignment.id, stoppedStep, nextStep, findingsChars: findings?.length ?? 0 });
      if (attempts > 0) this.trace.append('assignment_backoff', { assignmentId: assignment.id, attempts, nextResumeAt });
      return summary.stopReason;
    }
    const lastCall = summary.toolCalls.at(-1);
    const stoppedStep = lastCall
      ? `${lastCall.toolName} ${truncate(JSON.stringify(lastCall.input ?? {}), 240)}`
      : `after turn ${summary.turns}`;
    const nextStep = lastCall
      ? `resume from ${lastCall.toolName}: check its last result, then continue the user-assigned task`
      : 'continue the user-assigned task from its next step; the budget stopped this run before it finished';
    const estimate = estimateBudgetGrant({ tokens: summary.tokens, turns: summary.turns, limits: this.config.workBudget });
    const violation = this.cage!.violation;
    const suspension: Suspension = {
      id: `suspension-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      kind: 'budget',
      assignmentId: assignment.id,
      createdAt: this.now(),
      runId: summary.runId,
      budget: {
        ...(violation?.violation === 'turn_budget' || violation?.violation === 'token_budget' ? { violation: violation.violation } : {}),
        tokens: summary.tokens,
        turns: summary.turns,
        tokensPerTurn: estimate.tokensPerTurn,
        additionalTokens: estimate.tokens,
        additionalTurns: estimate.turns,
        basis: estimate.basis,
      },
    };
    this.machine.updateRuntime({
      suspension,
      openAssignment: {
        ...assignment,
        lastRunId: summary.runId,
        stoppedAt: this.now(),
        stoppedStep,
        nextStep,
        grant: undefined,
        attempts,
        nextResumeAt,
        ...(findings ? { findings } : {}),
      },
    });
    this.trace.append('assignment_stopped', { runId: summary.runId, assignmentId: assignment.id, stoppedStep, nextStep, findingsChars: findings?.length ?? 0 });
    this.trace.append('assignment_paused', {
      runId: summary.runId,
      assignmentId: assignment.id,
      suspensionId: suspension.id,
      kind: 'budget',
      additionalTokens: estimate.tokens,
      additionalTurns: estimate.turns,
      tokensPerTurn: Math.round(estimate.tokensPerTurn),
      basis: estimate.basis,
    });
    return 'budget_paused';
  }

  private captureFindings(summary: RunSummary, assignment: { id: string }): string | undefined {
    // The closing message, not the whole run: the handoff is what the run concluded, and the earlier
    // turns are already in the transcript it can recall.
    const text = (summary.lastAssistantText ?? summary.assistantText).replace(/\s+/gu, ' ').trim();
    if (text === '') return undefined;
    if (text.length <= MAX_ASSIGNMENT_FINDINGS) return text;
    this.trace.append('assignment_findings_truncated', {
      assignmentId: assignment.id,
      runId: summary.runId,
      chars: text.length,
      kept: MAX_ASSIGNMENT_FINDINGS,
    });
    return `${text.slice(0, MAX_ASSIGNMENT_FINDINGS - 1)}…`;
  }

  /** One deterministic tick: due intent, then dream window, then the emergence decision point. */
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
      await this.applyDueWakeIntent(at);
      return;
    }
    if (this.machine.state === 'DREAMING') return;
    await this.applyDueWakeIntent(at);
    if (this.clock!.dreamWindowOpen(at) && !this.clock!.dreamedToday(at)) {
      await this.runDream(at);
      return;
    }
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
      const candidate = decision?.candidates.find((item) => !this.emergenceConsumed(item));
      if (candidate) {
        // Consume before acting: a crash during the run must not free the same candidate to run again.
        this.consumeEmergence(candidate, at);
        if (this.shouldHoldForAbsence()) {
          // Nobody is attached, so speaking now would be talking to an empty room. Hold it in the
          // durable away queue and let the next attach's "你不在时" broadcast carry it.
          this.machine.updateRuntime({
            awayQueue: enqueueAway(this.machine.runtime, { id: candidate.id, text: candidate.text, reason: candidate.reason, at }),
          });
          this.trace.append('emergence_accumulated', { projectId: this.config.projectId, id: candidate.id, reason: candidate.reason, at });
          return;
        }
        void this.host.bus.emit('companion_emergence', { id: candidate.id, reason: candidate.reason, text: candidate.text });
        let ok = false;
        try {
          const summary = await this.executeRun(candidate.text, 'emergence_due', `emergence:${candidate.id}`);
          ok = summary.stopReason === 'run_complete';
        } finally {
          this.trace.append('emergence_run', { projectId: this.config.projectId, id: candidate.id, ok });
        }
      } else if (due && !allowed) {
        this.trace.append('emergence_skipped', {
          projectId: this.config.projectId,
          at,
          reason: this.dailyBudgetExceeded(at) ? 'daily_token_budget' : 'cooldown_or_daily_cap',
        });
      }
    }
  }

  /**
   * The compiled books an emergence decision reads: promised commitments (F16) and the agent's
   * plans (F22). Both compile incrementally and are safe at a turn boundary. F22 has no F6 source,
   * so a plan with a target instant is consumed the way its own contract says: `schedule` turns it
   * into an F2 wake intention, which is a first-class candidate source.
   */
  private compileProactiveBooks(at: number): void {
    const projectId = this.config.projectId;
    try {
      const latest = this.kernel.eventStore.queryEvents(1, 1, {
        projectId: [projectId],
        order: 'desc',
      }).records[0]?.eventId ?? '';
      // Idle ticks are the common case; recompiling two books for no new turn is the kind of cost
      // a long-lived resident pays forever.
      if (latest === (this.compiledThroughEventId ?? '')) return;
      this.kernel.commitments.compile({ projectId, now: at });
      this.kernel.intentions.compile({ projectId, now: at });
      for (const intention of this.kernel.intentions.list({ projectId, statuses: ['active'], now: at })) {
        if (intention.dueAt === undefined || intention.wakeIntentionId !== undefined) continue;
        this.kernel.intentions.schedule({ projectId, intentionId: intention.intentionId, now: at });
        this.trace.append('intention_scheduled_for_wake', { intentionId: intention.intentionId, dueAt: intention.dueAt, at });
      }
      this.compiledThroughEventId = latest;
    } catch (error) {
      this.trace.append('proactive_compile_failed', { at, message: error instanceof Error ? error.message : String(error) });
    }
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

  /** Cooldown and the Tokyo day's count; both survive a restart because they live in the checkpoint. */
  private emergenceAllowed(at: number): boolean {
    // #233 and #229 share one day boundary and one hard stop: when the day's tokens are gone,
    // autonomy does not start another run, exactly as the emergence count cap does.
    if (this.dailyBudgetExceeded(at)) return false;
    const state = this.machine.runtime.emergence;
    if (!state) return true;
    if (state.lastAt !== undefined && at - state.lastAt < EMERGENCE_COOLDOWN_MS) return false;
    return state.day !== tokyoDate(at) || state.count < EMERGENCE_DAILY_LIMIT;
  }

  private consumeEmergence(candidate: { id: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }, at: number): void {
    const key = this.emergenceKey(candidate);
    const day = tokyoDate(at);
    const prior = this.machine.runtime.emergence;
    const count = prior?.day === day ? prior.count + 1 : 1;
    const consumed = [...(prior?.consumed ?? []).filter((entry) => entry !== key), key].slice(-MAX_EMERGENCE_CONSUMED);
    this.machine.updateRuntime({ emergence: { day, count, lastAt: at, consumed } });
    this.trace.append('emergence_consumed', { projectId: this.config.projectId, id: candidate.id, key, day, count });
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
      this.reportMemoryPressure(at);
      const away = this.shouldHoldForAbsence();
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
  private injectTimeContext(reason: string, at = this.now()): void {
    const block = this.clock!.timeContextBlock(at);
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

  async runDream(at = this.now()): Promise<void> {
    await this.machine.dispatch('dream_window_open', { reason: 'dream_window' });
    const localDate = this.clock!.localDate(at);
    try {
      const result = await this.dream!.integrate(localDate, `companion-day:${localDate}`, at);
      this.clock!.markDreamed(at);
      this.clock!.setWakeIntent(at + 8 * 60 * 60_000, 'morning_after_dream');
      this.trace.append('dream_complete', { localDate, eventCount: result.eventCount, sourceRefs: result.sourceRefs.length });
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
      this.trace.append('dream_failed', { localDate, message });
      await this.machine.dispatch('run_error', { reason: `dream_failed:${message}` });
    }
  }

  // ---- The attach surface (`AttachShell`): everything the TUI process is allowed to ask for. ----

  /**
   * The work indicator and the context gauge are fed from the same events the transcript is, so the
   * TUI never has to poll state: a turn starts, a tool starts, tokens are charged, a run settles.
   */
  private attachWorkListeners(): void {
    this.host.bus.on('agent_start', () => {
      this.emitStatus();
    });
    this.host.bus.on('turn_start', (event: { turnIndex?: number }) => {
      this.runTurns = event.turnIndex ?? this.runTurns;
      this.workLabel = '思考中';
      this.emitWork();
    });
    this.host.bus.on('turn_usage', (event: { tokens?: number; totalTokens?: number; usage?: TurnUsage }) => {
      this.runTokens = event.totalTokens ?? this.runTokens;
      // Charged per turn, not at `agent_end`: a kill mid-run must not refund the day's spend, and the
      // checkpoint is what the next process reads (#233).
      this.chargeCost(event.tokens ?? 0);
      const cache = promptCacheAccount(event.usage);
      if (cache) {
        this.promptCache = cache;
        this.emitStatus();
      }
      this.emitWork();
    });
    this.host.bus.on('tool_execution_start', (event: { toolName?: string }) => {
      this.workLabel = event.toolName ?? '工具';
      this.emitWork();
    });
    this.host.bus.on('tool_execution_end', () => {
      this.workLabel = '思考中';
      this.emitWork();
    });
    this.host.bus.on('turn_end', () => this.emitSteering());
    this.host.bus.on('agent_settled', () => {
      this.workLabel = '思考中';
      this.emitWork();
      this.emitSteering();
      this.emitStatus();
      this.flushDailyBudgetNotice();
    });
  }

  private chargeCost(tokens: number): void {
    if (tokens <= 0) return;
    try {
      const today = tokyoDate(this.now());
      const previous = this.machine.runtime.costDayDate === today ? this.machine.runtime.costDayTokens ?? 0 : 0;
      const spent = previous + tokens;
      this.machine.updateRuntime({ costDayDate: today, costDayTokens: spent });
      if (previous < this.config.dailyBudget.maxTokensPerDay && spent >= this.config.dailyBudget.maxTokensPerDay) {
        this.trace.append('daily_budget_crossed', { day: today, spent, limit: this.config.dailyBudget.maxTokensPerDay, tokens });
      }
    } catch (error) {
      this.trace.append('cost_charge_failed', { tokens, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The day's spend under the same Tokyo boundary #229's emergence count uses. */
  private dailySpent(at = this.now()): number {
    return this.machine.runtime.costDayDate === tokyoDate(at) ? this.machine.runtime.costDayTokens ?? 0 : 0;
  }

  private dailyBudgetExceeded(at = this.now()): boolean {
    return this.dailySpent(at) >= this.config.dailyBudget.maxTokensPerDay;
  }

  private dailyBudgetLine(at = this.now()): string {
    return `已到今日预算上限（${this.dailySpent(at)} / ${this.config.dailyBudget.maxTokensPerDay} token，东京日 ${tokyoDate(at)}）：自主运行今天不再开始；你的指令照常执行，单次运行仍受笼子上限约束。`;
  }

  /**
   * A user line is presence: the daily stop is stated once per day rather than left to the status
   * bar. The line still runs — the ticket stops autonomy, not the owner.
   */
  private announceDailyBudget(trigger: string): void {
    const day = tokyoDate(this.now());
    if (this.dailyNotifiedDay === day) return;
    this.dailyNotifiedDay = day;
    this.trace.append('daily_budget_exceeded', {
      trigger,
      day,
      spent: this.dailySpent(),
      limit: this.config.dailyBudget.maxTokensPerDay,
    });
    void this.host.bus.emit('terminal_print', { text: `${this.dailyBudgetLine()}\n` });
  }

  private flushDailyBudgetNotice(): void {
    if (!this.dailyBudgetExceeded()) return;
    this.announceDailyBudget('run_settled');
  }

  private emitWork(): void {
    void this.host.bus.emit('companion_work', this.currentWork());
  }

  private emitStatus(): void {
    void this.host.bus.emit('companion_status', { status: this.currentStatus() });
  }

  private emitSteering(): void {
    void this.host.bus.emit('companion_steering', { queued: this.currentQueued() });
  }

  private shouldHoldForAbsence(): boolean {
    return this.config.attach.enabled && (this.attach?.clientCount ?? 0) === 0;
  }

  currentStatus(): StatusState {
    const next = this.clock?.nextPendingIntent();
    const today = tokyoDate(this.now());
    return {
      name: this.config.agentId,
      lifecycle: this.machine.state,
      kernelConnected: !this.machine.isHalted,
      nextWakeAt: next?.at,
      nextWakeReason: next?.reason,
      model: this.modelLabel,
      workspace: this.config.workspaceRoot,
      showWorkspace: true,
      contextTokens: this.contextTokenEstimate,
      contextSweetSpot: this.targetTokens(),
      contextLanes: this.lastLaneAssembly ? laneAssemblyView(this.lastLaneAssembly) : null,
      promptCache: this.promptCache ?? null,
      costTokens: this.machine.runtime.costDayDate === today ? this.machine.runtime.costDayTokens ?? 0 : 0,
      timeZone: this.config.timeZone,
      capturePaused: this.capturePaused,
      ...(this.machine.state === 'SUSPENDED' && this.machine.runtime.suspension ? { suspended: this.suspendedLine(this.machine.runtime.suspension) } : {}),
    };
  }

  /** The one human line the status bar, the snapshot and `/health` all carry for a pause. */
  private suspendedLine(suspension: Suspension): { kind: Suspension['kind']; text: string } {
    if (suspension.kind === 'question') {
      return { kind: 'question', text: `已暂停：等你回答「${suspension.question?.text ?? ''}」` };
    }
    return {
      kind: 'budget',
      text: `已暂停：预算到顶，等批准追加 ${suspension.budget?.additionalTokens ?? 0} token / ${suspension.budget?.additionalTurns ?? 0} 回合`,
    };
  }

  currentWork(): WorkState {
    const budget = this.runTier === 'work' ? this.config.workBudget : this.config.budgets;
    return {
      active: this.machine.state === 'RUNNING',
      label: this.workLabel,
      startedAt: this.runStartedAt,
      turns: this.runTurns,
      maxTurns: budget.maxTurnsPerRun,
      tokens: this.runTokens,
      maxTokens: budget.maxTokensPerRun,
    };
  }

  currentQueued(): string[] {
    return [...(this.runtime?.steeringMessages ?? [])];
  }

  /** The TUI's Esc on a queued line: withdraw the newest steer the model has not seen. */
  withdrawSteering(): string | undefined {
    const withdrawn = this.runtime?.withdrawSteering();
    this.emitSteering();
    return withdrawn;
  }

  /**
   * The prompt of the run a kill interrupted, rebuilt from the session log (#210). `undefined` when
   * the last start was not a recovery of a RUNNING run with a prompt on record. What to *do* with it
   * — a new turn, the away report, or nothing — is a product decision this method does not make.
   */
  interruptedRun(): { runId: string; text: string; chars: number } | undefined {
    return this.interrupted;
  }

  /** `/sleep` is the command that puts it into DORMANT; closing the window is only a detach. */
  async sleep(): Promise<void> {
    if (this.machine.state === 'DORMANT') return;
    if (this.machine.state !== 'IDLE') throw new Error(`sleep_requires_idle: state is ${this.machine.state}`);
    await this.machine.dispatch('shutdown', { reason: 'sleep_command' });
    this.trace.append('sleep_command', { state: this.machine.state });
  }

  /**
   * The report shown before the conversation resumes. Building it consumes the away queue: it is
   * reported once, because "what happened while you were away" is not a recurring banner.
   */
  awayReport(): PresenceReport {
    // The one production read of the session log. `recover()` is the tolerant read plus the one-time
    // record of any damage, so a torn or corrupted log shows up in the report's own evidence instead
    // of silently reading as "nothing happened while you were away".
    const report = buildAwayReport({
      projectId: this.config.projectId,
      runtime: this.machine.runtime,
      trace: this.trace.recover().records,
      kernel: this.kernel,
      now: this.now(),
      ...(this.lastUpgrade ? { upgrade: this.lastUpgrade } : {}),
    });
    // Reported once: "what happened while you were away" is not a recurring banner.
    this.lastUpgrade = undefined;
    const patch: Record<string, unknown> = { lastAttachAt: this.now() };
    if ((this.machine.runtime.awayQueue?.length ?? 0) > 0) patch.awayQueue = [];
    try {
      this.machine.updateRuntime(patch);
    } catch (error) {
      this.trace.append('attach_state_write_failed', { message: error instanceof Error ? error.message : String(error) });
    }
    return report;
  }

  /** Date the absence when the last client leaves, so the next report has a window to read. */
  attachChanged(count: number): void {
    try {
      this.machine.updateRuntime(count > 0 ? { lastAttachAt: this.now() } : { lastDetachAt: this.now() });
    } catch (error) {
      this.trace.append('attach_state_write_failed', { count, message: error instanceof Error ? error.message : String(error) });
    }
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

  // ---- Memory sovereignty entry points (#232): three commands over F9's face. ----

  forgetPreview(start: number, end: number): CommandReply {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return { text: '删除窗口无效：起点必须早于终点（半开窗口 [起, 止)）。', receipt: true };
    }
    const projectId = this.config.projectId;
    // The same half-open occurredAt filter deleteRange applies; this is a read, not a second rule.
    const count = this.kernel.eventStore.queryEvents(1, 1, { projectId: [projectId], startTime: start, endTime: end }).total;
    this.pendingForget = { start, end };
    return {
      text: [
        `将删除 ${new Date(start).toISOString()} 至 ${new Date(end).toISOString()}（含起不含止）的 ${count} 条账本记录。`,
        '引用这些记录的画像、程序、承诺、情节与图谱条目会随证据一并删除，然后重建。',
        '确认执行：/forget confirm。回执与审计只记范围、条数和审计 id，不记被删内容。',
      ].join('\n'),
      receipt: true,
    };
  }

  forgetConfirm(): CommandReply {
    const pending = this.pendingForget;
    if (!pending) return { text: '还没有预览：先 /forget <起> <止> 看范围和条数。', receipt: true };
    const projectId = this.config.projectId;
    const result = this.kernel.sovereignty.deleteRange({
      projectId,
      start: pending.start,
      end: pending.end,
      reason: 'owner_command',
    });
    this.pendingForget = undefined;
    this.trace.append('forget_range_deleted', {
      projectId,
      start: pending.start,
      end: pending.end,
      auditId: result.auditId,
      deleted: result.deleted,
    });
    const deleted = Object.entries(result.deleted)
      .filter(([, value]) => value > 0)
      .map(([field, value]) => `${field} ${value}`)
      .join(' · ');
    return {
      text: `已删除 ${new Date(pending.start).toISOString()} 至 ${new Date(pending.end).toISOString()}：${deleted || '没有记录'}。审计 ${result.auditId}。`,
      receipt: true,
      data: { sovereignty_delete: result },
    };
  }

  exportMemory(path: string | undefined): CommandReply {
    const outputPath = path
      ?? join(this.config.dataDir, 'exports', `memory-${new Date(this.now()).toISOString().replace(/[:.]/gu, '-')}.md`);
    const result = this.kernel.sovereignty.exportArchive({ projectId: this.config.projectId, outputPath });
    this.trace.append('memory_exported', { path: result.path, bytes: result.bytes, auditId: result.auditId });
    const { events, profile, procedures, commitments, graph } = result.counts;
    return {
      text: `已导出 ${events} 条对话、${profile} 条画像、${procedures} 条程序、${commitments} 条承诺、${graph} 个图谱节点（${formatBytes(result.bytes)}）到 ${result.path}。审计 ${result.auditId}。`,
      receipt: true,
      data: { sovereignty_export: result },
    };
  }

  async correctProfile(key: string, value: string): Promise<CommandReply> {
    const projectId = this.config.projectId;
    const entries = this.kernel.profile.entries({ projectId });
    const exact = entries.filter((entry) => entry.key === key);
    const matches = exact.length > 0 ? exact : entries.filter((entry) => entry.key.endsWith(`.${key}`));
    if (matches.length === 0) {
      const known = entries.slice(0, 12).map((entry) => `${entry.ledger}:${entry.key}`).join('、');
      return this.proposeProcedureCorrection(key, value, known);
    }
    if (matches.length > 1) {
      return {
        text: `${key} 命中多条（${matches.map((entry) => `${entry.ledger}:${entry.key}`).join('、')}），请用完整键再试。`,
        receipt: true,
      };
    }
    const entry = matches[0]!;
    // The correction names the owner's turn. The command line is that turn, recorded through the
    // same backend every typed message uses, so pause/exclusion rules apply unchanged.
    const turn = await this.backend.rememberTurnWithResult({
      agentId: this.config.agentId,
      projectId,
      sessionId: this.config.sessionId,
      userText: `/correct ${entry.key} ${value}`,
    });
    const correctionEventId = turn.rawEventIds[0];
    if (!correctionEventId) return { text: '纠正未执行：纠正面需要一个用户回合，这次没有写进去。', receipt: true };
    const corrected = this.kernel.profile.correct({
      projectId,
      ledger: entry.ledger,
      key: entry.key,
      value,
      correctionEventId,
    });
    this.trace.append('profile_corrected', {
      projectId,
      ledger: entry.ledger,
      key: entry.key,
      version: corrected.version,
      eventId: correctionEventId,
    });
    return {
      text: `已纠正 ${entry.ledger} · ${entry.key}：${entry.value} → ${corrected.value}（v${corrected.version}）。下一次召回起全局按新值。`,
      receipt: true,
      data: { profile_correction: { ledger: entry.ledger, key: entry.key, value: corrected.value, version: corrected.version } },
    };
  }

  /**
   * `/correct` on a practice (#264). The compiler already reads `metadata.procedureCorrection`, but
   * nothing in the shell wrote it. A proposal is not a correction: the mark is written only by
   * `confirmProcedureCorrection`, and until then the book is untouched.
   */
  private proposeProcedureCorrection(key: string, value: string, knownProfiles: string): CommandReply {
    const projectId = this.config.projectId;
    this.kernel.procedures.compile({ projectId, now: this.now() });
    const current = this.kernel.procedures.entries({ projectId }).filter((entry) => entry.status === 'current');
    const named = current.filter((entry) =>
      entry.key === key || `${entry.domain}:${entry.key}` === key || entry.domain === key);
    // An imported guide and an own practice can share a key; the owner's correction replaces the
    // practice they actually do, and the imported book stays recallable as what was read.
    const own = named.filter((entry) => entry.origin !== 'imported');
    const matches = own.length > 0 ? own : named;
    if (matches.length === 0) {
      return {
        text: `没有叫 ${key} 的当前画像或做法条目。${knownProfiles ? `现有画像：${knownProfiles}` : '画像册目前是空的。'}`,
        receipt: true,
      };
    }
    if (matches.length > 1) {
      return {
        text: `${key} 命中多条做法（${matches.map((entry) => `${entry.domain}:${entry.key}`).join('、')}），请用完整键再试。`,
        receipt: true,
      };
    }
    const entry = matches[0]!;
    this.pendingProcedureCorrection = {
      domain: entry.domain,
      key: entry.key,
      value,
      title: entry.title,
      steps: [...entry.steps],
    };
    this.trace.append('procedure_correction_proposed', {
      projectId,
      domain: entry.domain,
      key: entry.key,
      entryId: entry.entryId,
    });
    return {
      text: `提议：把做法「${entry.title}」（${entry.domain} · ${entry.key}）改为「${value}」。这是提议，尚未生效；确认请发 /correct confirm。`,
      receipt: true,
      data: { procedure_correction_proposal: { domain: entry.domain, key: entry.key, value } },
    };
  }

  /** `/correct confirm`: write the practice correction and recompile, so the next recall reads it. */
  async confirmProcedureCorrection(): Promise<CommandReply> {
    const pending = this.pendingProcedureCorrection;
    if (!pending) return { text: '还没有做法提议：先 /correct <做法键> <新做法>。', receipt: true };
    const projectId = this.config.projectId;
    // The mark is the compiler's evidence: a `user` turn carrying the domain and key. The command
    // line is that turn, recorded through the same backend every typed message uses.
    const turn = await this.backend.rememberTurnWithResult({
      agentId: this.config.agentId,
      projectId,
      sessionId: this.config.sessionId,
      userText: pending.value,
      metadata: { procedureCorrection: { domain: pending.domain, key: pending.key } },
    });
    const correctionEventId = turn.rawEventIds[0];
    if (!correctionEventId) return { text: '纠正未执行：做法纠正需要一个用户回合，这次没有写进去。', receipt: true };
    this.pendingProcedureCorrection = undefined;
    this.kernel.procedures.compile({ projectId, now: this.now() });
    const entry = this.kernel.procedures.entries({ projectId }).find((candidate) =>
      candidate.domain === pending.domain && candidate.key === pending.key && candidate.origin !== 'imported');
    this.trace.append('procedure_corrected', {
      projectId,
      domain: pending.domain,
      key: pending.key,
      eventId: correctionEventId,
      entryId: entry?.entryId,
      version: entry?.version,
      grade: entry?.grade,
    });
    if (!entry) {
      return {
        text: `已写入做法纠正，但重编译后没有找到 ${pending.domain} · ${pending.key} 的现行条目；审计 ${correctionEventId}。`,
        receipt: true,
      };
    }
    return {
      text: `已纠正做法 ${pending.domain} · ${pending.key}：「${pending.steps.join('；')}」→「${pending.value}」（${entry.grade}，v${entry.version}）。下一次同类任务按新做法。`,
      receipt: true,
      data: {
        procedure_correction: {
          domain: pending.domain,
          key: pending.key,
          value: pending.value,
          entryId: entry.entryId,
          version: entry.version,
          grade: entry.grade,
        },
      },
    };
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

  // ---- Command proposals (spec §7, #165 round 22): the agent offers, the user decides. ----

  /**
   * The user's "Enter". This is the only caller of `executeProposal`, and the confirmation event it
   * builds is the user's key — there is no other way for a proposal to reach the dispatcher, which
   * reuses `runCommand` so a confirmed proposal and a typed `/pause` are the same execution. The
   * agent's side is the `propose_command` tool (`plugins/proposal.ts`), which only records.
   */
  async confirmProposal(id: string): Promise<{ ok: boolean; proposal?: CommandProposal; reason?: string; reply?: CommandReply }> {
    const proposal = this.proposals.get(id);
    const confirmation: ProposalConfirmation | undefined = proposal
      ? { kind: 'user-confirm', proposalId: proposal.id, at: this.now() }
      : undefined;
    const outcome = await executeProposal(proposal, confirmation, {
      dispatch: (command, args) => this.runCommand(command, args),
      trace: this.trace,
      now: this.now,
    });
    if (outcome.ok && proposal) this.proposals.settled(proposal);
    return {
      ok: outcome.ok,
      ...(proposal ? { proposal } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.reply ? { reply: outcome.reply } : {}),
    };
  }

  /** The user's "Esc": retire a pending proposal; it can never be confirmed after this. */
  discardProposal(id: string): CommandProposal | undefined {
    const proposal = this.proposals.discard(id);
    // Esc on the budget offer is the owner's refusal (#228): the task closes as budget_exceeded and
    // the receipt says so, instead of leaving a pause nobody can see the end of.
    if (proposal && id === this.suspensionProposalId) {
      this.suspensionProposalId = undefined;
      this.rejectSuspended();
    }
    return proposal;
  }

  /** The pending offers, for tests and any face that wants the list rather than the transcript. */
  currentProposals(): CommandProposal[] {
    return [...this.proposals.pending()];
  }

  // ---- The suspension faces (#228): one pause object, three exits (approve, refuse, supersede). ----

  /**
   * Offer the owner the one way to continue a budget pause. It reuses the command-proposal shape —
   * Enter confirms `/continue`, Esc refuses it — because that is the mechanism this shell already
   * has for "the agent asks, the owner decides". The offer is re-made after a restart: the pause is
   * durable, the in-memory proposal registry is not.
   */
  private offerResume(suspensionId: string): void {
    const suspension = this.machine.runtime.suspension;
    if (!suspension || suspension.id !== suspensionId || suspension.kind !== 'budget') return;
    const { proposal } = this.proposals.propose({
      command: 'continue',
      args: suspension.id,
      reason: `预算到顶：再给 ${suspension.budget?.additionalTokens ?? 0} token / ${suspension.budget?.additionalTurns ?? 0} 回合就能继续（${suspension.budget?.basis ?? ''}）`,
    });
    this.suspensionProposalId = proposal.id;
  }

  /**
   * `/continue`: the owner approves the estimate. The grant is written onto the assignment (so it
   * survives a crash between approval and the run) and the pause is cleared in the same checkpoint
   * write; the run itself is dispatched from the next tick of the event loop, like the plugin
   * restart's resume, so the command's receipt reaches the socket first.
   */
  continueSuspended(): CommandReply {
    const suspension = this.machine.runtime.suspension;
    if (this.machine.state !== 'SUSPENDED' || !suspension) return { text: '现在没有挂起的 run，不需要续跑。', receipt: true };
    if (suspension.kind !== 'budget') return { text: '这次挂起在等一个回答，不是等预算：直接回复即可。', receipt: true };
    if (this.dailyBudgetExceeded()) this.announceDailyBudget('budget_approved');
    const assignment = this.machine.runtime.openAssignment;
    if (!assignment || assignment.id !== suspension.assignmentId) {
      this.trace.append('suspension_resume_refused', { id: suspension.id, reason: 'assignment_mismatch' });
      return { text: '挂起对象与当前任务对不上，没有续跑（痕迹已记）。', receipt: true };
    }
    const grant = { tokens: suspension.budget?.additionalTokens ?? 0, turns: suspension.budget?.additionalTurns ?? 0 };
    this.suspensionProposalId = undefined;
    this.machine.updateRuntime({ openAssignment: { ...assignment, grant, attempts: 0, nextResumeAt: undefined }, suspension: undefined });
    this.trace.append('suspension_approved', { id: suspension.id, assignmentId: assignment.id, grant, basis: suspension.budget?.basis });
    setTimeout(() => {
      void this.resumeSuspendedRun(assignment.id).catch((error) =>
        this.trace.append('suspension_resume_failed', { assignmentId: assignment.id, message: error instanceof Error ? error.message : String(error) }),
      );
    }, 0);
    return { text: `已批准：追加 ${grant.tokens} token / ${grant.turns} 回合，原地续跑。`, receipt: true };
  }

  private async resumeSuspendedRun(assignmentId: string): Promise<void> {
    const assignment = this.machine.runtime.openAssignment;
    if (!assignment || assignment.id !== assignmentId) return;
    if (this.machine.state !== 'SUSPENDED') {
      this.trace.append('suspension_resume_skipped', { assignmentId, reason: `state:${this.machine.state}` });
      return;
    }
    await this.executeRun(assignment.text, 'message_received', 'budget_approved', 'budget_approved');
  }

  /**
   * The owner refused. The task closes exactly as an unattended budget stop used to (#228): the
   * assignment is gone, the trace keeps the refusal and the numbers it refused, and the lifecycle
   * returns to standby through the `budget_rejected` edge.
   */
  private rejectSuspended(): void {
    const suspension = this.machine.runtime.suspension;
    if (this.machine.state !== 'SUSPENDED' || !suspension) return;
    this.trace.append('suspension_rejected', {
      id: suspension.id,
      assignmentId: suspension.assignmentId,
      kind: suspension.kind,
      additionalTokens: suspension.budget?.additionalTokens ?? null,
      closedAs: 'budget_exceeded',
    });
    this.machine.updateRuntime({ suspension: undefined, openAssignment: undefined });
    void this.machine.dispatch('budget_rejected', { reason: 'owner_rejected_budget' }).catch((error) =>
      this.trace.append('suspension_reject_failed', { id: suspension.id, message: error instanceof Error ? error.message : String(error) }),
    );
  }

  /**
   * A new instruction while a budget pause waits: the pause is closed and the trace says how. The
   * assignment stays open (#246 A2): the new line attaches to it in `beginUserAssignment`, so the
   * stop's place and findings are still in the next prompt.
   */
  private supersedeSuspension(reason: string): void {
    const suspension = this.machine.runtime.suspension;
    if (!suspension) return;
    this.suspensionProposalId = undefined;
    this.trace.append('suspension_superseded', {
      id: suspension.id,
      assignmentId: suspension.assignmentId,
      kind: suspension.kind,
      reason,
      closedAs: 'budget_exceeded',
    });
    this.machine.updateRuntime({ suspension: undefined });
  }

  /**
   * `ask_user`'s one entry (#228). Only a work run may wait for the owner: an autonomous run has no
   * one to answer it and must not hold a pause open, so the tool refuses there and the model is told
   * to carry on. The question is process-local until the run settles; the checkpointed object is
   * written by `settleAssignment`.
   */
  askUser(input: { question: string; context?: string; approvalId?: string }): { ok: boolean; text: string } {
    const question = input.question.trim();
    if (question === '') return { ok: false, text: 'invalid_arguments: "question" must be a non-empty string' };
    if (this.runTier !== 'work' || this.machine.state !== 'RUNNING') {
      this.trace.append('question_refused_autonomous', { chars: question.length });
      return { ok: false, text: 'ask_user_unavailable: 这次是自主 run，没有人在等你的问题；不要等，直接按现有信息做完或收尾。' };
    }
    const contextRef = input.context?.trim();
    this.pendingQuestion = {
      text: question,
      ...(contextRef ? { contextRef } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    };
    this.trace.append('question_registered', { chars: question.length, contextChars: contextRef?.length ?? 0 });
    return { ok: true, text: '已登记问题：这次 run 到此挂起，用户回答后原任务原地续跑。不要再调用工具，也不要假装已经得到回答。' };
  }

  /**
   * `declare_task`'s one entry (#246 A2). Whether a line starts a different task is a semantic
   * judgement, so the shell does not read keywords: the front model says so through this explicit
   * declaration, and the shell settles the old assignment the way a completed run does. The trace
   * record is the auditable shape C5/D3 will consume.
   */
  declareTask(input: { action?: string; runId?: string }): { ok: boolean; text: string } {
    const action = input.action;
    if (action !== 'start' && action !== 'end') {
      return { ok: false, text: 'invalid_arguments: "action" must be "start" or "end"' };
    }
    if (this.runTier !== 'work' || this.machine.state !== 'RUNNING') {
      this.trace.append('assignment_declaration_refused', { action, runId: input.runId, reason: `tier:${this.runTier}`, state: this.machine.state });
      return { ok: false, text: 'declare_task_unavailable: 只有用户在场的 work run 才能声明任务边界；自主 run 不要调用。' };
    }
    const previous = this.machine.runtime.openAssignment;
    if (!previous) {
      this.trace.append('assignment_declaration_refused', { action, runId: input.runId, reason: 'no_open_assignment' });
      return { ok: false, text: 'declare_task_refused: 现在没有 open assignment，无需声明边界。' };
    }
    if (action === 'end') {
      this.machine.updateRuntime({ openAssignment: undefined });
      this.trace.append('assignment_declared', {
        action,
        runId: input.runId,
        previousAssignmentId: previous.id,
        assignmentId: null,
        textChars: previous.text.length,
      });
      return { ok: true, text: '已声明任务结束：open assignment 已收束，本 run 剩余部分不再把它当待办。' };
    }
    const brief = (previous.latestUserText ?? previous.text).trim().slice(0, 500);
    const assignment = {
      id: `assignment-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      origin: 'user_message' as const,
      text: brief,
      latestUserText: brief,
      startedAt: this.now(),
    };
    this.machine.updateRuntime({ openAssignment: assignment });
    this.trace.append('assignment_declared', {
      action,
      runId: input.runId,
      previousAssignmentId: previous.id,
      assignmentId: assignment.id,
      textChars: brief.length,
    });
    return { ok: true, text: '已声明新任务：旧 assignment 已收束，新任务以最新用户消息为简报；后续只围绕它继续。' };
  }

  /**
   * What the palette's command table may ask of the shell. It exists so the handlers can live in
   * `commands.ts` (one table for every face) without moving the shell's private state out of the
   * class: each arrow reads `this` at call time.
   */
  private readonly commandHost: CommandHost = {
    config: () => this.config,
    lifecycle: () => ({ state: this.machine.state, seq: this.machine.seq, costDayTokens: this.machine.runtime.costDayTokens ?? 0 }),
    contextTokens: () => this.contextTokenEstimate,
    contextLanes: () => (this.lastLaneAssembly ? laneAssemblyView(this.lastLaneAssembly) : undefined),
    promptCache: () => this.promptCache,
    lastDream: () => this.lastDreamProduct(),
    commitments: () => this.commitments(),
    candidateQueue: () => this.candidateQueue(),
    whyReport: () => this.whyReport(),
    capturePaused: () => this.capturePaused,
    setCapturePaused: (paused: boolean) => {
      this.machine.updateRuntime({ capturePaused: paused });
      this.trace.append(paused ? 'capture_paused_command' : 'capture_resumed_command', { at: this.now() });
      this.emitStatus();
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
            lines: this.modelRouter.routes().map((route) => routeLine(route, route.name === this.modelRouter!.active)),
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

  // ---- The native plugin registry (#223, converted in #224) -----------------------------------

  /**
   * `/plugins`: the registered list plus this process's load results. The registry file is re-read
   * so a spec added since boot shows as "restart pending" instead of vanishing until the next start.
   * The load status is the trace's own outcome, not the model's account of it.
   */
  pluginReport(): CommandReply {
    const report = this.pluginReportData();
    const lines = [
      `已登记 ${report.registered.length} 个：${report.registered.length > 0 ? report.registered.join(', ') : '（空）'}`,
    ];
    for (const spec of report.registered) {
      const result = report.results.find((entry) => entry.spec === spec);
      if (!result) {
        lines.push(`  - ${spec}：本进程未加载（启动后登记）；重启后生效`);
        continue;
      }
      const parts = [
        result.status,
        result.version ? `v${result.version}` : '',
        result.tools.length > 0 ? `tools=[${result.tools.join(', ')}]` : '',
        result.reason ?? '',
      ].filter(Boolean);
      lines.push(`  - ${spec}：${parts.join(' · ')}`);
    }
    return { text: lines.join('\n'), receipt: true, data: { companion_plugins: report } };
  }

  private pluginReportData(): {
    registered: string[];
    results: Array<{ spec: string; status: string; version?: string; reason?: string; tools: string[]; commands: string[] }>;
  } {
    return {
      registered: readPluginRegistry(this.config.dataDir),
      results: this.pluginResults.map((entry) => ({
        spec: entry.spec,
        status: entry.status,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
        tools: entry.tools,
        commands: entry.commands,
      })),
    };
  }

  /** What `/health` reports: the registry this process started with, and every load's outcome. */
  pluginHealth(): {
    registered: string[];
    results: Array<{ spec: string; status: string; version?: string; reason?: string; tools: string[]; commands: string[] }>;
  } {
    return {
      registered: [...this.config.plugins],
      results: this.pluginResults.map((entry) => ({
        spec: entry.spec,
        status: entry.status,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
        tools: entry.tools,
        commands: entry.commands,
      })),
    };
  }

  /**
   * `/plugins add <spec>`: append to the registry, trace the registration with its source, then
   * restart through the service manager that already owns this process. The confirmation that this
   * will execute third-party code is the command-proposal gate — the companion offers the command,
   * the owner confirms it, and `runCommand` runs it exactly like a typed command.
   */
  async installPlugin(rawSpec: string): Promise<CommandReply> {
    const spec = rawSpec.trim();
    if (spec === '' || /[\r\n]/u.test(spec)) {
      return { text: 'invalid_plugin_spec: 插件 spec 不能为空，也不能包含换行。', receipt: true };
    }
    const path = pluginsConfigPath(this.config.dataDir);
    let registry: string[];
    try {
      registry = readPluginRegistry(this.config.dataDir);
    } catch (error) {
      return { text: `登记失败：${error instanceof Error ? error.message : String(error)}。先修好 ${path} 再试。`, receipt: true };
    }
    if (registry.includes(spec)) {
      return { text: `${spec} 已经在注册表里（${path}）。本进程的加载结果见 /plugins 或 /health 的 plugins。`, receipt: true };
    }
    const next = [...registry, spec];
    writePluginRegistry(this.config.dataDir, next);
    this.trace.append('plugin_registered', { spec, source: 'command', registry: path, registered: next });
    const restart = this.schedulePluginRestart(spec);
    return {
      text: [
        `已登记 ${spec} → ${path}（0600）。`,
        restart.ok
          ? `约 ${PLUGIN_RESTART_GRACE_MS} ms 后重启自己（${restart.detail}）；回来后 open-assignment 会续办。`
          : `本进程没有服务管理器接管（${restart.detail}），需要手动重启常驻进程后生效。`,
        '重启后用 /plugins 或 curl /health 核对是否真的加载。',
      ].join('\n'),
      receipt: true,
    };
  }

  /**
   * The existing restart path: a unit/plist on disk means a manager owns this process, so
   * `restartService` stops and starts it. The reply must reach the socket first, hence the grace.
   * Without a manager nothing here invents one — the receipt says the restart is the owner's.
   */
  private schedulePluginRestart(spec: string): { ok: boolean; detail: string } {
    const target = this.serviceRestartTarget();
    if (!target) {
      this.trace.append('plugin_restart_skipped', { spec, reason: 'no_service_manager' });
      return { ok: false, detail: '找不到接管本进程（且指向这个数据目录）的 systemd unit / launchd plist' };
    }
    const assignment = this.machine.runtime.openAssignment;
    if (assignment) {
      this.machine.updateRuntime({ resumeAfterRestart: { assignmentId: assignment.id, at: this.now(), reason: 'plugins' } });
    }
    const restart = this.options.restartResident ?? (() => restartService(defaultRunner(), target.spec, target.platform));
    this.trace.append('plugin_restart_scheduled', {
      spec,
      service: target.spec.serviceName,
      platform: target.platform,
      graceMs: PLUGIN_RESTART_GRACE_MS,
      resumeAssignmentId: assignment?.id ?? null,
    });
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(restart)
        .catch((error) => this.trace.append('plugin_restart_failed', { service: target.spec.serviceName, message: error instanceof Error ? error.message : String(error) }));
    }, PLUGIN_RESTART_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    return { ok: true, detail: `${target.platform === 'linux' ? 'systemctl --user restart' : 'launchctl kickstart -k'} ${target.spec.serviceName}` };
  }

  /** The spec the installer's unit was rendered from, rebuilt from the state it recorded. */
  private serviceRestartTarget(): { spec: ServiceSpec; platform: Platform } | undefined {
    const choices = readInstallState(this.config.dataDir)?.choices ?? {};
    const platform = choices.platform ?? process.platform;
    if (platform !== 'linux' && platform !== 'darwin') return undefined;
    const spec: ServiceSpec = {
      serviceName: choices.serviceName ?? 'cogmem-companion',
      bunPath: process.execPath,
      shellDir: shellDirOfTree(treeOfThisProcess()),
      dataDir: this.config.dataDir,
      workspaceRoot: this.config.workspaceRoot,
      projectId: this.config.projectId,
      agentId: this.config.agentId,
      httpPort: choices.httpPort ?? this.config.http.port,
      envFile: join(this.config.dataDir, 'env'),
      logFile: join(this.config.dataDir, 'service.log'),
      homeDir: process.env.HOME ?? homedir(),
      env: {},
    };
    const unitPath = servicePath(spec, platform);
    if (!existsSync(unitPath)) return undefined;
    // The manager owns *this* process only if the unit it would restart names this data dir. A unit
    // for another install on the same machine is not this process's manager: restarting it would
    // take down a resident that never asked. (Found by the suite restarting the dev service from a
    // temp data dir — the guard is the fix, not a test-only setting.)
    try {
      return readFileSync(unitPath, 'utf8').includes(spec.dataDir) ? { spec, platform } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The one automatic continuation: a restart this surface asked for. The flag is cleared before the
   * run, so a run that dies does not restart into another resume. A kill never sets it.
   */
  private resumeAfterRequestedRestart(): void {
    const request = this.machine.runtime.resumeAfterRestart;
    if (!request) return;
    this.machine.updateRuntime({ resumeAfterRestart: undefined });
    const assignment = this.machine.runtime.openAssignment;
    if (!assignment || assignment.id !== request.assignmentId) {
      this.trace.append('assignment_resume_skipped', { assignmentId: request.assignmentId, reason: assignment ? 'assignment_replaced' : 'no_assignment' });
      return;
    }
    this.trace.append('assignment_resume', { assignmentId: assignment.id, reason: request.reason, requestedAt: request.at });
    setTimeout(() => {
      void this.resumeAssignment(assignment.id).catch((error) =>
        this.trace.append('assignment_resume_failed', { assignmentId: assignment.id, message: error instanceof Error ? error.message : String(error) }),
      );
    }, 0);
  }

  private async resumeAssignment(assignmentId: string): Promise<void> {
    const assignment = this.machine.runtime.openAssignment;
    if (!assignment || assignment.id !== assignmentId) return;
    if (this.machine.state !== 'IDLE') {
      this.trace.append('assignment_resume_skipped', { assignmentId, reason: `state:${this.machine.state}` });
      return;
    }
    if (this.dailyBudgetExceeded()) {
      this.trace.append('daily_budget_exceeded', {
        trigger: 'assignment_resume',
        assignmentId,
        day: tokyoDate(this.now()),
        spent: this.dailySpent(),
        limit: this.config.dailyBudget.maxTokensPerDay,
      });
      return;
    }
    await this.executeRun(assignment.text, 'message_received', 'assignment_resume');
  }

  /**
   * `/why`: read back the newest recall decision. This goes through the kernel's own `TraceStore`
   * read face — `trace_events` is written by `RecallDecisionTrace` for every recall, and the
   * emergence decision point calls the same recall lane, so both a recall and a surfacing have a row
   * here. It is a read of what was decided, not a re-run (which would write a fresh row); no row is
   * an answer the receipt gives plainly instead of guessing at one.
   */
  whyReport(): string {
    const emergence = this.trace.read().filter((record) => record.kind === 'emergence_decision').pop();
    try {
      const db = this.kernel.factStore.getDatabase();
      const hasTraceTable = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trace_events'`).all() as unknown[]).length > 0;
      if (!hasTraceTable) {
        return emergence ? this.emergenceWhyReport(emergence) : '本会话尚无召回决策痕迹（内核还没有 trace_events 表）。不编造。';
      }
      const store = new TraceStore(db);
      const rows = store.queryByEventType('recall.result').filter((event) => {
        if (event.projectId !== undefined && event.projectId !== this.config.projectId) return false;
        // The trace table has no agent column, so the payload is where an owner can be named (the same
        // reading the observatory uses): an unnamed row is project-level and shown, a named other is not.
        const payload = event.payload as Record<string, unknown>;
        const named = [payload.agentId, payload.agent, payload.sourceAgent].filter((value): value is string => typeof value === 'string');
        return named.length === 0 || named.includes(this.config.agentId);
      });
      const last = rows[rows.length - 1];
      if (!last) return emergence ? this.emergenceWhyReport(emergence) : '本会话尚无召回决策痕迹。不编造。';
      // Whichever decision is newer is the one the receipt answers with: an asked recall after a
      // surfaced candidate is the recall; the emergence step is shown until something newer lands.
      if (emergence && Number(emergence.now ?? emergence.at ?? 0) >= last.timestamp) {
        return this.emergenceWhyReport(emergence);
      }
      const payload = last.payload as Record<string, unknown>;
      const selected = Array.isArray(payload.selectedIds) ? payload.selectedIds.map(String) : [];
      const suppressed = Array.isArray(payload.suppressed) ? (payload.suppressed as Array<Record<string, unknown>>) : [];
      const chain = store.getDecisionChain(last.id);
      const lines = [
        `最近一次召回决策 · ${new Date(last.timestamp).toISOString()}`,
        `查询：${typeof payload.query === 'string' && payload.query !== '' ? payload.query : '（空）'}`,
        `车道：${String(payload.lane ?? 'unknown')} · 理由：${String(payload.reason ?? 'unknown')}`,
        `选中 ${selected.length} 条${selected.length > 0 ? `：${selected.join(', ')}` : ''}`,
      ];
      if (suppressed.length > 0) {
        lines.push(`抑制 ${suppressed.length} 类：${suppressed.map((entry) => `${String(entry.reason ?? 'unknown')}×${Number(entry.count ?? 0)}`).join('、')}`);
      }
      lines.push(`来源链：${chain.length <= 1 ? '无父事件' : chain.map((event) => event.eventType).join(' ← ')}`);
      return lines.join('\n');
    } catch (error) {
      // A read that failed is not "no trace": the receipt says which it was, or a broken database
      // would read as an empty history.
      this.trace.append('why_read_failed', { message: error instanceof Error ? error.message : String(error) });
      if (emergence) return this.emergenceWhyReport(emergence);
      return '读决策痕迹失败（内核读取报错）；没有可展示的内容。';
    }
  }

  /**
   * The emergence decision's own trace: the F10 grade, the F8 occasion gate and the F7 modulation
   * step, in the order F6 evaluated them. The shell only reports what the kernel decided; a
   * missing step is named rather than guessed.
   */
  private emergenceWhyReport(record: Record<string, unknown>): string {
    const at = typeof record.now === 'number' ? record.now : Number(record.at ?? 0);
    const candidates = Array.isArray(record.candidates) ? record.candidates as Array<Record<string, unknown>> : [];
    const withheld = Array.isArray(record.withheld) ? record.withheld as Array<Record<string, unknown>> : [];
    const shown = candidates[0] ?? withheld[0];
    const lines = [
      `最近一次浮现决策 · ${new Date(at).toISOString()}`,
      `通道：${String(record.channel ?? 'unknown')} · 场合：${String(record.occasion ?? 'unknown')} · 候选 ${candidates.length} 条`,
    ];
    if (!shown) {
      lines.push('没有候选（无到期承诺/意图或唤醒意图）。');
      return lines.join('\n');
    }
    const steps = Array.isArray(shown.steps) ? shown.steps as Array<Record<string, unknown>> : [];
    const stepOf = (rule: string) => steps.find((step) => step.rule === rule);
    const detailOf = (rule: string) => {
      const detail = stepOf(rule)?.detail;
      return detail && typeof detail === 'object' ? detail as Record<string, unknown> : {};
    };
    const sensitivity = stepOf('sensitivity');
    const occasion = stepOf('occasion');
    const modulation = stepOf('modulation');
    const matched = Array.isArray(detailOf('sensitivity').matched) ? detailOf('sensitivity').matched as unknown[] : [];
    lines.push(`来源：${String(shown.source ?? 'unknown')} · 分级：${String(sensitivity?.outcome ?? shown.sensitivity ?? 'unknown')}（命中 ${matched.length} 条标记）`);
    lines.push(`场合闸：${String(occasion?.outcome ?? 'unknown')} · 决定：${String(detailOf('occasion').decision ?? 'unknown')} · 理由：${String(detailOf('occasion').reason ?? 'unknown')}`);
    lines.push(`反馈：${String(modulation?.outcome ?? 'unknown')} · level=${String(detailOf('modulation').level ?? 'n/a')} · cooldownUntil=${String(detailOf('modulation').cooldownUntil ?? 'null')}`);
    lines.push(candidates.length > 0
      ? `候选：${String(shown.text ?? '')}`
      : `抑制 ${withheld.length} 条：${String(shown.reason ?? 'unknown')}`);
    lines.push(`步骤：${steps.map((step) => `${String(step.rule)}=${String(step.outcome)}`).join('; ')}`);
    return lines.join('\n');
  }

  private lastDreamProduct(): { localDate: string; eventCount: number; summary: string } | undefined {
    const records = this.trace.read().filter((record) => record.kind === 'dream_complete');
    const last = records[records.length - 1];
    if (!last) return undefined;
    const localDate = String(last.localDate ?? '');
    const events = this.kernel.getThreadEvents(`companion-dream:${localDate}`, { projectId: this.config.projectId, limit: 50 });
    const product = events.find((event) => (event.payload as { metadata?: { kind?: unknown } } | undefined)?.metadata?.kind === 'dream-integration');
    const summary = (product?.payload as { text?: unknown } | undefined)?.text;
    return { localDate, eventCount: Number(last.eventCount ?? 0), summary: typeof summary === 'string' ? summary : `夜间整合 ${localDate}` };
  }

  // ---- The resident-form upgrade ------------------------------------------------------------------

  /**
   * `/upgrade <新版目录>`: stage the new tree, promise the report, hand the cycle to the supervisor.
   *
   * The gate is the first thing here and it is the requirement's own wording: only a *silent* state
   * may be upgraded. RUNNING is someone's turn, DREAMING is the night's integration, WAKING is the
   * instant between them — in all three the machine has work whose interruption is not this command's
   * to decide silently. IDLE and DORMANT are the states where nothing is in flight.
   *
   * The resident does not stop itself. It writes the request, records the promise and returns; the
   * supervisor stops, swaps, migrates, gates and restarts. The announcement below is what the user
   * sees *before* that happens — the low-disturbance notice that the shell is going offline.
   */
  async upgrade(source: string): Promise<CommandReply> {
    const state = this.machine.state;
    if (state !== 'IDLE' && state !== 'DORMANT') {
      this.trace.append('upgrade_refused', { state, reason: 'not_silent' });
      const detail = state === 'RUNNING'
        ? '一次对话/工作正在跑'
        : state === 'DREAMING'
          ? '夜间整合正在跑'
          : '正在唤醒（时间语境注入中）';
      return {
        text: `现在不能升级：生命周期是 ${state}（${detail}）。升级只从静默态（IDLE / DORMANT）发起，等它回到 IDLE 再说；此刻不动，也不写快照。`,
        receipt: true,
      };
    }
    const trimmed = source.trim();
    if (trimmed === '') {
      return {
        text: '用法：/upgrade <新版目录> —— 指向一份新的 Cog 树（含 shell/ 与 src/）。升级会：旁置装新版 → 迁移前整脑快照 → 用新版迁移+自检 → 切换 → 起新版；任一步不过自动回滚旧版。',
        receipt: true,
      };
    }
    const pending = readUpgradeRequest(this.config.dataDir);
    if (pending) {
      this.trace.append('upgrade_refused', { reason: 'in_flight', upgradeId: pending.id });
      return { text: `已经有一次升级在跑（${pending.fromVersion} → ${pending.toVersion}，id ${pending.id}）：它的结果还没回来，先等它报完。`, receipt: true };
    }

    let staged: { tree: string; version: string };
    try {
      staged = stageUpgradeTree({ source: trimmed, dataDir: this.config.dataDir, currentTree: treeOfThisProcess() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace.append('upgrade_stage_failed', { source: trimmed, message });
      return { text: `升级没有开始：旁置安装失败（${message}）。没有写快照、没有动服务。`, receipt: true };
    }

    const id = newUpgradeId(this.now());
    const fromVersion = readTreeVersion(treeOfThisProcess());
    const request = this.buildUpgradeRequest(id, fromVersion, staged);
    // The promise comes before anything can go offline: it is the durable statement that a report is
    // owed, and it is closed by speaking that report (F2's own wake intention — no new bookkeeping).
    const promise = this.machine.addWakeIntent({
      at: this.now() + UPGRADE_REPORT_GRACE_MS,
      reason: upgradePromiseReason(id),
    });
    writeUpgradeJson(upgradeRequestPath(this.config.dataDir), request);
    this.trace.append('upgrade_announced', {
      upgradeId: id,
      from: fromVersion,
      to: staged.version,
      fromTree: request.fromTree,
      toTree: staged.tree,
      serviceMode: request.serviceMode,
      promiseId: promise.id,
    });

    const requestPath = upgradeRequestPath(this.config.dataDir);
    const spawned = await (this.options.upgradeSpawner
      ?? ((upgradeRequest, path) => spawnUpgradeSupervisor(upgradeRequest, path, { run: defaultRunner() })))(request, requestPath);
    if (!spawned.ok) {
      // Nothing left this process, so nothing is owed: withdraw the request and the promise rather
      // than leave a report that will never come.
      clearUpgradeRequest(this.config.dataDir);
      this.machine.consumeWakeIntent(promise.id);
      this.trace.append('upgrade_spawn_failed', { upgradeId: id, message: spawned.detail });
      return { text: `升级没有开始：${spawned.detail}。快照未写、服务未动，也没有留下回报承诺。`, receipt: true };
    }
    this.trace.append('upgrade_scheduled', { upgradeId: id, supervisor: spawned.detail });
    return {
      text: `好，我要短暂下线一会儿（${fromVersion} → ${staged.version}）：先给脑子整份快照，再用新版迁移 + 召回自检，过了才切换、起新版；任一步不过自动回滚旧版。回来就向你回报结果。`,
      receipt: true,
    };
  }

  private buildUpgradeRequest(id: string, fromVersion: string, staged: { tree: string; version: string }): UpgradeRequest {
    const dataDir = this.config.dataDir;
    const homeDir = process.env.HOME ?? homedir();
    const install = readInstallState(dataDir);
    const choices = install?.choices ?? {};
    const base = {
      id,
      at: this.now(),
      fromVersion,
      fromTree: treeOfThisProcess(),
      toVersion: staged.version,
      toTree: staged.tree,
      pid: process.pid,
      dataDir,
      dbPath: this.config.dbPath,
      workspaceRoot: this.config.workspaceRoot,
      projectId: this.config.projectId,
      agentId: this.config.agentId,
      httpPort: choices.httpPort ?? this.config.http.port,
      socketPath: this.config.attach.socketPath ?? defaultSocketPath(dataDir),
      bunPath: process.execPath,
      homeDir,
      serviceMode: false,
      serviceName: choices.serviceName ?? 'cogmem-companion',
      platform: choices.platform ?? process.platform,
      envFile: join(dataDir, 'env'),
      logFile: join(dataDir, 'service.log'),
      // The reply that announces the disconnection is written right after this method returns; the
      // supervisor waits this long before its first step so that it cannot cut the announcement off.
      handoffGraceMs: 1_000,
    } satisfies Omit<UpgradeRequest, 'handoffGraceMs'> & { handoffGraceMs: number };
    // A unit/plist on disk is the fact that a manager owns this process, which decides how the
    // supervisor has to be launched to survive the stop it performs.
    return { ...base, serviceMode: serviceFileExists(base as UpgradeRequest) };
  }

  /**
   * Speak an owed upgrade report, once, and close the promise with it.
   *
   * Three cases, and the third is the one the ticket calls a veto-level failure:
   *
   *  - an outcome nobody has reported → report it (this is requirement ③ and ④ in one path);
   *  - a promise whose due instant has passed with no outcome and no live supervisor → report the
   *    silence as a failure, because an upgrade that ends in silence is worse than one that failed;
   *  - a request whose supervisor is still running → say nothing yet: it is mid-cycle, not silent.
   */
  private settleUpgradeReport(at: number): void {
    const outcome = readUpgradeOutcome(this.config.dataDir);
    if (outcome && outcome.reportedAt === undefined) {
      this.markUpgradeReported(outcome, at);
      return;
    }
    if (outcome) return;
    const promise = this.machine.wakeIntents.find((intent) => !intent.consumedAt && isUpgradePromise(intent.reason));
    const request = readUpgradeRequest(this.config.dataDir);
    if (request) {
      if (supervisorIsAlive(this.config.dataDir)) {
        // Mid-cycle: the supervisor owns the record and has not finished. Saying "failed" here would
        // be a lie about an upgrade that is still running.
        this.trace.append('upgrade_report_waiting', { upgradeId: request.id, dueAt: promise?.at });
        return;
      }
      // The handoff write and the supervisor's first act are not atomic: between them there is no pid
      // file yet. Only the promise's due instant decides that the owner is gone, so a tick landing in
      // that window cannot declare a veto-level failure about an upgrade that just started.
      const silenceAfter = promise?.at ?? request.at + UPGRADE_REPORT_GRACE_MS;
      if (at < silenceAfter) return;
      const silence: UpgradeOutcome = {
        id: request.id,
        fromVersion: request.fromVersion,
        toVersion: request.toVersion,
        fromTree: request.fromTree,
        toTree: request.toTree,
        status: 'failed',
        step: 'requested',
        startedAt: request.at,
        finishedAt: at,
        checks: [],
        error: '监督进程没有留下结果就消失了（升级后沉默）',
        rollback: '未知：没有结果文件，无法确认旧版是否仍在服务；见 shell-events.jsonl 的 upgrade_* 记录',
      };
      clearUpgradeRequest(this.config.dataDir);
      this.markUpgradeReported(silence, at);
      return;
    }
    // The obligation outlived both records: report the promise rather than swallowing it.
    if (promise && promise.at <= at) {
      this.reportUpgradeText('升级回报承诺到期，但升级记录已经不在了（既没有结果，也没有在跑的请求）——按未回报处理。');
      this.trace.append('upgrade_promise_orphaned', { promiseId: promise.id });
      this.machine.consumeWakeIntent(promise.id);
    }
  }

  private markUpgradeReported(outcome: UpgradeOutcome, at: number): void {
    // Persisted with `reportedAt` set, so a restarted resident cannot report the same outcome twice —
    // including the silence outcome, which is the one record that would otherwise exist nowhere.
    writeUpgradeJson(upgradeOutcomePath(this.config.dataDir), { ...outcome, reportedAt: at });
    const promise = this.machine.wakeIntents.find((intent) => !intent.consumedAt && isUpgradePromise(intent.reason));
    if (promise) this.machine.consumeWakeIntent(promise.id);
    this.trace.append('upgrade_reported', {
      upgradeId: outcome.id,
      status: outcome.status,
      step: outcome.step,
      from: outcome.fromVersion,
      to: outcome.toVersion,
      checks: outcome.checks.length,
      failedChecks: outcome.checks.filter((check) => !check.ok).map((check) => check.id),
      promiseClosed: promise?.id,
    });
    this.lastUpgrade = outcome;
    this.reportUpgradeText(describeUpgradeOutcome(outcome));
  }

  /** The report reaches a face that is listening: the line channel prints it, the TUI reads it on attach. */
  private reportUpgradeText(text: string): void {
    void this.host.bus.emit('terminal_print', { text: `${text}\n` });
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

/**
 * The reported prompt-cache ratio, or `undefined` when the provider reported no cache field. `miss`
 * is the provider's own miss count when it sends one (DeepSeek), otherwise the prompt less the hit —
 * the same denominator Pi's hit-rate display uses (`pi-coding-agent/dist/modes/interactive/components/
 * footer.js:105-107`: `cacheRead / (input + cacheRead + cacheWrite)`). A hit with no prompt size
 * yields no ratio: the divisor would be invented, and an invented ratio is worse than none.
 */
function promptCacheAccount(usage: TurnUsage | undefined): { hit: number; miss: number; percent: number } | undefined {
  const hit = usage?.cacheHit;
  if (hit === undefined) return undefined;
  const miss = usage?.cacheMiss ?? (usage?.input === undefined ? undefined : Math.max(0, usage.input - hit));
  if (miss === undefined || hit + miss <= 0) return undefined;
  return { hit, miss, percent: Math.round((hit / (hit + miss)) * 100) };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** The issue's day boundary is Tokyo's, not the display time zone's. */
function tokyoDate(at: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}


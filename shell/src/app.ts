/**
 * Assembly: the three core pieces (state machine, plugin host, kernel connection) wired to the
 * plugins that carry every capability.
 *
 * The app is also the only place that knows the transition triggers' meanings — a message wakes the
 * shell, a due intent re-injects the clock, the cage's overrun leaves RUNNING. Plugins decide
 * behaviour; the app decides which transition that behaviour is.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createMemoryKernel, KernelAgentMemoryBackend, type MemoryKernel } from 'cogmem';
import { defaultShellConfig, type ShellConfig } from './config.ts';
import { StateMachine } from './state/machine.ts';
import { CheckpointStore, type InFlightToolCall } from './state/checkpoint.ts';
import { ProcessLock } from './process-lock.ts';
import { TraceLog } from './trace.ts';
import { PluginHost } from './plugins/host.ts';
import { clockPlugin, ClockService } from './plugins/clock.ts';
import { providedModelPlugin } from './plugins/mg-provider.ts';
import { ModelRouter, modelRouterPlugin, routeLine } from './model/router.ts';
import { RouteStore, redactUrl } from './model/routes.ts';
import { cagePlugin, RunCage } from './plugins/cage.ts';
import { builtinToolsPlugin } from './plugins/builtin-tools.ts';
import { capturePlugin } from './plugins/capture.ts';
import { recallPlugin } from './plugins/recall.ts';
import { dreamPlugin } from './plugins/dream.ts';
import { emergencePlugin } from './plugins/emergence.ts';
import { terminalPlugin, TerminalChannel, type ShellControl } from './channels/terminal.ts';
import { AgentRuntime, type ModelProvider, type RunSummary } from './state/agent-loop.ts';
import { startKernelHttpFace, type HttpFaceHandle } from './kernel-host.ts';
import { readSoul } from './install/soul.ts';
import { AttachServer, defaultSocketPath, type AttachShell } from './attach/server.ts';
import { buildAwayReport, enqueueAway } from './presence.ts';
import type { PresenceReport, StatusState, WorkState } from './tui/view.ts';

export interface PiPluginLoadResult {
  pluginName: string;
  status: string;
  tools: string[];
  commands: string[];
  refusedCapabilities: string[];
}

export interface CompanionShellOptions {
  config?: Partial<ShellConfig>;
  /** Tests inject a deterministic provider; production uses the mg plugin. */
  modelProvider?: ModelProvider;
  now?: () => number;
  tick?: boolean;
  /** Called when a checkpoint write fails; the CLI turns it into a non-zero exit. */
  onAlarm?: (error: Error) => void;
  terminalInput?: NodeJS.ReadableStream;
  terminalOutput?: NodeJS.WritableStream;
}

export class CompanionShell implements ShellControl, AttachShell {
  readonly config: ShellConfig;
  readonly trace: TraceLog;
  readonly machine: StateMachine;
  readonly host: PluginHost;
  readonly kernel: MemoryKernel;
  readonly backend: KernelAgentMemoryBackend;
  readonly lock: ProcessLock;
  private runtime?: AgentRuntime;
  private cage?: RunCage;
  private clock?: ClockService;
  private dream?: { integrate(...args: [string, string, number?]): Promise<{ localDate: string; eventCount: number; sourceRefs: unknown[]; summary: string }> };
  private emergence?: { decide(query: string | undefined, now?: number): { candidates: Array<{ id: string; text: string; reason: string }>; suppressed: unknown[] } };
  private http?: HttpFaceHandle;
  private terminal?: TerminalChannel;
  private attach?: AttachServer;
  private modelLabel = 'unknown';
  /** Present only when this process built its own provider; an injected test provider has no routes. */
  private modelRouter?: ModelRouter;
  /** An estimate of the assembled context; the kernel has no F14 budget controller to ask. */
  private contextTokenEstimate = 0;
  private workLabel = '';
  private runTurns = 0;
  private runTokens = 0;
  private runStartedAt?: number;
  private readonly adapters: Array<{ emitSessionShutdown(): Promise<void> }> = [];
  private tickTimer?: ReturnType<typeof setInterval>;
  private started = false;
  private readonly now: () => number;
  readonly piPluginResults: PiPluginLoadResult[] = [];

  constructor(private readonly options: CompanionShellOptions = {}) {
    this.config = defaultShellConfig(options.config);
    this.now = options.now ?? Date.now;
    this.trace = new TraceLog(this.config.dataDir);
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
    this.kernel = createMemoryKernel({ dbPath: this.config.dbPath, projectTimeZone: this.config.timeZone });
    this.backend = new KernelAgentMemoryBackend(this.kernel);
    this.host = new PluginHost({ trace: this.trace });
    this.host.seedService('stateMachine', this.machine);
    this.host.seedService('eventBus', this.host.bus);
    this.host.seedService('memory', this.backend);
    this.host.seedService('kernel', this.kernel);
    this.host.seedService('shell', this);
    this.host.seedService('commands', this.host.commands);
    this.host.seedService('trace', this.trace);
    // Every transition is also a bus event, so a plugin can observe the lifecycle without reading the
    // checkpoint file. The Pi-aligned names are untouched; this one carries the companion prefix.
    this.machine.onTransition((record) => {
      if (record.to === 'RUNNING') {
        this.runStartedAt = record.at;
        this.runTurns = 0;
        this.runTokens = 0;
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

  get runtimeInstance(): AgentRuntime | undefined {
    return this.runtime;
  }

  /** The loopback HTTP face's address (status + star map), when this process started one. */
  get httpUrl(): string | undefined {
    return this.http?.baseUrl;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const lock = this.lock.acquire(process.pid, this.now());
    if (lock.recoveredStalePid) this.trace.append('stale_lock_recovered', { pid: lock.recoveredStalePid });
    let restored: ReturnType<StateMachine['restore']>;
    try {
      // The session log is read before the state machine is: a log damaged while nothing was watching
      // is repaired and written down here, and a checkpoint that cannot be recovered still leaves that
      // record behind (the lock goes with the failure, since this process will not run).
      this.trace.recover();
      restored = this.machine.restore();
    } catch (error) {
      this.lock.release(process.pid);
      throw error;
    }
    // The loadout the checkpoint's transcript declared, read before any plugin registers a tool so
    // the comparison below sees what the previous process promised, not what this one just built.
    const restoredTools = this.machine.runtime.declaredTools ? [...this.machine.runtime.declaredTools] : undefined;
    if (restored.previous && ['RUNNING', 'DREAMING', 'WAKING'].includes(restored.previous)) {
      this.trace.append('recovery', { previous: restored.previous, seq: this.machine.seq });
      await this.machine.dispatch('recovered_run', { reason: `recovered_after_kill:${restored.previous}` });
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
        health: () => ({ state: this.machine.state }),
      });
      this.trace.append('http_face_started', { url: this.http.baseUrl, port: this.http.port });
    }
    if (this.config.pi.adapterEnabled && this.config.pi.plugins.length > 0) {
      await this.loadPiPlugins();
    }
    // The executable set is complete only now (native tools, then Pi plugin tools). A checkpoint that
    // declared a different loadout is a loud failure, and the current one becomes the declaration.
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
    this.started = true;
    this.trace.append('shell_started', { state: this.machine.state, mi: this.machine.wakeIntents.length });
  }

  private async startPlugins(): Promise<void> {
    // An injected provider (tests, an embedding host) is used as-is and has no route table. The real
    // resident gets a router: the mg route from env plus whatever named routes the user stored.
    let provider = this.options.modelProvider ? providedModelPlugin(this.options.modelProvider) : undefined;
    if (!provider) {
      this.modelRouter = new ModelRouter({
        store: new RouteStore(join(this.config.dataDir, 'routes.json')).load(),
        builtin: { name: 'mg', baseUrl: this.config.model.baseUrl, apiKey: this.config.model.apiKey, model: this.config.model.model },
        timeoutMs: this.config.model.timeoutMs,
      });
      // A routes file that did not parse is a real problem the user must see, but it must not stop the
      // resident: mg is available either way.
      if (this.modelRouter.storeError) this.trace.append('model_routes_load_failed', { message: this.modelRouter.storeError });
      provider = modelRouterPlugin(this.modelRouter);
    }
    this.host.register(clockPlugin({ timeZone: this.config.timeZone, idleWakeIntervalMs: this.config.idleWakeIntervalMs, dreamWindow: { startHour: this.config.dream.windowStartHour, endHour: this.config.dream.windowEndHour } }));
    this.host.register(provider, this.config.model);
    this.host.register(cagePlugin(this.config.budgets, this.trace));
    this.host.register(builtinToolsPlugin(), { workspaceRoot: this.config.workspaceRoot });
    this.host.register(capturePlugin({ agentId: this.config.agentId, projectId: this.config.projectId, sessionId: this.config.sessionId }));
    this.host.register(recallPlugin({ agentId: this.config.agentId, projectId: this.config.projectId, limit: 3 }));
    this.host.register(dreamPlugin({ agentId: this.config.agentId, projectId: this.config.projectId, sessionId: this.config.sessionId, runKernelNight: this.config.dream.runKernelNight, maxEpisodes: this.config.dream.maxEpisodes }));
    this.host.register(emergencePlugin({ agentId: this.config.agentId, projectId: this.config.projectId }));
    if (this.config.terminalEnabled) {
      this.host.register(terminalPlugin({
        shell: this,
        commands: this.host.commands,
        input: this.options.terminalInput,
        output: this.options.terminalOutput,
        trace: this.trace,
        captureTerminalRecord: async (text: string) => {
          await this.captureService?.captureTerminalRecord(text, `companion-day:${this.clock!.localDate()}`);
        },
      }));
    }
    await this.host.start();
    this.clock = this.host.getService<ClockService>('clock');
    this.cage = this.host.getService<RunCage>('cage');
    const model = this.host.getService<ModelProvider>('model');
    this.runtime = new AgentRuntime({
      bus: this.host.bus,
      tools: this.host.tools,
      provider: model,
      budget: this.cage,
      systemPrompt: () => this.systemPrompt(),
      trace: this.trace,
      clock: this.now,
      // A mid-run hot-plug declares the delta in the transcript; the checkpoint keeps the same set so
      // the next recovery can compare it against what the process can run.
      onToolsDeclared: (names) => this.machine.updateRuntime({ declaredTools: [...names].sort() }),
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
   * stricter: if the checkpoint promised a set the process can no longer execute exactly — a plugin
   * removed, added or failed to load — the shell refuses to start with a transcript that names tools
   * it does not have, rather than run degraded and quiet.
   */
  private declaredToolMismatch(restored: string[] | undefined): { declared: string[]; executable: string[] } | undefined {
    if (!restored) return undefined;
    const executable = this.executableToolNames();
    const declared = [...restored].sort();
    if (declared.length === executable.length && declared.every((name, index) => name === executable[index])) return undefined;
    return { declared, executable };
  }

  private async loadPiPlugins(): Promise<void> {
    const adapterModule = await import('./pi/adapter.ts');
    for (const spec of this.config.pi.plugins) {
      const entry = adapterModule.resolvePiExtensionEntry(spec, this.config.workspaceRoot);
      const adapter = new adapterModule.PiCompatAdapter({
        host: this.host,
        pluginName: spec,
        cwd: this.config.workspaceRoot,
        sessionId: this.config.sessionId,
        systemPrompt: () => this.systemPrompt(),
        isIdle: () => this.machine.state === 'IDLE',
        hasPendingMessages: () => (this.runtime?.pendingMessages ?? 0) > 0,
        abort: () => this.runtime?.abort('pi_extension_abort'),
        onShutdown: () => void this.stop(),
        onSendMessage: ({ text, deliverAs }) => this.onPiMessage(text, deliverAs),
        trace: this.trace,
      });
      const result = await adapter.load(entry);
      await adapter.emitSessionStart();
      this.adapters.push(adapter);
      this.piPluginResults.push(result);
    }
  }

  private onPiMessage(text: string, deliverAs: 'steer' | 'followUp' | 'nextTurn'): void {
    if (deliverAs === 'steer' && this.machine.state === 'RUNNING') {
      this.runtime!.steer(text);
      return;
    }
    if (deliverAs === 'followUp' && this.machine.state === 'RUNNING') {
      this.runtime!.followUp(text);
      return;
    }
    void this.submit(text).catch((error) => this.trace.append('pi_message_failed', { message: error instanceof Error ? error.message : String(error) }));
  }

  systemPrompt(): string {
    return [
      'You are a resident companion agent whose memory is Cogmem. Memory comes first: recall before you answer, and let what you remember shape how you say it.',
      'You are present at all hours; when nothing needs you, you are quiet rather than chatty.',
      'You have four basic tools (read, write, edit, bash). Use them when the moment needs real work; otherwise just talk.',
      'Never invent a memory. If recall is empty, say so plainly.',
      this.machine.runtime.lastTimeContext ?? (this.clock ? this.clock.timeContextBlock(this.now()) : ''),
    ].filter(Boolean).join('\n\n');
  }

  async submit(text: string): Promise<RunSummary | undefined> {
    if (this.machine.state === 'RUNNING') {
      this.runtime!.steer(text);
      this.emitSteering();
      return undefined;
    }
    this.clock!.markInteraction(text, this.now());
    await this.wakeIfNeeded('message_received');
    if (this.machine.state !== 'IDLE') throw new Error(`submit_requires_idle: state is ${this.machine.state}`);
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

  private async executeRun(text: string, trigger: 'message_received' | 'emergence_due', reason: string): Promise<RunSummary> {
    const runId = `run-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    this.cage!.beginRun(runId);
    await this.machine.dispatch(trigger, { runId, reason });
    const summary = await this.runtime!.run({ runId, sessionId: this.config.sessionId, userText: text });
    await this.machine.dispatch(summary.stopReason, { reason: summary.error ?? reason, runId });
    if (!this.clock!.nextPendingIntent()) this.clock!.scheduleIdleWake();
    return summary;
  }

  /** One deterministic tick: due intent, then dream window, then the emergence decision point. */
  async tick(at = this.now()): Promise<void> {
    if (this.machine.state === 'RUNNING' || this.machine.state === 'WAKING') return;
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
      const decision = this.emergence!.decide(this.machine.runtime.lastInteractionText, at);
      if (decision.candidates.length > 0) {
        const candidate = decision.candidates[0];
        if (this.shouldHoldForAbsence()) {
          // Nobody is attached, so speaking now would be talking to an empty room. Hold it in the
          // durable away queue and let the next attach's "你不在时" broadcast carry it.
          this.machine.updateRuntime({
            awayQueue: enqueueAway(this.machine.runtime, { id: candidate.id, text: candidate.text, reason: candidate.reason, at }),
          });
          this.trace.append('emergence_accumulated', { id: candidate.id, reason: candidate.reason, at });
          return;
        }
        void this.host.bus.emit('companion_emergence', { id: candidate.id, reason: candidate.reason, text: candidate.text });
        await this.executeRun(candidate.text, 'emergence_due', `emergence:${candidate.id}`);
      }
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
      this.contextTokenEstimate = 500; // the system prompt's own weight, the one part no message carries
      this.emitStatus();
    });
    this.host.bus.on('turn_start', (event: { turnIndex?: number }) => {
      this.runTurns = event.turnIndex ?? this.runTurns;
      this.workLabel = '思考中';
      this.emitWork();
    });
    this.host.bus.on('turn_usage', (event: { totalTokens?: number }) => {
      this.runTokens = event.totalTokens ?? this.runTokens;
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
    this.host.bus.on('message_end', (event: { message?: { role?: string; content?: string } }) => {
      if (event.message?.content) {
        this.contextTokenEstimate += Math.ceil(event.message.content.length / 4);
        this.emitStatus();
      }
    });
    this.host.bus.on('turn_end', () => this.emitSteering());
    this.host.bus.on('agent_end', (event: { summary?: RunSummary }) => {
      const tokens = event.summary?.tokens ?? 0;
      if (tokens > 0) this.chargeCost(tokens);
    });
    this.host.bus.on('agent_settled', () => {
      this.workLabel = '思考中';
      this.emitWork();
      this.emitSteering();
      this.emitStatus();
    });
  }

  private chargeCost(tokens: number): void {
    try {
      const today = this.clock?.localDate() ?? new Date().toISOString().slice(0, 10);
      const previous = this.machine.runtime.costDayDate === today ? this.machine.runtime.costDayTokens ?? 0 : 0;
      this.machine.updateRuntime({ costDayDate: today, costDayTokens: previous + tokens });
    } catch (error) {
      this.trace.append('cost_charge_failed', { tokens, message: error instanceof Error ? error.message : String(error) });
    }
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
    const today = this.clock?.localDate() ?? new Date().toISOString().slice(0, 10);
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
      contextSweetSpot: this.config.contextSweetSpot,
      costTokens: this.machine.runtime.costDayDate === today ? this.machine.runtime.costDayTokens ?? 0 : 0,
      timeZone: this.config.timeZone,
    };
  }

  currentWork(): WorkState {
    return {
      active: this.machine.state === 'RUNNING',
      label: this.workLabel,
      startedAt: this.runStartedAt,
      turns: this.runTurns,
      maxTurns: this.config.budgets.maxTurnsPerRun,
      tokens: this.runTokens,
      maxTokens: this.config.budgets.maxTokensPerRun,
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
    });
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

  /** A `/` command answered by the resident; the TUI renders the text in its own overlay. */
  commandText(name: string, args?: string): { text: string; data?: Record<string, unknown> } {
    switch (name) {
      case 'dream': {
        const product = this.lastDreamProduct();
        return {
          text: product ? `${product.localDate}：${product.summary}` : '本会话尚无做梦产物。',
          data: product ? { companion_dream: { product } } : undefined,
        };
      }
      case 'commitments': {
        const items = this.commitments();
        const fulfilled = items.filter((item) => item.status === 'completed').length;
        return { text: `承诺册 ${items.length} 条（已兑现 ${fulfilled} 条）`, data: { companion_commitments: { items } } };
      }
      case 'soul': {
        // Read back what the installer wrote. F17's editor is the star sea's job; until then the
        // v0 row is what the resident can show, and showing it beats claiming it is not there.
        const row = readSoul(this.config.dbPath, this.config.agentId);
        if (!row) return { text: `soul 尚未写入。当前身份 ${this.config.agentId}。` };
        const bytes = Buffer.byteLength(row.content);
        return {
          text: `soul v${row.version}（${bytes} 字节）：${row.content.split('\n')[0]}`,
          data: { companion_soul: { version: row.version, bytes, agentId: row.agentId } },
        };
      }
      case 'memory':
        return { text: `星海（记忆图）前端不在本壳内；记忆库文件：${this.config.dbPath}` };
      case 'status':
        return { text: `生命周期 ${this.machine.state}，checkpoint seq ${this.machine.seq}，本日 ${this.machine.runtime.costDayTokens ?? 0} token。` };
      case 'context':
        return { text: `当前组装上下文约 ${this.contextTokenEstimate} token（甜点带宽 ${this.config.contextSweetSpot}）。本壳未接入 F14 车道控制器。` };
      case 'model': {
        if (!this.modelRouter) return { text: `会话模型：${this.modelLabel}（本进程未接入路线表，切换需重装或重启）。` };
        const requested = args?.trim() ?? '';
        if (requested !== '') {
          const switched = this.switchModelRoute(requested);
          if (!switched.ok) return { text: `切换失败：${switched.message}` };
          return {
            text: `已切到路线「${switched.name}」（${switched.model}）。下一回合生效：进程没重启，会话没断。`,
            data: { companion_model_routes: { routes: this.modelRoutes(), active: switched.name } },
          };
        }
        const routes = this.modelRouter.routes();
        const lines = routes.map((route) => routeLine(route, route.name === this.modelRouter!.active));
        const warning = this.modelRouter.storeError ? [`⚠ 路线表有问题：${this.modelRouter.storeError}（内置 mg 仍可用；修好或删掉这个文件再重试）`] : [];
        return {
          text: [`当前路线：${this.modelRouter.active}`, ...lines, ...warning, '用 /model <名称> 切换（不重启、不断会话）'].join('\n'),
          data: { companion_model_routes: { routes: this.modelRoutes(), active: this.modelRouter.active } },
        };
      }
      case 'help':
        return { text: 'Enter 发送 · Shift+Enter 换行 · / 命令面板 · Esc 撤回排队消息 · /exit 断开附着 · /sleep 进 DORMANT' };
      default:
        return { text: `unknown command: /${name}` };
    }
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
      if (this.machine.state !== 'DORMANT') await this.machine.dispatch('shutdown', { reason: 'process_stop' });
    } finally {
      for (const adapter of this.adapters) await adapter.emitSessionShutdown();
      this.adapters.length = 0;
      this.http?.stop();
      await this.host.stop();
      this.kernel.close();
      this.lock.release(process.pid);
      this.trace.append('shell_stopped', { state: this.machine.state });
    }
  }
}


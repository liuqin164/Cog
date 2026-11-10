/**
 * Assembly: the three core pieces (state machine, plugin host, kernel connection) wired to the
 * plugins that carry every capability.
 *
 * The app is also the only place that knows the transition triggers' meanings — a message wakes the
 * shell, a due intent re-injects the clock, the cage's overrun leaves RUNNING. Plugins decide
 * behaviour; the app decides which transition that behaviour is.
 */
import { randomUUID } from 'node:crypto';
import { createMemoryKernel, KernelAgentMemoryBackend, type MemoryKernel } from 'cogmem';
import { defaultShellConfig, type ShellConfig } from './config.ts';
import { StateMachine } from './state/machine.ts';
import { CheckpointStore, type InFlightToolCall } from './state/checkpoint.ts';
import { ProcessLock } from './process-lock.ts';
import { TraceLog } from './trace.ts';
import { PluginHost } from './plugins/host.ts';
import { clockPlugin, ClockService } from './plugins/clock.ts';
import { mgProviderPlugin, providedModelPlugin } from './plugins/mg-provider.ts';
import { cagePlugin, RunCage } from './plugins/cage.ts';
import { builtinToolsPlugin } from './plugins/builtin-tools.ts';
import { capturePlugin } from './plugins/capture.ts';
import { recallPlugin } from './plugins/recall.ts';
import { dreamPlugin } from './plugins/dream.ts';
import { emergencePlugin } from './plugins/emergence.ts';
import { terminalPlugin, TerminalChannel, type ShellControl } from './channels/terminal.ts';
import { AgentRuntime, type ModelProvider, type RunSummary } from './state/agent-loop.ts';
import { startKernelMcpFace, type McpFaceHandle } from './kernel-host.ts';

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

export class CompanionShell implements ShellControl {
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
  private emergence?: { decide(query: string | undefined, now?: number): { candidates: Array<{ id: string; text: string }>; suppressed: unknown[] } };
  private mcp?: McpFaceHandle;
  private terminal?: TerminalChannel;
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
      void this.host.bus.emit('companion_transition', { ...record, state: record.to });
    });
  }

  get state(): string {
    return this.machine.state;
  }

  isRunning(): boolean {
    return this.machine.state === 'RUNNING';
  }

  get runtimeInstance(): AgentRuntime | undefined {
    return this.runtime;
  }

  get mcpUrl(): string | undefined {
    return this.mcp?.url;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const lock = this.lock.acquire(process.pid, this.now());
    if (lock.recoveredStalePid) this.trace.append('stale_lock_recovered', { pid: lock.recoveredStalePid });
    const restored = this.machine.restore();
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
    if (this.config.mcp.enabled) {
      this.mcp = await startKernelMcpFace(this.kernel, this.config.projectId, this.config.mcp);
      this.trace.append('mcp_started', { url: this.mcp.url, port: this.mcp.port });
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
      this.mcp?.stop();
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
    const provider = this.options.modelProvider ? providedModelPlugin(this.options.modelProvider) : mgProviderPlugin();
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

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
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
      this.mcp?.stop();
      await this.host.stop();
      this.kernel.close();
      this.lock.release(process.pid);
      this.trace.append('shell_stopped', { state: this.machine.state });
    }
  }
}


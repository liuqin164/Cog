import type { CompanionShell } from './app.ts';
import { redactUrl } from './model/routes.ts';
import { bwrapUsable } from './plugins/builtin-tools.ts';
import { buildAwayReport } from './presence.ts';
import type { Suspension } from './state/checkpoint.ts';
import { laneAssemblyView } from './state/session-lanes.ts';
import type { TurnUsage } from './state/agent-loop.ts';
import type { PresenceReport, StatusState, WorkState } from './tui/view.ts';

export class StatusFace {
  constructor(private readonly shell: CompanionShell) {}

  // ---- The attach surface (`AttachShell`): everything the TUI process is allowed to ask for. ----

  /**
   * The work indicator and the context gauge are fed from the same events the transcript is, so the
   * TUI never has to poll state: a turn starts, a tool starts, tokens are charged, a run settles.
   */
  attachWorkListeners(): void {
    this.shell.host.bus.on('agent_start', () => {
      this.emitStatus();
    });
    this.shell.host.bus.on('turn_start', (event: { turnIndex?: number }) => {
      this.shell.runTurns = event.turnIndex ?? this.shell.runTurns;
      this.shell.workLabel = '思考中';
      this.emitWork();
    });
    this.shell.host.bus.on('turn_usage', (event: { tokens?: number; totalTokens?: number; usage?: TurnUsage }) => {
      this.shell.runTokens = event.totalTokens ?? this.shell.runTokens;
      // Charged per turn, not at `agent_end`: a kill mid-run must not refund the day's spend, and the
      // checkpoint is what the next process reads (#233).
      this.chargeCost(event.tokens ?? 0);
      const cache = promptCacheAccount(event.usage);
      if (cache) {
        this.shell.promptCache = cache;
        this.emitStatus();
      }
      this.emitWork();
    });
    this.shell.host.bus.on('tool_execution_start', (event: { toolName?: string }) => {
      this.shell.workLabel = event.toolName ?? '工具';
      this.emitWork();
    });
    this.shell.host.bus.on('tool_execution_end', () => {
      this.shell.workLabel = '思考中';
      this.emitWork();
    });
    this.shell.host.bus.on('turn_end', () => this.emitSteering());
    this.shell.host.bus.on('agent_settled', () => {
      this.shell.workLabel = '思考中';
      this.emitWork();
      this.emitSteering();
      this.emitStatus();
      this.flushDailyBudgetNotice();
    });
  }

  chargeCost(tokens: number): void {
    if (tokens <= 0) return;
    try {
      const today = this.localDay(this.shell.now());
      const previous = this.shell.machine.runtime.costDayDate === today ? this.shell.machine.runtime.costDayTokens ?? 0 : 0;
      const spent = previous + tokens;
      this.shell.machine.updateRuntime({ costDayDate: today, costDayTokens: spent });
      if (previous < this.shell.config.dailyBudget.maxTokensPerDay && spent >= this.shell.config.dailyBudget.maxTokensPerDay) {
        this.shell.trace.append('daily_budget_crossed', { day: today, spent, limit: this.shell.config.dailyBudget.maxTokensPerDay, tokens });
      }
    } catch (error) {
      this.shell.trace.append('cost_charge_failed', { tokens, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The day's spend under the same configured boundary #229's emergence count uses. */
  dailySpent(at = this.shell.now()): number {
    return this.shell.machine.runtime.costDayDate === this.localDay(at) ? this.shell.machine.runtime.costDayTokens ?? 0 : 0;
  }

  dailyBudgetExceeded(at = this.shell.now()): boolean {
    return this.dailySpent(at) >= this.shell.config.dailyBudget.maxTokensPerDay;
  }

  private dailyBudgetLine(at = this.shell.now()): string {
    return `已到今日预算上限（${this.dailySpent(at)} / ${this.shell.config.dailyBudget.maxTokensPerDay} token，本日 ${this.localDay(at)}（${this.shell.config.timeZone}））：自主运行今天不再开始；你的指令照常执行，单次运行仍受笼子上限约束。`;
  }

  /**
   * A user line is presence: the daily stop is stated once per day rather than left to the status
   * bar. The line still runs — the ticket stops autonomy, not the owner.
   */
  announceDailyBudget(trigger: string): void {
    const day = this.localDay(this.shell.now());
    if (this.shell.dailyNotifiedDay === day) return;
    this.shell.dailyNotifiedDay = day;
    this.shell.trace.append('daily_budget_exceeded', {
      trigger,
      day,
      spent: this.dailySpent(),
      limit: this.shell.config.dailyBudget.maxTokensPerDay,
    });
    void this.shell.host.bus.emit('terminal_print', { text: `${this.dailyBudgetLine()}\n` });
  }

  private flushDailyBudgetNotice(): void {
    if (!this.dailyBudgetExceeded()) return;
    this.announceDailyBudget('run_settled');
  }

  emitWork(): void {
    void this.shell.host.bus.emit('companion_work', this.currentWork());
  }

  emitStatus(): void {
    void this.shell.host.bus.emit('companion_status', { status: this.currentStatus() });
  }

  emitSteering(): void {
    void this.shell.host.bus.emit('companion_steering', { queued: this.currentQueued() });
  }

  shouldHoldForAbsence(): boolean {
    return this.shell.config.attach.enabled && (this.shell.attach?.clientCount ?? 0) === 0;
  }

  currentStatus(): StatusState {
    const next = this.shell.clock?.nextPendingIntent();
    const today = this.localDay(this.shell.now());
    return {
      name: this.shell.config.agentId,
      lifecycle: this.shell.machine.state,
      kernelConnected: !this.shell.machine.isHalted,
      nextWakeAt: next?.at,
      nextWakeReason: next?.reason,
      model: this.shell.modelLabel,
      memoryModel: this.memoryModelHealth(),
      workspace: this.shell.config.workspaceRoot,
      showWorkspace: true,
      contextTokens: this.shell.contextTokenEstimate,
      contextSweetSpot: this.shell.targetTokens(),
      contextLanes: this.shell.lastLaneAssembly ? laneAssemblyView(this.shell.lastLaneAssembly) : null,
      contextMetrics: this.shell.lastContextMetrics ?? null,
      promptCache: this.shell.promptCache ?? null,
      costTokens: this.shell.machine.runtime.costDayDate === today ? this.shell.machine.runtime.costDayTokens ?? 0 : 0,
      timeZone: this.shell.config.timeZone,
      quietWindow: this.shell.config.quiet ? { ...this.shell.config.quiet, active: this.shell.clock?.quietWindowOpen() ?? false } : undefined,
      sandbox: this.sandboxState(),
      capturePaused: this.shell.capturePaused,
      ...(this.shell.machine.state === 'SUSPENDED' && this.shell.machine.runtime.suspension ? { suspended: this.suspendedLine(this.shell.machine.runtime.suspension) } : {}),
    };
  }

  memoryModelHealth(): { route: string; model: string; baseUrl: string; state: 'reachable' | 'unreachable' | 'degraded' | 'rule_only'; line: string } {
    const role = this.shell.modelRegistry.getRoleConfig('memory');
    const route = this.shell.modelRouter?.active ?? 'default';
    const ruleOnly = role.provider !== 'openai_compatible';
    const degraded = this.shell.machine.runtime.memoryModel?.state === 'degraded';
    const state = ruleOnly ? 'rule_only' : this.shell.memoryModelFailed ? (degraded ? 'degraded' : 'unreachable') : 'reachable';
    const stateText = state === 'rule_only'
      ? '降级为规则；夜间整合不会用模型'
      : state === 'degraded' ? '今夜模型预算用尽，降级为规则；缺帧记忆已排期回填'
      : state === 'unreachable' ? '不可达，降级为规则；夜间整合不会用模型' : '可达';
    return {
      route,
      model: role.modelName,
      baseUrl: redactUrl(role.baseUrl, [role.apiKey]),
      state,
      line: `记忆模型：${route}/${role.modelName}（${stateText}）`,
    };
  }

  /** `/status` and the status bar say whether bash is isolated; a silent degradation is the bug (#284). */
  sandboxState(): 'on' | 'off' {
    return bwrapUsable() ? 'on' : 'off';
  }

  /**
   * The token budget and the emergence count share this day boundary: the configured project time
   * zone (#285), which is the installer's `COG_TZ`, not a hard-coded Asia/Tokyo.
   */
  localDay(at: number): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.shell.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  }

  /** The one human line the status bar, the snapshot and `/health` all carry for a pause. */
  suspendedLine(suspension: Suspension): { kind: Suspension['kind']; text: string } {
    if (suspension.kind === 'question') {
      return { kind: 'question', text: `已暂停：等你回答「${suspension.question?.text ?? ''}」` };
    }
    return {
      kind: 'budget',
      text: `已暂停：预算到顶，等批准追加 ${suspension.budget?.additionalTokens ?? 0} token / ${suspension.budget?.additionalTurns ?? 0} 回合`,
    };
  }

  currentWork(): WorkState {
    const budget = this.shell.runTier === 'work' ? this.shell.config.workBudget : this.shell.config.budgets;
    return {
      active: this.shell.machine.state === 'RUNNING',
      label: this.shell.workLabel,
      startedAt: this.shell.runStartedAt,
      turns: this.shell.runTurns,
      maxTurns: budget.maxTurnsPerRun,
      tokens: this.shell.runTokens,
      maxTokens: budget.maxTokensPerRun,
    };
  }

  currentQueued(): string[] {
    return [...(this.shell.runtime?.steeringMessages ?? [])];
  }

  /** The TUI's Esc on a queued line: withdraw the newest steer the model has not seen. */
  withdrawSteering(): string | undefined {
    const withdrawn = this.shell.runtime?.withdrawSteering();
    this.emitSteering();
    return withdrawn;
  }

  /**
   * The prompt of the run a kill interrupted, rebuilt from the session log (#210). `undefined` when
   * the last start was not a recovery of a RUNNING run with a prompt on record. What to *do* with it
   * — a new turn, the away report, or nothing — is a product decision this method does not make.
   */
  interruptedRun(): { runId: string; text: string; chars: number } | undefined {
    return this.shell.interrupted;
  }

  /** `/sleep` is the command that puts it into DORMANT; closing the window is only a detach. */
  async sleep(): Promise<void> {
    if (this.shell.machine.state === 'DORMANT') return;
    if (this.shell.machine.state !== 'IDLE') throw new Error(`sleep_requires_idle: state is ${this.shell.machine.state}`);
    await this.shell.machine.dispatch('shutdown', { reason: 'sleep_command' });
    this.shell.trace.append('sleep_command', { state: this.shell.machine.state });
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
      projectId: this.shell.config.projectId,
      runtime: this.shell.machine.runtime,
      trace: this.shell.trace.recover().records,
      kernel: this.shell.kernel,
      now: this.shell.now(),
      ...(this.shell.lastUpgrade ? { upgrade: this.shell.lastUpgrade } : {}),
    });
    // Reported once: "what happened while you were away" is not a recurring banner.
    this.shell.lastUpgrade = undefined;
    const patch: Record<string, unknown> = { lastAttachAt: this.shell.now() };
    if ((this.shell.machine.runtime.awayQueue?.length ?? 0) > 0) patch.awayQueue = [];
    try {
      this.shell.machine.updateRuntime(patch);
    } catch (error) {
      this.shell.trace.append('attach_state_write_failed', { message: error instanceof Error ? error.message : String(error) });
    }
    return report;
  }

  /** Date the absence when the last client leaves, so the next report has a window to read. */
  attachChanged(count: number): void {
    try {
      this.shell.machine.updateRuntime(count > 0 ? { lastAttachAt: this.shell.now() } : { lastDetachAt: this.shell.now() });
    } catch (error) {
      this.shell.trace.append('attach_state_write_failed', { count, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---- The install's first-wake probe (#203), asked over the same control socket. ----

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

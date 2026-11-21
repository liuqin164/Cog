import { join } from 'node:path';
import type { DeliveryCandidateInput, KernelAgentMemoryBackend, SurfacingSource } from 'cogmem';
import type { CompanionShell } from './app.ts';
import { rotateLogFile, SERVICE_LOG_MAX_BYTES } from './log-rotation.ts';
import { formatBytes, memoryPressureAction, readMemoryUsage } from './memory.ts';
import { enqueueAway } from './presence.ts';

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

export class ResidentTick {
  constructor(private readonly shell: CompanionShell) {}

  async tick(at = this.shell.now()): Promise<void> {
    this.rotateServiceLog();
    // An owed upgrade report is not gated on the lifecycle: a promise that came due has to be
    // honoured whatever else is happening.
    this.shell.upgradeAdmin.settleUpgradeReport(at);
    // A paused shell is waiting for its owner, not for the clock: no wake intent, dream window or
    // emergence decision may fire out of SUSPENDED (#228).
    if (this.shell.machine.state === 'RUNNING' || this.shell.machine.state === 'WAKING' || this.shell.machine.state === 'SUSPENDED') return;
    this.reportHealth(at);
    if (this.shell.machine.state === 'DORMANT') {
      await this.maybeSnapshot(at);
      await this.applyDueWakeIntent(at);
      return;
    }
    if (this.shell.machine.state === 'DREAMING') return;
    await this.applyDueWakeIntent(at);
    const quiet = this.shell.clock!.quietWindowOpen(at);
    if (!quiet && this.shell.machine.state === 'IDLE') {
      const queue = [...(this.shell.machine.runtime.awayQueue ?? [])];
      const deferred = queue.findIndex((entry) => entry.deferred === 'quiet');
      if (deferred >= 0) {
        const [entry] = queue.splice(deferred, 1);
        this.shell.machine.updateRuntime({ awayQueue: queue });
        this.consumeEmergence({ id: entry!.id, source: entry!.source, observedAt: entry!.observedAt, sourceRefs: entry!.sourceRefs }, at);
        await this.speakEmergence({
          id: entry!.id,
          text: entry!.text,
          reason: entry!.reason,
          ...(entry!.source === undefined ? {} : { source: entry!.source as SurfacingSource }),
          ...(entry!.sourceRefs === undefined ? {} : { sourceRefs: entry!.sourceRefs }),
        }, at);
        this.shell.trace.append('emergence_quiet_delivered', { projectId: this.shell.config.projectId, id: entry!.id, at });
        return;
      }
    }
    if (this.dreamDue(at)) {
      const empty = this.emptyCatchupTarget(at);
      if (empty) {
        this.shell.trace.append('dream_catchup', { dream_catchup: true, localDate: empty, skippedDays: this.dreamSkippedDays(empty), empty: true });
        this.shell.clock!.markDreamed(at);
      } else {
        await this.runDream(at);
        await this.maybeSnapshot(at);
        return;
      }
    }
    await this.maybeSnapshot(at);
    if (this.shell.machine.state === 'IDLE') {
      this.compileProactiveBooks(at);
      // The candidate query must run before F2's tick: a due wake intention is still pending at
      // the query, while the tick that follows marks it fired. A prospective memory stays listed
      // after its notification, so both first-class lanes are seen once.
      // A test double without `hasDue` is asked every tick, which is the old injected behaviour.
      const due = this.shell.emergence!.hasDue?.(at) ?? true;
      const allowed = due && this.emergenceAllowed(at);
      const decision = allowed ? this.shell.emergence!.decide(at) : undefined;
      if (due) this.runKernelWakeTick(at);
      if (decision) {
        const absent = this.shell.statusFace.shouldHoldForAbsence();
        const userState = quiet ? 'night-dnd' : absent ? 'idle' : 'in-conversation';
        const channel = { reachability: 'online' as const, interruptibility: quiet || absent ? 'low' as const : 'high' as const };
        const routed = new Map<string, ReturnType<KernelAgentMemoryBackend['deliveryRoute']>>();
        if (decision.candidates.length === 1) {
          const only = decision.candidates[0]!;
          routed.set(only.id, this.shell.backend.deliveryRoute({ projectId: this.shell.config.projectId, candidate: this.deliveryInput(only, at), userState, channel, now: at }));
        } else {
          const batch = this.shell.backend.deliveryRouteBatch({
            projectId: this.shell.config.projectId,
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
            if (!(this.shell.machine.runtime.awayQueue ?? []).some((entry) => entry.id === item.id)) {
              this.shell.machine.updateRuntime({
                awayQueue: enqueueAway(this.shell.machine.runtime, {
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
            this.shell.trace.append('emergence_accumulated', {
              projectId: this.shell.config.projectId,
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
        this.shell.trace.append('emergence_skipped', {
          projectId: this.shell.config.projectId,
          at,
          reason: this.shell.statusFace.dailyBudgetExceeded(at) ? 'daily_token_budget' : 'cooldown_or_daily_cap',
        });
      }
    }
  }

  private compileProactiveBooks(at: number): void {
    const projectId = this.shell.config.projectId;
    try {
      const latest = this.latestEventId(projectId);
      if (latest === (this.shell.compiledThroughEventId ?? '')) return;
      this.shell.kernel.commitments.compile({ projectId, now: at });
      this.shell.kernel.intentions.compile({ projectId, now: at });
      for (const intention of this.shell.kernel.intentions.list({ projectId, statuses: ['active'], now: at })) {
        if (intention.dueAt === undefined || intention.wakeIntentionId !== undefined) continue;
        this.shell.kernel.intentions.schedule({ projectId, intentionId: intention.intentionId, now: at });
        this.shell.trace.append('intention_scheduled_for_wake', { intentionId: intention.intentionId, dueAt: intention.dueAt, at });
      }
      const profile = this.shell.kernel.profile.compile({ projectId, now: at });
      this.shell.trace.append('profile_compiled', { projectId, at, written: profile.written, entries: profile.entries });
      this.shell.compiledThroughEventId = this.latestEventId(projectId);
    } catch (error) {
      this.shell.trace.append('proactive_compile_failed', { at, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private latestEventId(projectId: string): string {
    return this.shell.backend.latestEventId(projectId);
  }

  /** F2's clock: fire due intentions and announce due prospective memories. It never speaks. */
  private runKernelWakeTick(at: number): void {
    try {
      const result = this.shell.backend.runWakeTick({ projectId: this.shell.config.projectId, agentId: this.shell.config.agentId, now: at });
      if (result.emitted > 0) {
        this.shell.trace.append('wake_tick', {
          at,
          firedWakeIntentions: result.firedWakeIntentions.map((intention) => intention.intentionId),
          prospectiveDue: result.prospectiveDue.map((entry) => entry.candidateId),
        });
      }
    } catch (error) {
      this.shell.trace.append('wake_tick_failed', { at, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The event, when the candidate names one, is a stabler key than a lane's own id. The observed
   * instant rides along because a snoozed commitment resumes as the same id at a new occurrence.
   */
  private emergenceKey(candidate: { id: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }): string {
    if (candidate.source === 'commitment') {
      const commitmentId = candidate.id.slice('surfacing:commitment:'.length);
      const entry = this.shell.kernel.commitments
        .list({ projectId: this.shell.config.projectId, now: this.shell.now() })
        .find((item) => item.commitmentId === commitmentId);
      if (entry) return `${candidate.id}@${entry.resumeAt ?? entry.dueAt ?? ''}`;
    }
    return `${candidate.sourceRefs?.[0]?.eventId ?? candidate.id}@${candidate.observedAt ?? ''}`;
  }

  private emergenceConsumed(candidate: { id: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }): boolean {
    return (this.shell.machine.runtime.emergence?.consumed ?? []).includes(this.emergenceKey(candidate));
  }

  /** The configured day's count; it survives a restart because it lives in the checkpoint. */
  private emergenceAllowed(at: number): boolean {
    // #233 and #229 share one day boundary and one hard stop: when the day's tokens are gone,
    // autonomy does not start another run, exactly as the emergence count cap does.
    if (this.shell.statusFace.dailyBudgetExceeded(at)) return false;
    const state = this.shell.machine.runtime.emergence;
    if (!state) return true;
    return state.day !== this.shell.statusFace.localDay(at) || state.count < EMERGENCE_DAILY_LIMIT;
  }

  private consumeEmergence(candidate: { id: string; source?: string; observedAt?: number; sourceRefs?: Array<{ eventId?: string }> }, at: number): void {
    const key = this.emergenceKey(candidate);
    const day = this.shell.statusFace.localDay(at);
    const prior = this.shell.machine.runtime.emergence;
    const count = prior?.day === day ? prior.count + 1 : 1;
    const consumed = [...(prior?.consumed ?? []).filter((entry) => entry !== key), key].slice(-MAX_EMERGENCE_CONSUMED);
    this.shell.machine.updateRuntime({ emergence: { day, count, consumed } });
    this.shell.trace.append('emergence_consumed', { projectId: this.shell.config.projectId, id: candidate.id, key, day, count });
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
      const prior = this.shell.surfacedByType.get(candidate.source);
      if (prior && prior.candidateId !== candidate.id) this.writeSurfacingFeedback(prior, 'ignored');
      this.shell.surfacedByType.set(candidate.source, { candidateId: candidate.id, sourceRefs: candidate.sourceRefs });
    }
    void this.shell.host.bus.emit('companion_emergence', { id: candidate.id, reason: candidate.reason, text: candidate.text });
    let ok = false;
    try {
      const summary = await this.shell.runLoop.executeRun(candidate.text, 'emergence_due', `emergence:${candidate.id}`);
      ok = summary.stopReason === 'run_complete';
    } finally {
      this.shell.trace.append('emergence_run', { projectId: this.shell.config.projectId, id: candidate.id, ok });
    }
  }

  writeSurfacingFeedback(prior: { candidateId: string; sourceRefs: Array<{ eventId?: string; sourceId?: string; contentHash?: string }> }, outcome: 'engaged' | 'ignored' | 'stopped'): void {
    try {
      this.shell.backend.recordSurfacingFeedback({
        projectId: this.shell.config.projectId,
        candidateId: prior.candidateId,
        outcome,
        sourceRefs: prior.sourceRefs,
        now: this.shell.now(),
      });
      this.shell.trace.append('surfacing_feedback', { projectId: this.shell.config.projectId, candidateId: prior.candidateId, outcome });
    } catch (error) {
      this.shell.trace.append('surfacing_feedback_failed', { candidateId: prior.candidateId, outcome, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The owner's next line closes F7's loop for the last thing the companion said on its own. */
  acknowledgeSurfacing(): void {
    for (const [source, prior] of [...this.shell.surfacedByType]) {
      this.writeSurfacingFeedback(prior, 'engaged');
      this.shell.surfacedByType.delete(source);
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
      this.shell.kernel.health.check({ now: at });
      if (this.shell.clock!.quietWindowOpen(at)) return;
      this.reportMemoryPressure(at);
      const away = this.shell.statusFace.shouldHoldForAbsence();
      const notice = this.shell.backend.healthNotice({
        projectId: this.shell.config.projectId,
        userState: away ? 'idle' : 'in-conversation',
        channel: { reachability: 'online', interruptibility: away ? 'low' : 'high' },
        now: at,
      });
      if (!notice.due || !notice.decision) return;
      this.shell.trace.append('health_notice', {
        streak: notice.streak,
        decision: notice.decision.decision,
        destination: notice.decision.destination,
        urgency: notice.decision.urgency,
        reasonCode: notice.decision.reasonCode,
        trace: notice.decision.decisionTrace,
      });
      if (notice.decision.decision !== 'deliver') return;
      const text = `我最近 ${notice.streak} 晚的夜间整合都失败了，记忆可能不完整。我不会假装正常——你回来时我们先补这一块。`;
      void this.shell.host.bus.emit('companion_emergence', { id: 'health:dream-streak', reason: 'health_notice', text });
    } catch (error) {
      this.shell.trace.append('health_check_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The process half of the health face (#226). The kernel's frozen four checks stay four; this
   * reads the resident's own RSS against the unit ceiling and routes one notice through the same
   * emergence path the Dream-streak notice uses. The reading itself is also on `GET /health`.
   */
  private reportMemoryPressure(at: number): void {
    const memory = readMemoryUsage();
    const action = memoryPressureAction(memory, this.shell.memoryWarned);
    if (action === 'reset') {
      this.shell.memoryWarned = false;
      return;
    }
    if (action === 'hold') return;
    const ceiling = (memory.highBytes ?? memory.limitBytes)!;
    this.shell.memoryWarned = true;
    const kind = memory.highBytes === undefined ? '硬顶' : '高水位';
    const text = `常驻进程占用 ${formatBytes(memory.rssBytes)}，已到安装时设的 ${formatBytes(ceiling)} ${kind}；再涨会被限流或重启。我先说一声。`;
    this.shell.trace.append('memory_pressure', {
      rssBytes: memory.rssBytes,
      limitBytes: memory.limitBytes,
      highBytes: memory.highBytes,
      source: memory.source,
    }, at);
    void this.shell.host.bus.emit('companion_emergence', { id: 'health:memory-pressure', reason: 'memory_notice', text });
  }

  /** Keep the inherited stdout/stderr file bounded between restarts. */
  rotateServiceLog(): void {
    const path = join(this.shell.config.dataDir, 'service.log');
    try {
      if (!rotateLogFile(path, SERVICE_LOG_MAX_BYTES)) return;
      this.shell.trace.append('service_log_rotated', { path, maxBytes: SERVICE_LOG_MAX_BYTES, rotated: `${path}.1` });
    } catch (error) {
      this.shell.trace.append('service_log_rotate_failed', { path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** WAKING means the block is written into runtime state, not just into the trace. */
  injectTimeContext(reason: string, at = this.shell.now()): void {
    let kernelLine: string[] = [];
    try {
      const context = this.shell.backend.temporalContext({ projectId: this.shell.config.projectId, now: at });
      kernelLine = [`activity: ${context.rhythm.phase}; density: ${context.density.label}`];
    } catch (error) {
      this.shell.trace.append('temporal_context_failed', { message: error instanceof Error ? error.message : String(error) });
    }
    const block = this.shell.clock!.timeContextBlock(at, kernelLine);
    this.shell.trace.append('time_context_injected', { block, reason });
  }

  /** One due intent is one WAKING->IDLE pass; both the dormant and the standby path use it. */
  private async applyDueWakeIntent(at: number): Promise<void> {
    const due = this.shell.clock!.dueWakeIntent(at);
    if (!due) return;
    this.shell.clock!.consumeWakeIntent(due.id);
    await this.shell.machine.dispatch('wake_intent_due', { reason: due.reason });
    this.injectTimeContext(`wake_intent:${due.id}`, at);
    await this.shell.machine.dispatch('context_injected', { reason: 'wake_intent' });
  }

  private async maybeSnapshot(at: number): Promise<void> {
    const last = this.shell.machine.runtime.lastSnapshotAt;
    if (last !== undefined && at - last < SNAPSHOT_INTERVAL_MS) return;
    this.shell.machine.updateRuntime({ lastSnapshotAt: at });
    try {
      const manifest = await this.shell.kernel.backup.snapshot();
      if (manifest) {
        this.shell.trace.append('snapshot_taken', {
          file: manifest.snapshot.file,
          createdAt: manifest.createdAt,
          verification: manifest.verification.ok,
        });
      }
    } catch (error) {
      this.shell.trace.append('snapshot_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private dreamDue(at: number): boolean {
    const clock = this.shell.clock!;
    if (clock.dreamedNight(at)) return false;
    const retry = this.shell.machine.runtime.dreamRetry;
    return !retry
      || retry.night !== clock.dreamNightDate(at)
      || (!retry.gaveUp && retry.nextAt <= at);
  }

  private emptyCatchupTarget(at: number): string | undefined {
    if (this.shell.clock!.dreamWindowOpen(at)) return undefined;
    const localDate = this.shell.clock!.dreamTargetDate(at);
    const events = this.shell.kernel.getThreadEvents(`companion-day:${localDate}`, {
      projectId: this.shell.config.projectId,
      limit: 1,
    });
    return events.length === 0 ? localDate : undefined;
  }

  private dreamSkippedDays(localDate: string): number {
    const last = this.shell.machine.runtime.lastDreamDate;
    return last ? Math.max(0, this.shell.clock!.daysBetween(last, localDate) - 1) : 0;
  }

  private scheduleDreamRetry(night: string, at: number): { attempts: number; nextAt?: number; gaveUp: boolean } {
    const prior = this.shell.machine.runtime.dreamRetry;
    const attempts = prior?.night === night ? prior.attempts + 1 : 1;
    if (attempts >= DREAM_MAX_ATTEMPTS_PER_NIGHT) {
      this.shell.machine.updateRuntime({ dreamRetry: { night, attempts, nextAt: at, gaveUp: true } });
      this.shell.trace.append('dream_retry_scheduled', { night, attempts, gaveUp: true, clockAt: at });
      return { attempts, gaveUp: true };
    }
    const nextAt = at + Math.min(DREAM_RETRY_BASE_MS * 2 ** (attempts - 1), DREAM_RETRY_CAP_MS);
    this.shell.machine.updateRuntime({ dreamRetry: { night, attempts, nextAt } });
    this.shell.trace.append('dream_retry_scheduled', { night, attempts, nextAt, delayMs: nextAt - at, gaveUp: false, clockAt: at });
    return { attempts, nextAt, gaveUp: false };
  }

  async runDream(at = this.shell.now()): Promise<void> {
    const localDate = this.shell.clock!.dreamTargetDate(at);
    const night = this.shell.clock!.dreamNightDate(at);
    const catchup = !this.shell.clock!.dreamWindowOpen(at);
    const skippedDays = this.dreamSkippedDays(localDate);
    if (catchup) this.shell.trace.append('dream_catchup', { dream_catchup: true, localDate, skippedDays });
    await this.shell.machine.dispatch('dream_window_open', { reason: 'dream_window' });
    try {
      const result = await this.shell.dream!.integrate(localDate, `companion-day:${localDate}`, at);
      if (result.memoryModelDegraded === 'semantic_processor_failed') this.shell.memoryModelFailed = true;
      else if (result.memoryModelUsed) this.shell.memoryModelFailed = false;
      this.shell.clock!.markDreamed(at);
      try {
        const promotion = this.shell.kernel.promoteDreamCandidates({ projectId: this.shell.config.projectId, limit: 100 });
        this.shell.trace.append('dream_promotion', { promoted: promotion.promotedCandidates, decisions: promotion.decisions.length });
      } catch (error) {
        this.shell.trace.append('dream_promotion_failed', { message: error instanceof Error ? error.message : String(error) });
      }
      this.shell.machine.updateRuntime({
        dreamRetry: undefined,
        ...(result.kernelNightRan ? { lastSnapshotAt: at } : {}),
      });
      this.shell.clock!.setWakeIntent(at + 8 * 60 * 60_000, 'morning_after_dream');
      this.shell.trace.append('dream_complete', {
        localDate,
        eventCount: result.eventCount,
        sourceRefs: result.sourceRefs.length,
        dream_catchup: catchup,
        skippedDays,
      });
      void this.shell.host.bus.emit('companion_dream', { product: { localDate, eventCount: result.eventCount, summary: result.summary } });
      // A message that arrived while the integration was awaiting wakes the shell out of DREAMING.
      // The product is already written; the transition belongs to whoever moved the state, not to us.
      if (this.shell.machine.state !== 'DREAMING') {
        this.shell.trace.append('dream_finished_after_wake', { localDate, state: this.shell.machine.state });
        return;
      }
      await this.shell.machine.dispatch('dream_complete', { reason: `dream:${localDate}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retry = this.scheduleDreamRetry(night, at);
      this.shell.trace.append('dream_failed', {
        localDate,
        message,
        clockAt: at,
        attempt: retry.attempts,
        nextAt: retry.nextAt ?? null,
        gaveUp: retry.gaveUp,
      });
      await this.shell.machine.dispatch('run_error', { reason: `dream_failed:${message}` });
    }
  }


}

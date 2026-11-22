import { join } from 'node:path';
import { SURFACING_FEEDBACK_RULES, type DeliveryCandidateInput, type KernelAgentMemoryBackend, type SurfacingFeedbackOutcome, type SurfacingSource } from 'cogmem';
import type { CompanionShell } from './app.ts';
import { rotateLogFile, SERVICE_LOG_MAX_BYTES } from './log-rotation.ts';
import { formatBytes, memoryPressureAction, readMemoryUsage } from './memory.ts';
import { enqueueAway } from './presence.ts';

const DREAM_RETRY_BASE_MS = 5 * 60_000;
const DREAM_RETRY_CAP_MS = 30 * 60_000;
const DREAM_MAX_ATTEMPTS_PER_NIGHT = 5;
const DREAM_NIGHT_IDLE_MS = 5 * 60_000;
const DREAM_DAY_IDLE_MS = 60 * 60_000;
const DREAM_NIGHT_BACKLOG = 1;
const DREAM_DAY_BACKLOG = 2;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60_000;
const SNAPSHOT_RETRY_BASE_MS = 5 * 60_000;
const SNAPSHOT_RETRY_CAP_MS = 30 * 60_000;

const EMERGENCE_DAILY_LIMIT = 8;
const MAX_EMERGENCE_CONSUMED = 500;

const SURFACING_REPLY_STOP_UNITS = new Set([
  '今天', '明天', '现在', '时候', '可以', '一下', '这个', '那个', '我们', '你们', '他们',
  '什么', '怎么', '记得', '提醒', '告诉', '已经', '还是', '就是', '因为', '所以', '但是', '然后',
]);

function surfacingReplyUnits(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const units = new Set<string>(normalized.match(/[a-z0-9]{3,}/gu) ?? []);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) units.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      const unit = run.slice(index, index + 2);
      if (!SURFACING_REPLY_STOP_UNITS.has(unit)) units.add(unit);
    }
  }
  return units;
}

function targetsSurfacing(reply: string, content: string): boolean {
  const replyUnits = surfacingReplyUnits(reply);
  for (const unit of surfacingReplyUnits(content)) {
    if (replyUnits.has(unit)) return true;
  }
  return false;
}

interface DreamTriggerDecision {
  start: boolean;
  reason: 'already_dreamed' | 'gave_up' | 'retry_wait' | 'idle_short' | 'backlog_low' | 'idle_and_backlog';
  night: boolean;
  idleMs: number | null;
  idleMinMs: number;
  backlogMin: number;
  backlogEvents: number;
  backlogEpisodes: number;
}

interface FreshnessReadings {
  measuredAt: number;
  unembeddedEvents: number;
  oldestUnembeddedAgeMs: number;
  unboundEvents: number;
}

export class ResidentTick {
  freshness?: FreshnessReadings;
  private backfillInFlight = false;
  private inPlaceDream = false;
  private lastFreshnessPassAt?: number;
  private embeddingRowCursor = 0;
  private bindingSeqCursor?: number;

  constructor(private readonly shell: CompanionShell) {}

  async tick(at = this.shell.now()): Promise<void> {
    this.rotateServiceLog();
    this.sweepSurfacing(at);
    this.shell.upgradeAdmin.settleUpgradeReport(at);
    if (this.shell.machine.state === 'RUNNING' || this.shell.machine.state === 'WAKING') return;
    this.reportHealth(at);
    if (this.shell.machine.state === 'DORMANT') {
      await this.maybeSnapshot(at);
      await this.applyDueWakeIntent(at);
      return;
    }
    if (this.shell.machine.state === 'SUSPENDED') {
      if (this.inPlaceDream) return;
      await this.backfillFreshness(at);
      this.deferDueWakeIntent(at);
      const dream = this.dreamDecision(at);
      this.traceDreamDecision(dream, at);
      if (dream.start) {
        this.inPlaceDream = true;
        try {
          await this.runDream(at);
          await this.maybeSnapshot(at);
        } finally {
          this.inPlaceDream = false;
        }
        return;
      }
      await this.maybeSnapshot(at);
      return;
    }
    if (this.shell.machine.state === 'DREAMING') return;
    await this.backfillFreshness(at);
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
        }, at, 'incidental', this.shell.currentChannelId());
        this.shell.trace.append('emergence_quiet_delivered', { projectId: this.shell.config.projectId, id: entry!.id, at });
        return;
      }
    }
    const dream = this.dreamDecision(at);
    this.traceDreamDecision(dream, at);
    if (dream.start) {
      await this.runDream(at);
      await this.maybeSnapshot(at);
      return;
    }
    await this.maybeSnapshot(at);
    if (this.shell.machine.state === 'IDLE') {
      this.compileProactiveBooks(at);
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
            this.consumeEmergence(item, at);
            await this.speakEmergence(item, at, delivery.strength === 'incidental' ? 'incidental' : 'proactive', this.shell.currentChannelId());
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

  private traceDreamDecision(dream: DreamTriggerDecision, at: number): void {
    this.shell.trace.append('dream_trigger', {
      projectId: this.shell.config.projectId,
      decision: dream.start ? 'start' : 'skip',
      reason: dream.reason,
      night: dream.night,
      idleMs: dream.idleMs,
      idleMinMs: dream.idleMinMs,
      backlogMin: dream.backlogMin,
      backlogEvents: dream.backlogEvents,
      backlogEpisodes: dream.backlogEpisodes,
    }, at);
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

  private async backfillFreshness(at: number): Promise<void> {
    if (this.backfillInFlight) return;
    if (this.lastFreshnessPassAt !== undefined && at - this.lastFreshnessPassAt < this.shell.config.freshness.intervalMs) return;
    this.lastFreshnessPassAt = at;
    this.backfillInFlight = true;
    const projectId = this.shell.config.projectId;
    try {
      const config = this.shell.config.freshness;
      const embeddings = await this.shell.kernel.backfillEventEmbeddingBatch({
        projectId,
        limit: config.embeddingBatch,
        afterRowId: this.embeddingRowCursor,
      });
      this.embeddingRowCursor = embeddings.hasMore ? embeddings.nextRowId : 0;
      const state = this.shell.machine.state;
      if (state === 'RUNNING' || state === 'WAKING') return;
      const binding = this.shell.kernel.bindRawEvents({
        projectId,
        sinceGlobalSeq: this.bindingSeqCursor,
        limit: config.bindingBatch,
      });
      this.bindingSeqCursor = binding.hasMore ? binding.nextGlobalSeq : undefined;
      const backlog = this.shell.kernel.getEmbeddingBacklog(projectId);
      this.freshness = {
        measuredAt: at,
        unembeddedEvents: backlog.count,
        oldestUnembeddedAgeMs: backlog.oldestAt === undefined ? 0 : Math.max(0, at - backlog.oldestAt),
        unboundEvents: this.shell.kernel.countUnboundBindableRawEvents(projectId),
      };
      this.shell.trace.append('freshness_backfill', {
        projectId,
        at,
        embedded: embeddings.completed,
        embeddingFailures: embeddings.failed,
        bound: binding.boundEvents,
        bindable: binding.bindableEvents,
        ...this.freshness,
      }, at);
    } catch (error) {
      this.shell.trace.append('freshness_backfill_failed', { at, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.backfillInFlight = false;
    }
  }

  private latestEventId(projectId: string): string {
    return this.shell.backend.latestEventId(projectId);
  }

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

  private emergenceAllowed(at: number): boolean {
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

  private async speakEmergence(candidate: { id: string; text: string; reason: string; source?: SurfacingSource; sourceRefs?: Array<{ eventId?: string; sourceId?: string; contentHash?: string }> }, at: number, strength: 'proactive' | 'incidental', channelId: string): Promise<void> {
    try {
      this.shell.backend.deliverSurfacing({
        projectId: this.shell.config.projectId,
        candidateId: candidate.id,
        content: candidate.text,
        ...(candidate.sourceRefs === undefined ? {} : { sourceRefs: candidate.sourceRefs }),
        now: this.shell.now(),
      });
    } catch (error) {
      this.shell.trace.append('surfacing_delivery_failed', { candidateId: candidate.id, message: error instanceof Error ? error.message : String(error) });
    }
    void this.shell.host.bus.emit('companion_emergence', { id: candidate.id, reason: candidate.reason, text: candidate.text, strength, channelId });
    let ok = false;
    try {
      const summary = await this.shell.runLoop.executeRun(candidate.text, 'emergence_due', `emergence:${candidate.id}`);
      ok = summary.stopReason === 'run_complete';
    } finally {
      this.shell.trace.append('emergence_run', { projectId: this.shell.config.projectId, id: candidate.id, ok });
    }
  }

  writeSurfacingFeedback(prior: { candidateId: string; sourceRefs: Array<{ eventId?: string; sourceId?: string; contentHash?: string }> }, outcome: SurfacingFeedbackOutcome): void {
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

  observeSurfacingReply(text: string): void {
    const projectId = this.shell.config.projectId;
    for (const entry of this.shell.backend.surfacingPending({ projectId })) {
      if (targetsSurfacing(text, entry.content)) this.writeSurfacingFeedback(entry, 'engaged');
    }
    this.sweepSurfacing(this.shell.now());
  }

  sweepSurfacing(at = this.shell.now()): void {
    const lastActiveAt = this.shell.machine.runtime.lastInteractionAt;
    if (lastActiveAt === undefined) return;
    const projectId = this.shell.config.projectId;
    for (const entry of this.shell.backend.surfacingPending({ projectId })) {
      if (lastActiveAt < entry.deliveredAt || at - entry.deliveredAt < SURFACING_FEEDBACK_RULES.ignoreAfterMs) continue;
      this.shell.trace.append('surfacing_ignored', {
        projectId,
        candidateId: entry.candidateId,
        deliveredAt: entry.deliveredAt,
        lastActiveAt,
        at,
      });
      this.writeSurfacingFeedback(entry, 'ignored');
    }
  }

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
      void this.shell.host.bus.emit('companion_emergence', { id: 'health:dream-streak', reason: 'health_notice', text, strength: 'proactive', channelId: this.shell.currentChannelId() });
    } catch (error) {
      this.shell.trace.append('health_check_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

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
    void this.shell.host.bus.emit('companion_emergence', { id: 'health:memory-pressure', reason: 'memory_notice', text, strength: 'proactive', channelId: this.shell.currentChannelId() });
  }

  rotateServiceLog(): void {
    const path = join(this.shell.config.dataDir, 'service.log');
    try {
      if (!rotateLogFile(path, SERVICE_LOG_MAX_BYTES)) return;
      this.shell.trace.append('service_log_rotated', { path, maxBytes: SERVICE_LOG_MAX_BYTES, rotated: `${path}.1` });
    } catch (error) {
      this.shell.trace.append('service_log_rotate_failed', { path, message: error instanceof Error ? error.message : String(error) });
    }
  }

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

  private async applyDueWakeIntent(at: number): Promise<void> {
    const due = this.shell.clock!.dueWakeIntent(at);
    if (!due) return;
    this.shell.clock!.consumeWakeIntent(due.id);
    await this.shell.machine.dispatch('wake_intent_due', { reason: due.reason });
    this.injectTimeContext(`wake_intent:${due.id}`, at);
    await this.shell.machine.dispatch('context_injected', { reason: 'wake_intent' });
  }

  private deferDueWakeIntent(at: number): void {
    const due = this.shell.clock!.dueWakeIntent(at);
    if (!due) return;
    this.shell.clock!.consumeWakeIntent(due.id);
    this.shell.machine.updateRuntime({
      awayQueue: enqueueAway(this.shell.machine.runtime, {
        id: `wake:${due.id}`,
        text: due.reason,
        reason: `wake_intent:${due.reason}`,
        at,
        deferred: 'absence',
      }),
    });
    this.shell.trace.append('wake_intent_deferred', { id: due.id, reason: due.reason, at });
  }

  private async maybeSnapshot(at: number): Promise<void> {
    const last = this.shell.machine.runtime.lastSnapshotAt;
    if (last !== undefined && at - last < SNAPSHOT_INTERVAL_MS) return;
    const retry = this.shell.machine.runtime.snapshotRetry;
    if (retry && at < retry.nextAt) return;
    try {
      const manifest = await this.shell.kernel.backup.snapshot();
      if (!manifest) {
        this.shell.machine.updateRuntime({ lastSnapshotAt: at });
        return;
      }
      if (!manifest.verification.ok) throw new Error(manifest.verification.detail ?? 'snapshot verification failed');
      this.shell.machine.updateRuntime({ lastSnapshotAt: at, snapshotRetry: undefined });
      this.shell.trace.append('snapshot_taken', {
        file: manifest.snapshot.file,
        createdAt: manifest.createdAt,
        verification: manifest.verification.ok,
      });
    } catch (error) {
      const attempts = (retry?.attempts ?? 0) + 1;
      const nextAt = at + Math.min(SNAPSHOT_RETRY_BASE_MS * 2 ** (attempts - 1), SNAPSHOT_RETRY_CAP_MS);
      this.shell.machine.updateRuntime({ lastSnapshotFailureAt: at, snapshotRetry: { attempts, nextAt } });
      this.shell.trace.append('snapshot_failed', {
        message: error instanceof Error ? error.message : String(error),
        attempts,
        nextAt,
      });
    }
  }

  private dreamDecision(at: number): DreamTriggerDecision {
    const clock = this.shell.clock!;
    const night = clock.dreamWindowOpen(at);
    const backlog = this.dreamBacklog(at);
    const lastInteractionAt = this.shell.machine.runtime.lastInteractionAt;
    const idleMs = lastInteractionAt === undefined ? null : Math.max(0, at - lastInteractionAt);
    const idleMinMs = night ? DREAM_NIGHT_IDLE_MS : DREAM_DAY_IDLE_MS;
    const backlogMin = night ? DREAM_NIGHT_BACKLOG : DREAM_DAY_BACKLOG;
    const metrics = {
      night,
      idleMs,
      idleMinMs,
      backlogMin,
      backlogEvents: backlog.events,
      backlogEpisodes: backlog.episodes,
    };
    if (clock.dreamedNight(at)) return { ...metrics, start: false, reason: 'already_dreamed' };
    const retry = this.shell.machine.runtime.dreamRetry;
    if (retry && retry.night === clock.dreamNightDate(at) && (retry.gaveUp || retry.nextAt > at)) {
      return { ...metrics, start: false, reason: retry.gaveUp ? 'gave_up' : 'retry_wait' };
    }
    if (idleMs !== null && idleMs < idleMinMs) return { ...metrics, start: false, reason: 'idle_short' };
    if (backlog.events + backlog.episodes < backlogMin) return { ...metrics, start: false, reason: 'backlog_low' };
    return { ...metrics, start: true, reason: 'idle_and_backlog' };
  }

  private dreamBacklog(at: number): { events: number; episodes: number } {
    const date = this.shell.clock!.dreamTargetDate(at);
    const projectId = this.shell.config.projectId;
    const covered = new Set<string>();
    for (const product of this.shell.kernel.getThreadEvents(`companion-dream:${date}`, { projectId, limit: 50 })) {
      const ids = (product.payload as { metadata?: { sourceEventIds?: unknown } } | undefined)?.metadata?.sourceEventIds;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') covered.add(id);
    }
    const events = this.shell.kernel
      .getThreadEvents(`companion-day:${date}`, { projectId, limit: 5_000 })
      .filter((event) => !covered.has(event.eventId)).length;
    const status = this.shell.kernel.getEpisodeDreamStatus(projectId);
    return { events, episodes: status.pending + status.retryScheduled + status.failedRetryable };
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
    const suspended = this.shell.machine.state === 'SUSPENDED';
    const localDate = this.shell.clock!.dreamTargetDate(at);
    const night = this.shell.clock!.dreamNightDate(at);
    const catchup = !this.shell.clock!.dreamWindowOpen(at);
    const skippedDays = this.dreamSkippedDays(localDate);
    if (catchup) this.shell.trace.append('dream_catchup', { dream_catchup: true, localDate, skippedDays });
    if (!suspended) await this.shell.machine.dispatch('dream_window_open', { reason: 'dream_window' });
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
      if (this.shell.machine.state !== 'DREAMING') {
        this.shell.trace.append('dream_failed_after_wake', { localDate, state: this.shell.machine.state });
        return;
      }
      await this.shell.machine.dispatch('dream_failed', { reason: `dream_failed:${message}` });
    }
  }


}

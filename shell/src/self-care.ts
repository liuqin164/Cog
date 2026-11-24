import { statfsSync } from 'node:fs';
import type { CompanionShell } from './app.ts';
import { embeddingRuntimePresent } from './embedding/model.ts';
import { formatBytes } from './memory.ts';
import { enqueueAway } from './presence.ts';
import type { ShellRuntimeState } from './state/checkpoint.ts';

const DAY_MS = 24 * 60 * 60_000;
const REPEAT_MS = 7 * DAY_MS;
const SNAPSHOT_STALE_MS = 2 * DAY_MS;
const UNEMBEDDED_STALE_MS = DAY_MS;
const DISK_MIN_BYTES = 2 * 1024 * 1024 * 1024;
const SELF_CARE_ID = 'self_care';

type SelfCareMemory = NonNullable<ShellRuntimeState['selfCare']>;

interface CareCondition {
  key: string;
  text: string;
  severity: number;
}

export interface SelfCareStatus {
  active: boolean;
  line: string;
}

function compactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const value = tokens / 1000;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}k`;
}

export class SelfCare {
  constructor(private readonly shell: CompanionShell) {}

  tick(at = this.shell.now()): void {
    try {
      if (this.ruleOnly()) return;
      if ((this.shell.machine.runtime.awayQueue ?? []).some((entry) => entry.id === SELF_CARE_ID)) return;
      const backlog = this.backlog(at);
      this.syncPending();
      this.sampleBacklog(at, backlog.dreamBacklog);
      const conditions = this.conditions(at, backlog);
      if (conditions.length === 0) return;
      const memory = this.memory();
      const day = this.shell.statusFace.localDay(at);
      if (memory.day === day) return;
      const allowed = conditions.filter((condition) => this.allowed(condition, memory, at));
      if (allowed.length === 0) return;
      const text = `${allowed.map((condition) => condition.text).join('；')}。`;
      const quiet = this.shell.clock?.quietWindowOpen(at) ?? false;
      const absent = this.shell.statusFace.shouldHoldForAbsence();
      if (quiet || absent) {
        this.mark(allowed, day, at);
        this.shell.machine.updateRuntime({
          awayQueue: enqueueAway(this.shell.machine.runtime, {
            id: SELF_CARE_ID,
            text,
            reason: SELF_CARE_ID,
            source: SELF_CARE_ID,
            at,
            deferred: quiet ? 'quiet' : 'absence',
          }),
        });
        this.shell.trace.append('self_care_queued', {
          projectId: this.shell.config.projectId,
          id: SELF_CARE_ID,
          text,
          conditions: allowed.map((condition) => condition.key),
          day,
          deferred: quiet ? 'quiet' : 'absence',
        }, at);
        return;
      }
      this.mark(allowed, day, at);
      this.speak(text, at, 'proactive', allowed.map((condition) => condition.key));
    } catch (error) {
      this.shell.trace.append('self_care_failed', { message: error instanceof Error ? error.message : String(error) }, at);
    }
  }

  speak(text: string, at = this.shell.now(), strength: 'proactive' | 'incidental' = 'proactive', keys?: string[]): void {
    const memory = this.memory();
    const day = this.shell.statusFace.localDay(at);
    if (memory.day !== day) this.update({ ...memory, day });
    this.shell.trace.append('self_care_spoken', {
      projectId: this.shell.config.projectId,
      id: SELF_CARE_ID,
      text,
      strength,
      ...(keys ? { conditions: keys } : {}),
    }, at);
    void this.shell.host.bus.emit('companion_emergence', {
      id: SELF_CARE_ID,
      reason: SELF_CARE_ID,
      text,
      strength,
      channelId: this.shell.currentChannelId(),
    });
  }

  status(at = this.shell.now()): SelfCareStatus {
    try {
      const conditions = this.conditions(at, this.backlog(at));
      if (conditions.length === 0) return { active: false, line: '自我照料：无' };
      return { active: true, line: `自我照料：${conditions.map((condition) => condition.text).join('；')}。` };
    } catch {
      return { active: false, line: '自我照料：无' };
    }
  }

  private ruleOnly(): boolean {
    return this.shell.statusFace.memoryModelHealth().state === 'rule_only';
  }

  private memory(): SelfCareMemory {
    return this.shell.machine.runtime.selfCare ?? {};
  }

  private update(memory: SelfCareMemory): void {
    this.shell.machine.updateRuntime({ selfCare: memory });
  }

  private pendingEpisodes(): number {
    const status = this.shell.kernel.getEpisodeDreamStatus(this.shell.config.projectId);
    return status.pending + status.retryScheduled + status.failedRetryable;
  }

  private syncPending(): void {
    if (this.shell.machine.runtime.memoryModel?.pendingBackfill !== true) return;
    const episodes = this.pendingEpisodes();
    const memory = this.memory();
    if (episodes <= (memory.pendingEpisodes ?? 0)) return;
    this.update({ ...memory, pendingEpisodes: episodes });
  }

  private backlog(at: number) {
    return this.shell.kernel.getBacklogReadings(this.shell.config.projectId, at);
  }

  private sampleBacklog(at: number, count: number): void {
    const day = this.shell.statusFace.localDay(at);
    const memory = this.memory();
    const samples = memory.backlogSamples ?? [];
    if (samples.at(-1)?.day === day) return;
    this.update({ ...memory, backlogSamples: [...samples, { day, count }].slice(-3) });
  }

  private conditions(at: number, backlog: ReturnType<SelfCare['backlog']>): CareCondition[] {
    const items: CareCondition[] = [];
    const runtime = this.shell.machine.runtime;
    const memory = this.memory();
    const model = runtime.memoryModel;
    const episodes = Math.max(this.pendingEpisodes(), memory.pendingEpisodes ?? 0);
    if (model?.pendingBackfill === true && model.state !== 'reachable') {
      const budget = model.reason === 'semantic_processor_budget';
      const reason = budget ? `昨晚整理额度用完了（${this.budget() ?? '额度'}）` : '昨晚记忆模型没连上（网络）';
      items.push({
        key: budget ? 'memory_budget' : 'memory_degraded',
        text: `${reason}，只做了规则整理，${episodes} 段对话等恢复后补上`,
        severity: episodes,
      });
    }
    if (model?.pendingBackfill !== true && (memory.pendingEpisodes ?? 0) > 0) {
      items.push({ key: 'memory_recovered', text: `已补完 ${memory.pendingEpisodes} 段`, severity: 0 });
    }
    const expiring = backlog.candidateQueue.needsConfirmationExpiring72h;
    if (expiring > 0) {
      items.push({
        key: 'needs_confirmation',
        text: `有 ${expiring} 条待确认记忆 72 小时内过期，去星海分类审计 ${this.auditLink()}`,
        severity: expiring,
      });
    }
    const samples = memory.backlogSamples ?? [];
    if (samples.length >= 3) {
      const [first, second, third] = samples.slice(-3);
      if (second!.count >= first!.count && third!.count >= second!.count && third!.count > 0) {
        items.push({
          key: 'backlog_flat',
          text: `待编译量连续 2 晚没降（${third!.count} 段）`,
          severity: third!.count,
        });
      }
    }
    const retry = runtime.snapshotRetry;
    if (retry && retry.attempts >= 2) {
      items.push({ key: 'snapshot', text: `快照连续失败 ${retry.attempts} 次`, severity: retry.attempts });
    } else if (runtime.lastSnapshotAt !== undefined && at - runtime.lastSnapshotAt > SNAPSHOT_STALE_MS) {
      const hours = Math.floor((at - runtime.lastSnapshotAt) / (60 * 60_000));
      items.push({ key: 'snapshot', text: `距上次快照成功已 ${hours} 小时`, severity: hours });
    }
    const embedding = this.shell.kernel.getEmbeddingBacklog(this.shell.config.projectId);
    if (embedding.oldestAt !== undefined && at - embedding.oldestAt > UNEMBEDDED_STALE_MS) {
      const hours = Math.floor((at - embedding.oldestAt) / (60 * 60_000));
      items.push({ key: 'unembedded', text: `最老未嵌入事件已积压 ${hours} 小时`, severity: hours });
    }
    if (this.shell.config.embedding.provider === 'local' && !embeddingRuntimePresent()) {
      items.push({ key: 'embedding_runtime', text: '本地向量运行时缺失，回忆先走词法；重跑安装即可恢复', severity: 1 });
    }
    const free = this.diskFree();
    if (free !== undefined && free < DISK_MIN_BYTES) {
      items.push({
        key: 'disk',
        text: `数据盘只剩 ${formatBytes(free)} 可用`,
        severity: DISK_MIN_BYTES - free,
      });
    }
    return items;
  }

  private allowed(condition: CareCondition, memory: SelfCareMemory, at: number): boolean {
    const prior = memory.conditions?.[condition.key];
    if (!prior) return true;
    return at - prior.at >= REPEAT_MS || condition.severity > prior.severity;
  }

  private mark(allowed: CareCondition[], day: string, at: number): void {
    const memory = this.memory();
    const conditions = { ...(memory.conditions ?? {}) };
    let pendingEpisodes = memory.pendingEpisodes;
    for (const condition of allowed) {
      conditions[condition.key] = { at, severity: condition.severity };
      if (condition.key === 'memory_recovered') pendingEpisodes = undefined;
    }
    this.update({
      ...memory,
      day,
      conditions,
      ...(pendingEpisodes === undefined ? { pendingEpisodes: undefined } : { pendingEpisodes }),
    });
  }

  private auditLink(): string {
    const base = this.shell.httpUrl ?? `http://127.0.0.1:${this.shell.config.http.port}`;
    return `${base}/observatory/#classification`;
  }

  private budget(): string | undefined {
    const live = this.shell.nightModelBudget;
    if (live.cap > 0) return `${compactTokens(live.spent)}/${compactTokens(live.cap)}`;
    const record = [...this.shell.trace.read()].reverse().find((entry) => {
      const row = entry as { kind?: string; spent?: unknown; cap?: unknown };
      return (row.kind === 'dream_model_spent' || row.kind === 'dream_model_budget_exceeded')
        && typeof row.spent === 'number' && typeof row.cap === 'number' && row.cap > 0;
    }) as { spent?: number; cap?: number } | undefined;
    if (record?.spent !== undefined && record.cap !== undefined) {
      return `${compactTokens(record.spent)}/${compactTokens(record.cap)}`;
    }
    const cap = this.shell.config.nightBudget.maxTokensPerNight;
    return cap > 0 ? `${compactTokens(cap)}/${compactTokens(cap)}` : undefined;
  }

  private diskFree(): number | undefined {
    try {
      const fs = statfsSync(this.shell.config.dataDir);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      return undefined;
    }
  }
}

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompanionShell } from '../app.ts';
import type { CommandReply } from '../commands.ts';
import { defaultRunner } from '../install/service.ts';
import { readInstallState, readTreeVersion, serviceFileExists, treeOfThisProcess } from './paths.ts';
import { spawnUpgradeSupervisor } from './spawn.ts';
import { stageUpgradeTree } from './stage.ts';
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
} from './records.ts';
import { defaultSocketPath } from '../attach/server.ts';

/**
 * How long the resident gives the supervisor before the promise's due instant arrives. The report is
 * what the promise is for; this is the "how long is still working" half of it. The supervisor's own
 * pid decides the rest (see `settleUpgradeReport`).
 */
const UPGRADE_REPORT_GRACE_MS = 60_000;

export class UpgradeAdmin {
  constructor(private readonly shell: CompanionShell) {}

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
    const state = this.shell.machine.state;
    if (state !== 'IDLE' && state !== 'DORMANT') {
      this.shell.trace.append('upgrade_refused', { state, reason: 'not_silent' });
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
    // No argument means the ordinary release path: install the next `cogmem` from npm. A directory
    // (or a local tarball) is still accepted for developers, but it is not what a user is asked to do.
    const trimmed = source.trim() === '' ? 'latest' : source.trim();
    const pending = readUpgradeRequest(this.shell.config.dataDir);
    if (pending) {
      this.shell.trace.append('upgrade_refused', { reason: 'in_flight', upgradeId: pending.id });
      return { text: `已经有一次升级在跑（${pending.fromVersion} → ${pending.toVersion}，id ${pending.id}）：它的结果还没回来，先等它报完。`, receipt: true };
    }

    let staged: { tree: string; version: string };
    try {
      staged = (this.shell.options.stageUpgrade ?? stageUpgradeTree)({ source: trimmed, dataDir: this.shell.config.dataDir, currentTree: treeOfThisProcess(), bunPath: process.execPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.shell.trace.append('upgrade_stage_failed', { source: trimmed, message });
      return { text: `升级没有开始：旁置安装失败（${message}）。没有写快照、没有动服务。`, receipt: true };
    }

    const id = newUpgradeId(this.shell.now());
    const fromVersion = readTreeVersion(treeOfThisProcess());
    const request = this.buildUpgradeRequest(id, fromVersion, staged);
    // The promise comes before anything can go offline: it is the durable statement that a report is
    // owed, and it is closed by speaking that report (F2's own wake intention — no new bookkeeping).
    const promise = this.shell.machine.addWakeIntent({
      at: this.shell.now() + UPGRADE_REPORT_GRACE_MS,
      reason: upgradePromiseReason(id),
    });
    writeUpgradeJson(upgradeRequestPath(this.shell.config.dataDir), request);
    this.shell.trace.append('upgrade_announced', {
      upgradeId: id,
      from: fromVersion,
      to: staged.version,
      fromTree: request.fromTree,
      toTree: staged.tree,
      serviceMode: request.serviceMode,
      promiseId: promise.id,
    });

    const requestPath = upgradeRequestPath(this.shell.config.dataDir);
    const spawned = await (this.shell.options.upgradeSpawner
      ?? ((upgradeRequest, path) => spawnUpgradeSupervisor(upgradeRequest, path, { run: defaultRunner() })))(request, requestPath);
    if (!spawned.ok) {
      // Nothing left this process, so nothing is owed: withdraw the request and the promise rather
      // than leave a report that will never come.
      clearUpgradeRequest(this.shell.config.dataDir);
      this.shell.machine.consumeWakeIntent(promise.id);
      this.shell.trace.append('upgrade_spawn_failed', { upgradeId: id, message: spawned.detail });
      return { text: `升级没有开始：${spawned.detail}。快照未写、服务未动，也没有留下回报承诺。`, receipt: true };
    }
    this.shell.trace.append('upgrade_scheduled', { upgradeId: id, supervisor: spawned.detail });
    return {
      text: `好，我要短暂下线一会儿（${fromVersion} → ${staged.version}）：先给脑子整份快照，再用新版迁移 + 召回自检，过了才切换、起新版；任一步不过自动回滚旧版。回来就向你回报结果。`,
      receipt: true,
    };
  }

  private buildUpgradeRequest(id: string, fromVersion: string, staged: { tree: string; version: string }): UpgradeRequest {
    const dataDir = this.shell.config.dataDir;
    const homeDir = process.env.HOME ?? homedir();
    const install = readInstallState(dataDir);
    const choices = install?.choices ?? {};
    const base = {
      id,
      at: this.shell.now(),
      fromVersion,
      fromTree: treeOfThisProcess(),
      toVersion: staged.version,
      toTree: staged.tree,
      pid: process.pid,
      dataDir,
      dbPath: this.shell.config.dbPath,
      workspaceRoot: this.shell.config.workspaceRoot,
      projectId: this.shell.config.projectId,
      agentId: this.shell.config.agentId,
      httpPort: choices.httpPort ?? this.shell.config.http.port,
      socketPath: this.shell.config.attach.socketPath ?? defaultSocketPath(dataDir),
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
  settleUpgradeReport(at: number): void {
    const outcome = readUpgradeOutcome(this.shell.config.dataDir);
    if (outcome && outcome.reportedAt === undefined) {
      this.markUpgradeReported(outcome, at);
      return;
    }
    if (outcome) return;
    const promise = this.shell.machine.wakeIntents.find((intent) => !intent.consumedAt && isUpgradePromise(intent.reason));
    const request = readUpgradeRequest(this.shell.config.dataDir);
    if (request) {
      if (supervisorIsAlive(this.shell.config.dataDir)) {
        // Mid-cycle: the supervisor owns the record and has not finished. Saying "failed" here would
        // be a lie about an upgrade that is still running.
        this.shell.trace.append('upgrade_report_waiting', { upgradeId: request.id, dueAt: promise?.at });
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
      clearUpgradeRequest(this.shell.config.dataDir);
      this.markUpgradeReported(silence, at);
      return;
    }
    // The obligation outlived both records: report the promise rather than swallowing it.
    if (promise && promise.at <= at) {
      this.reportUpgradeText('升级回报承诺到期，但升级记录已经不在了（既没有结果，也没有在跑的请求）——按未回报处理。');
      this.shell.trace.append('upgrade_promise_orphaned', { promiseId: promise.id });
      this.shell.machine.consumeWakeIntent(promise.id);
    }
  }

  private markUpgradeReported(outcome: UpgradeOutcome, at: number): void {
    // Persisted with `reportedAt` set, so a restarted resident cannot report the same outcome twice —
    // including the silence outcome, which is the one record that would otherwise exist nowhere.
    writeUpgradeJson(upgradeOutcomePath(this.shell.config.dataDir), { ...outcome, reportedAt: at });
    const promise = this.shell.machine.wakeIntents.find((intent) => !intent.consumedAt && isUpgradePromise(intent.reason));
    if (promise) this.shell.machine.consumeWakeIntent(promise.id);
    this.shell.trace.append('upgrade_reported', {
      upgradeId: outcome.id,
      status: outcome.status,
      step: outcome.step,
      from: outcome.fromVersion,
      to: outcome.toVersion,
      checks: outcome.checks.length,
      failedChecks: outcome.checks.filter((check) => !check.ok).map((check) => check.id),
      promiseClosed: promise?.id,
    });
    this.shell.lastUpgrade = outcome;
    this.reportUpgradeText(describeUpgradeOutcome(outcome));
  }

  /** The report reaches a face that is listening: the line channel prints it, the TUI reads it on attach. */
  private reportUpgradeText(text: string): void {
    void this.shell.host.bus.emit('terminal_print', { text: `${text}\n` });
  }

}

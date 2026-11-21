import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompanionShell } from './app.ts';
import type { CommandReply } from './commands.ts';
import { defaultRunner } from './install/service.ts';
import { restartService, servicePath, type Platform, type ServiceSpec } from './install/service.ts';
import { checkPluginSpec } from './plugins/load.ts';
import { pluginsConfigPath, readPluginRegistry, writePluginRegistry } from './plugins/registry.ts';
import { readInstallState, shellDirOfTree, treeOfThisProcess } from './upgrade/paths.ts';

/**
 * The plugin restart's grace. The reply to `/plugins add` (and its trace) must reach the attach
 * socket and the log before systemd's SIGTERM takes the process down, or the user sees a command
 * that neither answered nor left a record. Same spirit as the upgrade's handoff grace, sized for one
 * socket write rather than a whole announcement.
 */
const PLUGIN_RESTART_GRACE_MS = 300;

export class PluginsAdmin {
  constructor(private readonly shell: CompanionShell) {}

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
      registered: readPluginRegistry(this.shell.config.dataDir),
      results: this.shell.pluginResults.map((entry) => ({
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
      registered: [...this.shell.config.plugins],
      results: this.shell.pluginResults.map((entry) => ({
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
      this.shell.trace.append('plugin_install_rejected', { spec, reason: 'invalid_plugin_spec' });
      return { text: 'invalid_plugin_spec: 插件 spec 不能为空，也不能包含换行。', receipt: true };
    }
    const refused = checkPluginSpec(spec, {
      cwd: this.shell.config.workspaceRoot,
      roots: [this.shell.config.workspaceRoot, treeOfThisProcess()],
      dataDir: this.shell.config.dataDir,
    });
    if (refused) {
      this.shell.trace.append('plugin_install_rejected', { spec, reason: refused });
      return { text: `插件未安装：${refused}`, receipt: true };
    }
    const path = pluginsConfigPath(this.shell.config.dataDir);
    let registry: string[];
    try {
      registry = readPluginRegistry(this.shell.config.dataDir);
    } catch (error) {
      return { text: `登记失败：${error instanceof Error ? error.message : String(error)}。先修好 ${path} 再试。`, receipt: true };
    }
    if (registry.includes(spec)) {
      return { text: `${spec} 已经在注册表里（${path}）。本进程的加载结果见 /plugins 或 /health 的 plugins。`, receipt: true };
    }
    const next = [...registry, spec];
    writePluginRegistry(this.shell.config.dataDir, next);
    this.shell.trace.append('plugin_registered', { spec, source: 'command', registry: path, registered: next });
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
      this.shell.trace.append('plugin_restart_skipped', { spec, reason: 'no_service_manager' });
      return { ok: false, detail: '找不到接管本进程（且指向这个数据目录）的 systemd unit / launchd plist' };
    }
    const assignment = this.shell.machine.runtime.openAssignment;
    if (assignment) {
      this.shell.machine.updateRuntime({ resumeAfterRestart: { assignmentId: assignment.id, at: this.shell.now(), reason: 'plugins' } });
    }
    const restart = this.shell.options.restartResident ?? (() => restartService(defaultRunner(), target.spec, target.platform));
    this.shell.trace.append('plugin_restart_scheduled', {
      spec,
      service: target.spec.serviceName,
      platform: target.platform,
      graceMs: PLUGIN_RESTART_GRACE_MS,
      resumeAssignmentId: assignment?.id ?? null,
    });
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(restart)
        .catch((error) => this.shell.trace.append('plugin_restart_failed', { service: target.spec.serviceName, message: error instanceof Error ? error.message : String(error) }));
    }, PLUGIN_RESTART_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    return { ok: true, detail: `${target.platform === 'linux' ? 'systemctl --user restart' : 'launchctl kickstart -k'} ${target.spec.serviceName}` };
  }

  /** The spec the installer's unit was rendered from, rebuilt from the state it recorded. */
  private serviceRestartTarget(): { spec: ServiceSpec; platform: Platform } | undefined {
    const choices = readInstallState(this.shell.config.dataDir)?.choices ?? {};
    const platform = choices.platform ?? process.platform;
    if (platform !== 'linux' && platform !== 'darwin') return undefined;
    const spec: ServiceSpec = {
      serviceName: choices.serviceName ?? 'cogmem-companion',
      bunPath: process.execPath,
      shellDir: shellDirOfTree(treeOfThisProcess()),
      dataDir: this.shell.config.dataDir,
      workspaceRoot: this.shell.config.workspaceRoot,
      projectId: this.shell.config.projectId,
      agentId: this.shell.config.agentId,
      httpPort: choices.httpPort ?? this.shell.config.http.port,
      envFile: join(this.shell.config.dataDir, 'env'),
      logFile: join(this.shell.config.dataDir, 'service.log'),
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
  resumeAfterRequestedRestart(): void {
    const request = this.shell.machine.runtime.resumeAfterRestart;
    if (!request) return;
    this.shell.machine.updateRuntime({ resumeAfterRestart: undefined });
    const assignment = this.shell.machine.runtime.openAssignment;
    if (!assignment || assignment.id !== request.assignmentId) {
      this.shell.trace.append('assignment_resume_skipped', { assignmentId: request.assignmentId, reason: assignment ? 'assignment_replaced' : 'no_assignment' });
      return;
    }
    this.shell.trace.append('assignment_resume', { assignmentId: assignment.id, reason: request.reason, requestedAt: request.at });
    setTimeout(() => {
      void this.resumeAssignment(assignment.id).catch((error) =>
        this.shell.trace.append('assignment_resume_failed', { assignmentId: assignment.id, message: error instanceof Error ? error.message : String(error) }),
      );
    }, 0);
  }

  private async resumeAssignment(assignmentId: string): Promise<void> {
    const assignment = this.shell.machine.runtime.openAssignment;
    if (!assignment || assignment.id !== assignmentId) return;
    if (this.shell.machine.state !== 'IDLE') {
      this.shell.trace.append('assignment_resume_skipped', { assignmentId, reason: `state:${this.shell.machine.state}` });
      return;
    }
    if (this.shell.statusFace.dailyBudgetExceeded()) {
      this.shell.trace.append('daily_budget_exceeded', {
        trigger: 'assignment_resume',
        assignmentId,
        day: this.shell.statusFace.localDay(this.shell.now()),
        spent: this.shell.statusFace.dailySpent(),
        limit: this.shell.config.dailyBudget.maxTokensPerDay,
      });
      return;
    }
    await this.shell.runLoop.executeRun(assignment.text, 'message_received', 'assignment_resume');
  }

  /**
   * `/why`: read back the newest recall decision. This goes through the kernel's own `TraceStore`
   * read face — `trace_events` is written by `RecallDecisionTrace` for every recall, and the
   * emergence decision point calls the same recall lane, so both a recall and a surfacing have a row
   * here. It is a read of what was decided, not a re-run (which would write a fresh row); no row is
   * an answer the receipt gives plainly instead of guessing at one.
   */
  whyReport(): string {
    const emergence = this.shell.trace.read().filter((record) => record.kind === 'emergence_decision').pop();
    try {
      const trace = this.shell.backend.recentRecallDecision({
        projectId: this.shell.config.projectId,
        agentId: this.shell.config.agentId,
      });
      if (trace.state === 'untraced') {
        return emergence ? this.emergenceWhyReport(emergence) : '本会话尚无召回决策痕迹（内核还没有 trace_events 表）。不编造。';
      }
      const last = trace.decision;
      if (!last) return emergence ? this.emergenceWhyReport(emergence) : '本会话尚无召回决策痕迹。不编造。';
      // Whichever decision is newer is the one the receipt answers with: an asked recall after a
      // surfaced candidate is the recall; the emergence step is shown until something newer lands.
      if (emergence && Number(emergence.now ?? emergence.at ?? 0) >= last.timestamp) {
        return this.emergenceWhyReport(emergence);
      }
      const payload = last.payload as Record<string, unknown>;
      const selected = Array.isArray(payload.selectedIds) ? payload.selectedIds.map(String) : [];
      const suppressed = Array.isArray(payload.suppressed) ? (payload.suppressed as Array<Record<string, unknown>>) : [];
      const lines = [
        `最近一次召回决策 · ${new Date(last.timestamp).toISOString()}`,
        `查询：${typeof payload.query === 'string' && payload.query !== '' ? payload.query : '（空）'}`,
        `车道：${String(payload.lane ?? 'unknown')} · 理由：${String(payload.reason ?? 'unknown')}`,
        `选中 ${selected.length} 条${selected.length > 0 ? `：${selected.join(', ')}` : ''}`,
      ];
      if (suppressed.length > 0) {
        lines.push(`抑制 ${suppressed.length} 类：${suppressed.map((entry) => `${String(entry.reason ?? 'unknown')}×${Number(entry.count ?? 0)}`).join('、')}`);
      }
      lines.push(`来源链：${trace.chain.length <= 1 ? '无父事件' : trace.chain.join(' ← ')}`);
      return lines.join('\n');
    } catch (error) {
      // A read that failed is not "no trace": the receipt says which it was, or a broken database
      // would read as an empty history.
      this.shell.trace.append('why_read_failed', { message: error instanceof Error ? error.message : String(error) });
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

  lastDreamProduct(): { localDate: string; eventCount: number; summary: string } | undefined {
    const records = this.shell.trace.read().filter((record) => record.kind === 'dream_complete');
    const last = records[records.length - 1];
    if (!last) return undefined;
    const localDate = String(last.localDate ?? '');
    const events = this.shell.kernel.getThreadEvents(`companion-dream:${localDate}`, { projectId: this.shell.config.projectId, limit: 50 });
    const product = events.find((event) => (event.payload as { metadata?: { kind?: unknown } } | undefined)?.metadata?.kind === 'dream-integration');
    const summary = (product?.payload as { text?: unknown } | undefined)?.text;
    return { localDate, eventCount: Number(last.eventCount ?? 0), summary: typeof summary === 'string' ? summary : `夜间整合 ${localDate}` };
  }


}

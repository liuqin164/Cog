/**
 * The core command table (spec §7) — the one place a core command's name, description, argument
 * hint, availability and handler are written down.
 *
 * Three faces consume it and none restates it: the palette (`tui/commands.ts`) lists it, the
 * resident (`app.ts`) dispatches it, and the TUI (`tui/app.ts`) decides where its answer shows.
 * `surfaces` is load-bearing rather than documentation: a face may only dispatch a name the table
 * grants it, so a command deleted here disappears from all three at once and a command kept only
 * for the palette (`/exit`, `/help`) is not answered by the resident.
 *
 * Pi's own two faces drifted exactly here (20-165 deep read): `/mcp` is documented and absent from
 * the interactive builtin table, and RPC enumerates a different command list than the TUI shows.
 * One table is the fix this codebase keeps.
 */
import { readSoul } from './install/soul.ts';
import { contextMetricsLine, laneReportLines, type ContextMetrics, type LaneAssemblyView } from './state/session-lanes.ts';
import type { ToolOutputAccount } from './state/context-budget.ts';

export type CommandSurface = 'palette' | 'resident' | 'tui';

export interface CommandReply {
  text: string;
  data?: Record<string, unknown>;
  /** The third visual style (spec §7): the TUI shows this in the transcript, not in an overlay. */
  receipt?: boolean;
}

/** Everything a handler may ask of the shell; `CompanionShell` provides it as `commandHost`. */
export interface CommandHost {
  config(): { dbPath: string; agentId: string; contextSweetSpot: number };
  lifecycle(): { state: string; seq: number; costDayTokens: number; sandbox: 'on' | 'off' };
  contextTokens(): number;
  /** The newest request's tool-output account (#319); `undefined` before the first request. */
  contextToolOutput?(): ToolOutputAccount | undefined;
  /** The newest six-lane assembly; `undefined` before the first request of the process. */
  contextLanes(): LaneAssemblyView | undefined;
  /** The projection counts behind that assembly (#268); `undefined` with no assembly. */
  contextMetrics(): ContextMetrics | undefined;
  contextTools(): string[];
  /**
   * The provider-reported prompt-cache account for the run in flight (#165 round 21); `undefined`
   * when no provider reported a cache field. Never filled from round 17's estimate: the estimate is
   * not a cache measurement, and a made-up ratio is worse than no line.
   */
  promptCache(): { hit: number; miss: number; percent: number } | undefined;
  lastDream(): { localDate: string; eventCount: number; summary: string } | undefined;
  commitments(): Array<{ candidateId: string; title: string; status: string; updatedAt: number }>;
  /**
   * The kernel curator's review queue (#231): counts by status and the candidates still unsettled.
   * Read-only; promotion and review stay on `cogmem memory govern|review`.
   */
  candidateQueue(): {
    counts: {
      candidate: number;
      needsConfirmation: number;
      promoted: number;
      rejected: number;
      superseded: number;
      shadow: number;
    };
    items: Array<{
      candidateId: string;
      runId: string;
      candidateType: string;
      status: string;
      confidence: number;
      createdAt: number;
      statusReason?: string;
      promotionTargetType?: string;
    }>;
  };
  /** F7's per-source modulation, for the status face. */
  surfacingFeedback?(): {
    types: Array<{ type: string; level: number; stopped: boolean; cooldownUntil: number | null; ignoredCount: number }>;
  };
  /** F7: the owner stops or restarts one proactive source. */
  stopSurfacing?(type?: string): CommandReply;
  resumeSurfacing?(type: string): CommandReply;
  /** F16: move a surfaced promise's occurrence to `minutes` from now. */
  snooze?(minutes: number, commitmentId?: string): CommandReply;
  /** F2: register the agent's own wake intention. */
  wake?(minutes: number, reason: string): CommandReply;
  /** #328: the configured do-not-disturb window and whether it is open now. */
  quietWindow?(): { startHour: number; endHour: number; active: boolean } | undefined;
  whyReport(): string;
  capturePaused(): boolean;
  setCapturePaused(paused: boolean): void;
  /**
   * `/continue`: approve the additional budget a paused work run asked for and resume it in place
   * (#228). A receipt when there is nothing paused or the pause is a question rather than a budget.
   */
  continueSuspended(): CommandReply;
  /**
   * `/forget` (#232): show the half-open window and its ledger row count, then delete exactly that
   * window through F9's `deleteRange`. The preview is the confirmation step; nothing is deleted
   * until `forgetConfirm`.
   */
  forgetPreview(start: number, end: number): CommandReply;
  forgetConfirm(): CommandReply;
  /** `/export`: F9's archive to `path`, or a timestamped file under the data dir. */
  exportMemory(path: string | undefined): CommandReply;
  /**
   * `/correct`: one owner correction of a current profile entry, through the profile face. With no
   * profile match the key may name a practice: that path only proposes, and
   * `confirmProcedureCorrection` is what writes the mark (#264).
   */
  correctProfile(key: string, value: string): Promise<CommandReply>;
  /** `/correct confirm`: apply the pending practice proposal, if any. */
  confirmProcedureCorrection(): CommandReply | Promise<CommandReply>;
  sessionModel(): string;
  modelRoutes(): string[];
  modelRouter(): { active: string; lines: string[]; storeError?: string } | undefined;
  switchRoute(name: string): { ok: true; name: string; model: string } | { ok: false; message: string };
  sleep(): Promise<void>;
  /**
   * The resident-form upgrade (#165): refused unless the lifecycle is silent (IDLE/DORMANT), staged
   * beside the serving tree, and handed to an out-of-process supervisor. Every refusal is a receipt
   * that says why, because "nothing happened and nobody said why" is the failure mode this command
   * exists to avoid.
   */
  upgrade(source: string): Promise<CommandReply>;
  /** The native plugin registry and this process's load results — the "is it actually loaded" face. */
  pluginReport(): CommandReply;
  /**
   * Register one native plugin spec in `<dataDir>/plugins.json` and make it effective. The restart is the
   * existing service-manager path, not a new supervisor; without a manager the receipt says so.
   */
  installPlugin(spec: string): Promise<CommandReply>;
}

export interface CoreCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Which faces may dispatch it. */
  surfaces: readonly CommandSurface[];
  /** The palette hides this until more than one model route is configured (`/model`). */
  needsMultipleRoutes?: boolean;
  /** The one handler every declared surface reaches. */
  run(host: CommandHost, args: string): CommandReply | Promise<CommandReply>;
}

export const CORE_COMMANDS: readonly CoreCommand[] = [
  {
    name: 'soul',
    description: '查看当前 soul（身份与称呼风格）',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      // Read back the kernel's newest version. The star-sea editor writes new versions; this is
      // the resident's read-only receipt.
      const { dbPath, agentId } = host.config();
      const row = readSoul(dbPath, agentId);
      if (!row) return { text: `soul 尚未写入。当前身份 ${agentId}。` };
      const bytes = Buffer.byteLength(row.content);
      return {
        text: `soul v${row.version}（${bytes} 字节）：${row.content.split('\n')[0]}`,
        data: { soul: { version: row.version, bytes, agentId: row.agentId } },
      };
    },
  },
  {
    name: 'memory',
    description: '打开星海（记忆地址）',
    surfaces: ['palette', 'resident', 'tui'],
    run: (host) => ({ text: `星海（记忆图）前端不在本壳内；记忆库文件：${host.config().dbPath}` }),
  },
  {
    name: 'forget',
    description: '按时间段删除记忆（先看范围与条数，确认后执行并记审计）',
    argumentHint: '<起> <止> | confirm',
    surfaces: ['palette', 'resident', 'tui'],
    run(host, args) {
      const parts = args.trim().split(/\s+/u).filter(Boolean);
      if (parts.length === 1 && parts[0]!.toLowerCase() === 'confirm') return host.forgetConfirm();
      if (parts.length !== 2) {
        return {
          text: '用法：/forget <起> <止> 预览（如 2026-11-01 2026-11-02），确认后 /forget confirm。窗口含起不含止。',
          receipt: true,
        };
      }
      const start = parseInstant(parts[0]!);
      const end = parseInstant(parts[1]!);
      if (start === undefined || end === undefined) {
        return { text: '时间看不懂：用 ISO 日期/时间（2026-11-01 或 2026-11-01T12:00:00Z）或毫秒时间戳。', receipt: true };
      }
      return host.forgetPreview(start, end);
    },
  },
  {
    name: 'export',
    description: '导出人类可读的记忆归档（Markdown）；数据目录外的路径先确认再写',
    argumentHint: '[文件路径] | confirm',
    surfaces: ['palette', 'resident', 'tui'],
    run: (host, args) => host.exportMemory(args.trim() || undefined),
  },
  {
    name: 'correct',
    description: '纠正一条画像/偏好，或提议纠正一条做法（确认后生效）',
    argumentHint: '<键> <新值> | confirm',
    surfaces: ['palette', 'resident', 'tui'],
    run(host, args) {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === 'confirm') return host.confirmProcedureCorrection();
      const split = trimmed.search(/\s/u);
      if (split <= 0 || trimmed.slice(split).trim() === '') {
        return { text: '用法：/correct <键> <新值>，或 /correct confirm。键和当前值可用 /export 的 Profile 段或画像册查看。', receipt: true };
      }
      return host.correctProfile(trimmed.slice(0, split), trimmed.slice(split).trim());
    },
  },
  {
    name: 'commitments',
    description: '承诺册概览',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      const items = host.commitments();
      const fulfilled = items.filter((item) => item.status === 'completed').length;
      return { text: `承诺册 ${items.length} 条（已兑现 ${fulfilled} 条）`, data: { companion_commitments: { items } } };
    },
  },
  {
    name: 'candidates',
    description: '内核候选队列：数量、来源与待审状态',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      const { counts, items } = host.candidateQueue();
      const byType = new Map<string, number>();
      for (const item of items) byType.set(item.candidateType, (byType.get(item.candidateType) ?? 0) + 1);
      const lines = [
        `候选队列：待治理 ${counts.candidate} · 待确认 ${counts.needsConfirmation} · 影子 ${counts.shadow} · 已晋升 ${counts.promoted} · 已拒绝 ${counts.rejected} · 已取代 ${counts.superseded}`,
        `来源（候选类型）：${byType.size > 0 ? [...byType].map(([type, count]) => `${type} ${count}`).join(' · ') : '无'}`,
      ];
      if (items.length === 0) lines.push('没有待审候选。');
      else {
        const unsettled = counts.candidate + counts.needsConfirmation + counts.shadow;
        lines.push(unsettled > items.length
          ? `未结候选 ${unsettled} 条（列出 ${items.length} 条）：`
          : `未结候选 ${items.length} 条：`);
        for (const item of items) {
          const reason = item.statusReason ? ` · ${item.statusReason}` : '';
          lines.push(`- ${item.candidateType} · ${item.status} · 置信度 ${item.confidence.toFixed(2)}${reason}`);
        }
      }
      return { text: lines.join('\n'), data: { companion_candidates: { counts, items } } };
    },
  },
  {
    name: 'status',
    description: '健康状态页',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      const { state, seq, costDayTokens, sandbox } = host.lifecycle();
      const sandboxLine = sandbox === 'on' ? '沙箱 开（bwrap，网络隔离）' : '沙箱 关（bwrap 不可用，bash 无隔离）';
      const modulated = (host.surfacingFeedback?.().types ?? []).filter((type) => type.level > 0 || type.stopped);
      const feedbackLine = modulated.length === 0
        ? '浮现降频：无'
        : `浮现降频：${modulated.map((type) => `${type.type} L${type.level}${type.stopped ? '（已停）' : ''} 忽略 ${type.ignoredCount}`).join(' · ')}`;
      const quiet = host.quietWindow?.();
      const quietLine = quiet === undefined
        ? '勿扰窗：关'
        : `勿扰窗：${String(quiet.startHour).padStart(2, '0')}:00–${String(quiet.endHour).padStart(2, '0')}:00（${quiet.active ? '生效中' : '未生效'}）`;
      return { text: `生命周期 ${state}，checkpoint seq ${seq}，本日 ${costDayTokens} token，${sandboxLine}。${quietLine}。${feedbackLine}。` };
    },
  },
  {
    name: 'snooze',
    description: '把已浮现的承诺顺延（分钟）',
    argumentHint: '<分钟> [承诺 id]',
    surfaces: ['palette', 'resident', 'tui'],
    run(host, args) {
      const [rawMinutes = '', id] = args.trim().split(/\s+/u).filter(Boolean);
      const minutes = Number(rawMinutes);
      if (!Number.isInteger(minutes) || minutes <= 0) return { text: '用法：/snooze <分钟> [承诺 id]', receipt: true };
      if (!host.snooze) return { text: '本进程没有接上承诺册。', receipt: true };
      return host.snooze(minutes, id);
    },
  },
  {
    name: 'wake',
    description: '给同伴设一个自己的醒来意图（分钟 + 理由）',
    argumentHint: '<分钟> <理由>',
    surfaces: ['palette', 'resident', 'tui'],
    run(host, args) {
      const trimmed = args.trim();
      const split = trimmed.search(/\s/u);
      const minutes = Number(split < 0 ? trimmed : trimmed.slice(0, split));
      const reason = split < 0 ? '' : trimmed.slice(split).trim();
      if (!Number.isInteger(minutes) || minutes <= 0 || reason === '') return { text: '用法：/wake <分钟> <理由>', receipt: true };
      if (!host.wake) return { text: '本进程没有接上醒来意图。', receipt: true };
      return host.wake(minutes, reason);
    },
  },
  {
    name: 'surfacing',
    description: '浮现反馈：查看降频，或让某个来源停下 / 恢复',
    argumentHint: '[stop [来源] | resume <来源>]',
    surfaces: ['palette', 'resident', 'tui'],
    run(host, args) {
      const [verb = '', type] = args.trim().split(/\s+/u).filter(Boolean);
      if (verb === 'stop') return host.stopSurfacing?.(type) ?? { text: '本进程没有接上浮现反馈。', receipt: true };
      if (verb === 'resume' && type !== undefined) return host.resumeSurfacing?.(type) ?? { text: '本进程没有接上浮现反馈。', receipt: true };
      const state = host.surfacingFeedback?.();
      if (!state) return { text: '本进程没有接上浮现反馈。', receipt: true };
      const lines = state.types.map((entry) => `${entry.type}：L${entry.level} 忽略 ${entry.ignoredCount}${entry.stopped ? ' · 已停' : ''}${entry.cooldownUntil === null ? '' : ` · 冷却至 ${new Date(entry.cooldownUntil).toISOString()}`}`);
      return { text: ['浮现反馈（按来源）：', ...lines, '用 /surfacing stop [来源] 停下，/surfacing resume <来源> 恢复。'].join('\n') };
    },
  },
  {
    name: 'context',
    description: '上下文车道构成',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      const lanes = host.contextLanes();
      const lines = lanes
        ? laneReportLines(lanes, host.contextTokens())
        : [`目标带宽 ${host.config().contextSweetSpot} token，尚无车道组装记录：发一条消息后再看。`];
      const metrics = host.contextMetrics();
      if (lanes && metrics) lines.push(contextMetricsLine(metrics));
      const toolOutput = host.contextToolOutput?.();
      if (toolOutput && toolOutput.toolOutputTokens >= 0) {
        const total = host.contextTokens();
        const share = total > 0 ? Math.round((toolOutput.toolOutputTokens / total) * 100) : 0;
        const folded = toolOutput.foldedResults > 0 ? `；折叠 ${toolOutput.foldedResults} 条` : '';
        lines.push(`本轮工具输出 ${toolOutput.toolOutputTokens} token（占请求 ${share}%${folded}）`);
        if (toolOutput.requestBudgetTokens !== undefined) {
          lines.push(`整请求预算 ${toolOutput.requestBudgetTokens} token（原始工具输出 ${toolOutput.rawTokens} token）`);
        }
      }
      const cache = host.promptCache();
      // Only a provider-reported account earns a line. With nothing reported there is none, because
      // "0%" is a claim the provider never made.
      if (cache) lines.push(`provider 实报 prompt 缓存命中 ${cache.percent}%（命中 ${cache.hit} / 未命中 ${cache.miss} token）。`);
      else lines.push('provider 缓存：上游未回报缓存字段。');
      const tools = host.contextTools();
      if (tools.length > 0) lines.push(`已装载工具：${tools.join('、')}`);
      return { text: lines.join('\n') };
    },
  },
  {
    name: 'sleep',
    description: '让它进 DORMANT（关窗只是你走了）',
    surfaces: ['palette', 'resident', 'tui'],
    async run(host) {
      await host.sleep();
      return { text: '已让它进 DORMANT。关窗只是你走了，/sleep 才是让它睡。' };
    },
  },
  {
    name: 'upgrade',
    description: '从静默态升级（旁置新版 → 快照 → 迁移 → 健康门 → 切换，失败回滚）',
    argumentHint: '<新版目录>',
    surfaces: ['palette', 'resident', 'tui'],
    run: (host, args) => host.upgrade(args.trim()),
  },
  {
    name: 'plugins',
    description: '原生插件：查看已登记 / 已加载，或登记一个（登记后重启生效）',
    argumentHint: '[add <包名或路径>]',
    surfaces: ['palette', 'resident', 'tui'],
    run(host, args) {
      const [verb = '', ...rest] = args.trim().split(/\s+/u).filter(Boolean);
      if (verb === 'add' || verb === 'install') {
        const spec = rest.join(' ');
        if (spec === '') return { text: '用法：/plugins add <包名或路径>（例如 ./plugins/hello.ts）', receipt: true };
        return host.installPlugin(spec);
      }
      if (verb !== '' && verb !== 'list') return { text: '用法：/plugins [add <包名或路径>]', receipt: true };
      return host.pluginReport();
    },
  },
  {
    name: 'dream',
    description: '最近一次做梦产物',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      const product = host.lastDream();
      return {
        text: product ? `${product.localDate}：${product.summary}` : '本会话尚无做梦产物。',
        data: product ? { companion_dream: { product } } : undefined,
      };
    },
  },
  {
    name: 'pause',
    description: '暂停捕获（壳不再写内核；重启后仍是暂停）',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      if (host.capturePaused()) return { text: '已在暂停捕获中：此刻壳不把会话内容写进内核。/resume 恢复。', receipt: true };
      // The write is the receipt's precondition: if the checkpoint write fails the machine halts
      // and this never claims a pause that the next process would not know about.
      host.setCapturePaused(true);
      return { text: '已暂停捕获：壳不再把新的会话内容写进内核。这个状态随 checkpoint 持久化，重启后仍是暂停；/resume 恢复。', receipt: true };
    },
  },
  {
    name: 'resume',
    description: '恢复捕获（/pause 之后）',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      if (!host.capturePaused()) return { text: '捕获本来就在进行中，没有需要恢复的暂停。', receipt: true };
      host.setCapturePaused(false);
      return { text: '已恢复捕获：接下来的回合会照常写进内核。', receipt: true };
    },
  },
  {
    name: 'continue',
    description: '批准暂停任务的追加预算，原地续跑',
    surfaces: ['palette', 'resident', 'tui'],
    run: (host) => host.continueSuspended(),
  },
  {
    name: 'why',
    description: '看最近一次召回决策痕迹（只读）',
    surfaces: ['palette', 'resident', 'tui'],
    run: (host) => ({ text: host.whyReport(), receipt: true }),
  },
  {
    name: 'model',
    description: '查看 / 切换模型路线（不重启、不断会话）',
    argumentHint: '<名称>',
    surfaces: ['palette', 'resident', 'tui'],
    needsMultipleRoutes: true,
    run(host, args) {
      const router = host.modelRouter();
      if (!router) return { text: `会话模型：${host.sessionModel()}（本进程未接入路线表，切换需重装或重启）。` };
      const requested = args.trim();
      if (requested !== '') {
        const switched = host.switchRoute(requested);
        if (!switched.ok) return { text: `切换失败：${switched.message}` };
        return {
          text: `已切到路线「${switched.name}」（${switched.model}）。下一回合生效：进程没重启，会话没断。`,
          data: { companion_model_routes: { routes: host.modelRoutes(), active: switched.name } },
        };
      }
      const warning = router.storeError ? [`⚠ 路线表有问题：${router.storeError}（内置 mg 仍可用；修好或删掉这个文件再重试）`] : [];
      return {
        text: [`当前路线：${router.active}`, ...router.lines, ...warning, '用 /model <名称> 切换（不重启、不断会话）'].join('\n'),
        data: { companion_model_routes: { routes: host.modelRoutes(), active: router.active } },
      };
    },
  },
  {
    name: 'help',
    description: '快捷键与命令',
    surfaces: ['palette', 'resident', 'tui'],
    run: () => ({ text: 'Enter 发送 · Shift+Enter 换行 · / 命令面板 · Esc 撤回排队消息 · /exit 断开附着 · /sleep 进 DORMANT · 提议出现时 Enter 执行 / Esc 放弃' }),
  },
  {
    name: 'exit',
    description: '断开附着（常驻进程继续）',
    // The TUI detaches itself; there is nothing for the resident to answer.
    surfaces: ['palette', 'tui'],
    run: () => ({ text: '断开附着。常驻进程继续运行。', receipt: true }),
  },
];

/** The table entry a face is allowed to dispatch, or `undefined` for "not my command". */
export function coreCommandFor(name: string, surface: CommandSurface): CoreCommand | undefined {
  return CORE_COMMANDS.find((command) => command.name === name && command.surfaces.includes(surface));
}

/** The palette's availability rule (spec §7): whether a face may present a core command right now. */
export function availableCoreCommand(
  name: string,
  surface: CommandSurface,
  options: { multipleRoutes?: boolean } = {},
): CoreCommand | undefined {
  const command = coreCommandFor(name, surface);
  if (!command) return undefined;
  if (command.needsMultipleRoutes === true && options.multipleRoutes !== true) return undefined;
  return command;
}

/**
 * The closest core name by edit distance. This is the hint an unknown `/foo` gets on every face, so
 * a typo points at a real command instead of silently becoming a model prompt.
 */
export function nearestCommand(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const command of CORE_COMMANDS) {
    const distance = editDistance(name.toLowerCase(), command.name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = command.name;
    }
  }
  return best;
}

/**
 * The one unknown-command answer all three faces give (spec §7): a system receipt, a closest-command
 * hint, and never a fall-through to the model. Three faces used to answer three different ways —
 * the terminal refused, the resident returned bare text, the TUI forwarded and swallowed it.
 */
export function unknownCommandReply(name: string): CommandReply {
  const nearest = nearestCommand(name);
  const hint = nearest === undefined ? '没有相近的核心命令。' : `最接近的核心命令：/${nearest}。`;
  return { text: `unknown command: /${name} 不是命令；${hint}用 / 打开命令面板。`, receipt: true };
}

/** ISO 8601 (`2026-11-01`, `2026-11-01T12:00:00Z`) or a 13-digit epoch-millisecond integer. */
function parseInstant(text: string): number | undefined {
  if (/^\d{13}$/u.test(text)) return Number(text);
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Two-row Levenshtein; the longest core name is nine characters, so this is not a hot path. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

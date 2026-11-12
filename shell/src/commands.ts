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

export type CommandSurface = 'palette' | 'resident' | 'tui';

export interface CommandReply {
  text: string;
  data?: Record<string, unknown>;
}

/** Everything a handler may ask of the shell; `CompanionShell` provides it as `commandHost`. */
export interface CommandHost {
  config(): { dbPath: string; agentId: string; contextSweetSpot: number };
  lifecycle(): { state: string; seq: number; costDayTokens: number };
  contextTokens(): number;
  lastDream(): { localDate: string; eventCount: number; summary: string } | undefined;
  commitments(): Array<{ candidateId: string; title: string; status: string; updatedAt: number }>;
  whyReport(): string;
  capturePaused(): boolean;
  setCapturePaused(paused: boolean): void;
  sessionModel(): string;
  modelRoutes(): string[];
  modelRouter(): { active: string; lines: string[]; storeError?: string } | undefined;
  switchRoute(name: string): { ok: true; name: string; model: string } | { ok: false; message: string };
  sleep(): Promise<void>;
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
      // Read back what the installer wrote. F17's editor is the star sea's job; until then the
      // v0 row is what the resident can show, and showing it beats claiming it is not there.
      const { dbPath, agentId } = host.config();
      const row = readSoul(dbPath, agentId);
      if (!row) return { text: `soul 尚未写入。当前身份 ${agentId}。` };
      const bytes = Buffer.byteLength(row.content);
      return {
        text: `soul v${row.version}（${bytes} 字节）：${row.content.split('\n')[0]}`,
        data: { companion_soul: { version: row.version, bytes, agentId: row.agentId } },
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
    name: 'status',
    description: '健康状态页',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      const { state, seq, costDayTokens } = host.lifecycle();
      return { text: `生命周期 ${state}，checkpoint seq ${seq}，本日 ${costDayTokens} token。` };
    },
  },
  {
    name: 'context',
    description: '上下文车道构成',
    surfaces: ['palette', 'resident', 'tui'],
    run: (host) => ({ text: `当前组装上下文约 ${host.contextTokens()} token（甜点带宽 ${host.config().contextSweetSpot}）。本壳未接入 F14 车道控制器。` }),
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
      if (host.capturePaused()) return { text: '已在暂停捕获中：此刻壳不把会话内容写进内核。/resume 恢复。' };
      // The write is the receipt's precondition: if the checkpoint write fails the machine halts
      // and this never claims a pause that the next process would not know about.
      host.setCapturePaused(true);
      return { text: '已暂停捕获：壳不再把新的会话内容写进内核。这个状态随 checkpoint 持久化，重启后仍是暂停；/resume 恢复。' };
    },
  },
  {
    name: 'resume',
    description: '恢复捕获（/pause 之后）',
    surfaces: ['palette', 'resident', 'tui'],
    run(host) {
      if (!host.capturePaused()) return { text: '捕获本来就在进行中，没有需要恢复的暂停。' };
      host.setCapturePaused(false);
      return { text: '已恢复捕获：接下来的回合会照常写进内核。' };
    },
  },
  {
    name: 'why',
    description: '看最近一次召回决策痕迹（只读）',
    surfaces: ['palette', 'resident', 'tui'],
    run: (host) => ({ text: host.whyReport() }),
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
    run: () => ({ text: 'Enter 发送 · Shift+Enter 换行 · / 命令面板 · Esc 撤回排队消息 · /exit 断开附着 · /sleep 进 DORMANT' }),
  },
  {
    name: 'exit',
    description: '断开附着（常驻进程继续）',
    // The TUI detaches itself; there is nothing for the resident to answer.
    surfaces: ['palette', 'tui'],
    run: () => ({ text: '断开附着。常驻进程继续运行。' }),
  },
];

/** The table entry a face is allowed to dispatch, or `undefined` for "not my command". */
export function coreCommandFor(name: string, surface: CommandSurface): CoreCommand | undefined {
  return CORE_COMMANDS.find((command) => command.name === name && command.surfaces.includes(surface));
}

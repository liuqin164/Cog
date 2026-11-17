/**
 * Shell configuration. Every value here is deterministic runtime policy; no model decides it.
 *
 * The model endpoint is the mg gateway (magpie) that the box already runs: one OpenAI-compatible
 * base URL, model id `auto/deepseek-v4.1-flash`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPluginRegistry } from './plugins/registry.ts';
import { DEFAULT_MAX_IDLE_TURNS } from './state/agent-loop.ts';

export { DEFAULT_MAX_IDLE_TURNS };

export interface RunBudget {
  maxTurnsPerRun: number;
  maxTokensPerRun: number;
}

/** The day's aggregate ceiling. One counter for every tier, so autonomy cannot add up past it. */
export interface DailyBudget {
  maxTokensPerDay: number;
}

/** The night's model-call ceiling. It is charged to the same day counter, not a second ledger. */
export interface NightBudget {
  maxTokensPerNight: number;
}

export interface ShellConfig {
  /** Working directory the read/write/edit/bash tools are caged to. */
  workspaceRoot: string;
  /** Cogmem project id every write is stamped with. */
  projectId: string;
  /** The companion's own agent identity, used as `metadata.sourceAgent` on every write. */
  agentId: string;
  /** Session id for this install; stable across restarts so the session lane survives a kill. */
  sessionId: string;
  /** Cogmem database file. `:memory:` is supported for tests. */
  dbPath: string;
  /** Shell runtime state (checkpoint, lock, event log, probes). */
  dataDir: string;
  /** IANA time zone for the time context and the dream window. */
  timeZone: string;
  model: { baseUrl: string; apiKey: string; model: string; timeoutMs: number };
  /**
   * The built-in route's context sweet spot (spec §6's "甜点带宽"). C3 (#258) fills the per-model
   * value into a route; until then this is the fallback every route without a `targetTokens` uses.
   * The current 6_000 is provisional, not a validated constant: #258 measured a flat curve through
   * 48k for `auto/deepseek-v4.1-flash` and is waiting on a second model and a coverage arm. The
   * unit is the assembler's `ceil(chars / 4)` estimate, not the provider's token count.
   */
  contextSweetSpot: number;
  /** Recent turns kept verbatim in every request's tail lane (#245). */
  tailTurns: number;
  /** The tight cage: pure autonomous runs (emergence, idle checks, dreams) and the fallback. */
  budgets: RunBudget & { toolWhitelist: string[] | null };
  /**
   * The work cage: a user-assigned run, or an autonomous wake continuing one. Kept beside `budgets`
   * because the tool whitelist is shared and only the two numeric limits differ.
   */
  workBudget: RunBudget;
  /**
   * The day's token ceiling (#233), counted across both tiers on the same configured-zone day
   * (#285) as #229's emergence cap. Reaching it stops autonomous runs; a user who is present is
   * told, and their own instruction still runs under the per-run cage.
   */
  dailyBudget: DailyBudget;
  /**
   * The Dream model's nightly ceiling (#231 route A). Dream is not a caged run: its calls never pass
   * through the agent loop, so this cap is checked at the model-call seam and charged to
   * `costDayTokens` like every other token the resident spends.
   */
  nightBudget: NightBudget;
  /**
   * Consecutive turns without user-visible text or a new tool result before the run stops (#241).
   * Top-level because it is a progress floor, not a per-tier allowance.
   */
  maxIdleTurns: number;
  dream: { windowStartHour: number; windowEndHour: number; runKernelNight: boolean; maxEpisodes: number };
  idleWakeIntervalMs: number;
  /** Tick interval for due intents/dream/emergence. Deterministic; tests drive ticks directly. */
  tickIntervalMs: number;
  /**
   * The resident's loopback HTTP face: status and the read-only observatory, and nothing else. It
   * carried an MCP endpoint until #200 R2 removed the shell's outward MCP face.
   */
  http: { enabled: boolean; port: number; hostname: string };
  /** Native plugin specs read from `<dataDir>/plugins.json` at startup. */
  plugins: string[];
  terminalEnabled: boolean;
  /**
   * The control socket the `cog` TUI attaches to. Off by default (a plain `start` is still the
   * line-mode resident); `cog` starts the resident with `--attach`, and tests opt in explicitly.
   */
  attach: { enabled: boolean; socketPath?: string };
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** `COGMEM_SHELL_TAIL_TURNS` is operator policy; a non-integer is a startup error, not a silent 8. */
function tailTurnsFromEnv(): number {
  const raw = env('COGMEM_SHELL_TAIL_TURNS');
  if (raw === undefined) return 8;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid_tail_turns: COGMEM_SHELL_TAIL_TURNS=${raw}`);
  return value;
}

/**
 * `<dataDir>/budgets.json`, the operating copy beside the rhythm env file. Both tiers are optional:
 * a missing file or missing tier falls back to the source defaults. A file that exists but cannot
 * be understood is a startup error, not a silent fallback — a user who edited a number must not be
 * left believing it applied.
 */
function readBudgetConfig(dataDir: string): { work?: Partial<RunBudget>; autonomous?: Partial<RunBudget>; daily?: Partial<DailyBudget>; night?: Partial<NightBudget>; maxIdleTurns?: number } {
  const path = join(dataDir, 'budgets.json');
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid_budgets_config: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid_budgets_config: ${path}: expected an object`);
  const record = parsed as Record<string, unknown>;
  return {
    ...(record.work === undefined ? {} : { work: budgetTier(record.work, path, 'work') }),
    ...(record.autonomous === undefined ? {} : { autonomous: budgetTier(record.autonomous, path, 'autonomous') }),
    ...(record.maxTokensPerDay === undefined ? {} : { daily: dailyBudget(record.maxTokensPerDay, path) }),
    ...(record.maxTokensPerNight === undefined ? {} : { night: nightBudget(record.maxTokensPerNight, path) }),
    ...(record.maxIdleTurns === undefined ? {} : { maxIdleTurns: positiveInteger(record.maxIdleTurns, path, 'maxIdleTurns') }),
  };
}

function positiveInteger(value: unknown, path: string, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_budgets_config: ${path}: ${name} must be a positive integer`);
  }
  return value;
}

function dailyBudget(value: unknown, path: string): Partial<DailyBudget> {
  return { maxTokensPerDay: positiveInteger(value, path, 'maxTokensPerDay') };
}

function nightBudget(value: unknown, path: string): Partial<NightBudget> {
  return { maxTokensPerNight: positiveInteger(value, path, 'maxTokensPerNight') };
}

function budgetTier(value: unknown, path: string, name: string): Partial<RunBudget> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_budgets_config: ${path}: ${name} must be an object`);
  const record = value as Record<string, unknown>;
  const out: Partial<RunBudget> = {};
  for (const key of ['maxTurnsPerRun', 'maxTokensPerRun'] as const) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      throw new Error(`invalid_budgets_config: ${path}: ${name}.${key} must be a positive integer`);
    }
    out[key] = raw;
  }
  return out;
}

export const DEFAULT_AUTONOMOUS_BUDGET: RunBudget = { maxTurnsPerRun: 6, maxTokensPerRun: 20_000 };
export const DEFAULT_WORK_BUDGET: RunBudget = { maxTurnsPerRun: 32, maxTokensPerRun: 400_000 };
/**
 * Five full work runs. The autonomous baseline (eight emergence runs at the tight 20k cap) is
 * about 160k, so a normal day sits far below this; a runaway loop crosses it after ~100 tight runs
 * instead of burning the month.
 */
export const DEFAULT_DAILY_BUDGET: DailyBudget = { maxTokensPerDay: 2_000_000 };
/**
 * A night is 25 episodes at the default cap, each paying for a frame and a candidate pass. The
 * 200k ceiling leaves room for that while keeping one bad night from spending a fifth of the day.
 */
export const DEFAULT_NIGHT_BUDGET: NightBudget = { maxTokensPerNight: 200_000 };

/** The installer's default home. Its `install.json` is the fact that a companion is installed. */
function installedCompanion(): { dataDir: string; choices: Record<string, unknown> } | undefined {
  const dataDir = join(homedir(), '.cogmem', 'companion');
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'install.json'), 'utf8')) as { choices?: Record<string, unknown> };
    return { dataDir, choices: state.choices ?? {} };
  } catch {
    return undefined;
  }
}

export function defaultShellConfig(overrides: Partial<ShellConfig> = {}): ShellConfig {
  const explicitData = overrides.dataDir ?? env('COGMEM_SHELL_DATA');
  const installed = explicitData ? undefined : installedCompanion();
  const choices = installed?.choices ?? {};
  const workspaceRoot = overrides.workspaceRoot ?? env('COGMEM_SHELL_WORKSPACE') ?? (typeof choices.workspaceRoot === 'string' ? choices.workspaceRoot : undefined) ?? process.cwd();
  const dataDir = explicitData ?? installed?.dataDir ?? `${workspaceRoot}/.cogmem-shell`;
  const operating = readBudgetConfig(dataDir);
  const autonomous: RunBudget = { ...DEFAULT_AUTONOMOUS_BUDGET, ...operating.autonomous };
  const work: RunBudget = { ...DEFAULT_WORK_BUDGET, ...operating.work };
  const daily: DailyBudget = { ...DEFAULT_DAILY_BUDGET, ...operating.daily };
  const night: NightBudget = { ...DEFAULT_NIGHT_BUDGET, ...operating.night };
  const maxIdleTurns = overrides.maxIdleTurns ?? operating.maxIdleTurns ?? DEFAULT_MAX_IDLE_TURNS;
  // The registry is read here, once, so a plugin registered by `/plugins add` reaches the next
  // process and nothing re-reads the file mid-run. A corrupt file is a startup error (see registry).
  const registryPlugins = readPluginRegistry(dataDir);
  return {
    workspaceRoot,
    projectId: overrides.projectId ?? env('COGMEM_SHELL_PROJECT') ?? (typeof choices.projectId === 'string' ? choices.projectId : undefined) ?? 'companion',
    agentId: overrides.agentId ?? env('COGMEM_SHELL_AGENT') ?? (typeof choices.agentId === 'string' ? choices.agentId : undefined) ?? 'cogmem-companion',
    // The installer writes this once per install and never overwrites it. A hand-run shell that was
    // never installed keeps one fixed id instead of minting a new lane each process start.
    sessionId: overrides.sessionId ?? env('COGMEM_SHELL_SESSION') ?? 'session-default',
    dbPath: overrides.dbPath ?? env('COGMEM_SHELL_DB') ?? `${dataDir}/memory.sqlite`,
    dataDir,
    timeZone: overrides.timeZone ?? env('COGMEM_SHELL_TZ') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    model: overrides.model ?? {
      baseUrl: env('MG_BASE_URL') ?? 'http://127.0.0.1:3425/v1',
      apiKey: env('MG_API_KEY') ?? 'magpie',
      model: env('MG_MODEL') ?? 'auto/deepseek-v4.1-flash',
      timeoutMs: 120_000,
    },
    // `propose_command` and `propose_soul_edit` are on the default whitelist because they are how
    // the agent offers the user a command or a soul draft; leaving them off would make every offer a
    // cage violation. The workflow tools are the same shape: `list_workflows` presents the book,
    // `propose_workflow` offers a draft, and `veto_workflow` records the owner's refusal.
    budgets: overrides.budgets ?? {
      ...autonomous,
      // cage violation. The workflow tools are the same shape: `list_workflows` presents the book,
      // `propose_workflow` offers a draft, and `veto_workflow` records the owner's refusal.
      toolWhitelist: ['read', 'write', 'edit', 'bash', 'propose_command', 'propose_soul_edit', 'propose_self_change', 'apply_self_change', 'ask_user', 'declare_task', 'web_search', 'web_fetch', 'web_recall', 'list_workflows', 'propose_workflow', 'veto_workflow'],
    },
    workBudget: overrides.workBudget ?? work,
    dailyBudget: overrides.dailyBudget ?? daily,
    nightBudget: overrides.nightBudget ?? night,
    maxIdleTurns,
    contextSweetSpot: overrides.contextSweetSpot ?? 6_000,
    tailTurns: overrides.tailTurns ?? tailTurnsFromEnv(),
    // The install's rhythm step is what fills these; the literals stay the fallback for a hand-run
    // shell that was never installed.
    dream: overrides.dream ?? {
      windowStartHour: Number(env('COGMEM_SHELL_DREAM_START') ?? 2),
      windowEndHour: Number(env('COGMEM_SHELL_DREAM_END') ?? 5),
      runKernelNight: env('COGMEM_SHELL_DREAM_KERNEL') !== 'off',
      maxEpisodes: Number(env('COGMEM_SHELL_DREAM_MAX_EPISODES') ?? 25),
    },
    idleWakeIntervalMs: overrides.idleWakeIntervalMs ?? 30 * 60_000,
    tickIntervalMs: overrides.tickIntervalMs ?? 30_000,
    http: overrides.http ?? {
      enabled: env('COGMEM_SHELL_HTTP') !== 'off',
      port: Number(env('COGMEM_SHELL_HTTP_PORT') ?? (typeof choices.httpPort === 'number' ? choices.httpPort : undefined) ?? 7338),
      hostname: '127.0.0.1',
    },
    plugins: overrides.plugins ?? registryPlugins,
    terminalEnabled: overrides.terminalEnabled ?? env('COGMEM_SHELL_TERMINAL') !== 'off',
    attach: overrides.attach ?? {
      enabled: env('COGMEM_SHELL_ATTACH') === 'on',
      socketPath: env('COGMEM_SHELL_ATTACH_SOCKET'),
    },
  };
}

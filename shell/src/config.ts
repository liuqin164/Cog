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
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_QUERY_PREFIX,
  REMOTE_EMBEDDING_DEFAULTS,
  type EmbeddingConfig,
} from './embedding/model.ts';

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
   * The curve is flat through 48k for `auto/deepseek-v4.1-flash`; a second model and a coverage arm
   * are still open.
   *
   * The unit changed in #318 from `ceil(chars / 4)` to the assembler's character-class estimate
   * (ASCII 0.25 token/char, non-ASCII 0.64). The old 6_000 fit ~24,000 characters of the sweet-spot
   * corpus and the provider charged ~13,355 prompt tokens for them; 6_000 in the new unit fits only
   * ~12,400 characters (~6,700 provider tokens), roughly half. 10_800 is the new-unit value that
   * keeps the measured ~13,400-provider-token budget on that corpus, so the number moved with the
   * ruler instead of the budget shrinking.
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
  /** The owner's do-not-disturb window; proactive speech waits for it to close. */
  quiet?: { startHour: number; endHour: number };
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
   * The vector provider (#313). The default is the local bge model and its bge-zh query prefix;
   * remote providers default to an empty prefix because that instruction is model-specific.
   */
  embedding: EmbeddingConfig;
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

/** The query prefix is the one value where an explicit empty string means "none". */
function envAllowEmpty(name: string): string | undefined {
  return process.env[name];
}

/** `COG_TAIL_TURNS` is operator policy; a non-integer is a startup error, not a silent 8. */
function tailTurnsFromEnv(): number {
  const raw = env('COG_TAIL_TURNS');
  if (raw === undefined) return 8;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid_tail_turns: COG_TAIL_TURNS=${raw}`);
  return value;
}

/**
 * The installer writes these to the 0600 env file; the service's EnvironmentFile supplies them.
 * An unknown provider or a missing remote model is a startup error, not a silent local fallback.
 */
function embeddingFromEnv(): EmbeddingConfig {
  const raw = env('COGMEM_EMBEDDING_PROVIDER');
  if (raw === undefined || raw === 'local') {
    return {
      provider: 'local',
      baseUrl: '',
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      queryPrefix: envAllowEmpty('COGMEM_EMBEDDING_QUERY_PREFIX') ?? EMBEDDING_QUERY_PREFIX,
    };
  }
  if (raw !== 'ollama' && raw !== 'openai') {
    throw new Error(`invalid_embedding_provider: COGMEM_EMBEDDING_PROVIDER=${raw}; expected local, ollama or openai`);
  }
  const defaults = REMOTE_EMBEDDING_DEFAULTS[raw];
  const model = env('COGMEM_EMBEDDING_MODEL');
  if (model === undefined) throw new Error('invalid_embedding_config: COGMEM_EMBEDDING_MODEL is required for a remote provider');
  const dimensions = embeddingDimensionsFromEnv();
  return {
    provider: raw,
    baseUrl: env('COGMEM_EMBEDDING_BASE_URL') ?? defaults.baseUrl,
    model,
    ...(dimensions === undefined ? {} : { dimensions }),
    queryPrefix: envAllowEmpty('COGMEM_EMBEDDING_QUERY_PREFIX') ?? '',
  };
}

function embeddingDimensionsFromEnv(): number | undefined {
  const raw = env('COGMEM_EMBEDDING_DIMENSIONS');
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_embedding_dimensions: COGMEM_EMBEDDING_DIMENSIONS=${raw}`);
  }
  return value;
}

function quietFromEnv(): ShellConfig['quiet'] {
  const start = env('COG_QUIET_START');
  const end = env('COG_QUIET_END');
  if (start === undefined && end === undefined) return undefined;
  const startHour = Number(start);
  const endHour = Number(end);
  if (
    start === undefined || end === undefined
    || !Number.isInteger(startHour) || startHour < 0 || startHour > 23
    || !Number.isInteger(endHour) || endHour < 0 || endHour > 23
    || startHour === endHour
  ) {
    throw new Error(`invalid_quiet_window: COG_QUIET_START=${start ?? ''} COG_QUIET_END=${end ?? ''}; both hours are required, 0-23, and must differ`);
  }
  return { startHour, endHour };
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
  const explicitData = overrides.dataDir ?? env('COG_DATA');
  const installed = explicitData ? undefined : installedCompanion();
  const choices = installed?.choices ?? {};
  const workspaceRoot = overrides.workspaceRoot ?? env('COG_WORKSPACE') ?? (typeof choices.workspaceRoot === 'string' ? choices.workspaceRoot : undefined) ?? process.cwd();
  const dataDir = explicitData ?? installed?.dataDir ?? `${workspaceRoot}/.cogmem-shell`;
  const operating = readBudgetConfig(dataDir);
  const autonomous: RunBudget = { ...DEFAULT_AUTONOMOUS_BUDGET, ...operating.autonomous };
  const work: RunBudget = { ...DEFAULT_WORK_BUDGET, ...operating.work };
  const daily: DailyBudget = { ...DEFAULT_DAILY_BUDGET, ...operating.daily };
  const night: NightBudget = { ...DEFAULT_NIGHT_BUDGET, ...operating.night };
  const maxIdleTurns = overrides.maxIdleTurns ?? operating.maxIdleTurns ?? DEFAULT_MAX_IDLE_TURNS;
  const dream = overrides.dream ?? {
    windowStartHour: Number(env('COG_DREAM_START') ?? 2),
    windowEndHour: Number(env('COG_DREAM_END') ?? 5),
    runKernelNight: env('COG_DREAM_KERNEL') !== 'off',
    maxEpisodes: Number(env('COG_DREAM_MAX_EPISODES') ?? 25),
  };
  if (dream.windowStartHour === dream.windowEndHour) {
    throw new Error(`invalid_dream_window: start ${dream.windowStartHour} equals end ${dream.windowEndHour}; a zero-length window never runs Dream`);
  }
  // The registry is read here, once, so a plugin registered by `/plugins add` reaches the next
  // process and nothing re-reads the file mid-run. A corrupt file is a startup error (see registry).
  const registryPlugins = readPluginRegistry(dataDir);
  return {
    workspaceRoot,
    projectId: overrides.projectId ?? env('COG_PROJECT') ?? (typeof choices.projectId === 'string' ? choices.projectId : undefined) ?? 'companion',
    agentId: overrides.agentId ?? env('COG_AGENT') ?? (typeof choices.agentId === 'string' ? choices.agentId : undefined) ?? 'cogmem-companion',
    // The installer writes this once per install and never overwrites it. A hand-run shell that was
    // never installed keeps one fixed id instead of minting a new lane each process start.
    sessionId: overrides.sessionId ?? env('COG_SESSION') ?? 'session-default',
    dbPath: overrides.dbPath ?? env('COG_DB') ?? `${dataDir}/memory.sqlite`,
    dataDir,
    timeZone: overrides.timeZone ?? env('COG_TZ') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    model: overrides.model ?? {
      baseUrl: env('MG_BASE_URL') ?? 'http://127.0.0.1:3425/v1',
      apiKey: env('MG_API_KEY') ?? 'magpie',
      model: env('MG_MODEL') ?? 'auto/deepseek-v4.1-flash',
      timeoutMs: 120_000,
    },
    budgets: overrides.budgets ?? {
      ...autonomous,
      // The web plugin is opt-in; it adds its three names when its spec is registered (#338).
      toolWhitelist: ['read', 'write', 'edit', 'bash', 'propose_command', 'request_credential', 'propose_soul_edit', 'propose_plugin', 'plugin_proposal_status', 'installed_plugins', 'ask_user', 'declare_task', 'memory'],
    },
    workBudget: overrides.workBudget ?? work,
    dailyBudget: overrides.dailyBudget ?? daily,
    nightBudget: overrides.nightBudget ?? night,
    maxIdleTurns,
    quiet: overrides.quiet ?? quietFromEnv(),
    contextSweetSpot: overrides.contextSweetSpot ?? 10_800,
    tailTurns: overrides.tailTurns ?? tailTurnsFromEnv(),
    dream,
    idleWakeIntervalMs: overrides.idleWakeIntervalMs ?? 30 * 60_000,
    tickIntervalMs: overrides.tickIntervalMs ?? 30_000,
    http: overrides.http ?? {
      enabled: env('COG_HTTP') !== 'off',
      port: Number(env('COG_HTTP_PORT') ?? (typeof choices.httpPort === 'number' ? choices.httpPort : undefined) ?? 7338),
      hostname: '127.0.0.1',
    },
    plugins: overrides.plugins ?? registryPlugins,
    terminalEnabled: overrides.terminalEnabled ?? env('COG_TERMINAL') !== 'off',
    embedding: overrides.embedding ?? embeddingFromEnv(),
    attach: overrides.attach ?? {
      enabled: env('COG_ATTACH') === 'on',
      socketPath: env('COG_ATTACH_SOCKET'),
    },
  };
}

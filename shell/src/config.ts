/**
 * Shell configuration. Every value here is deterministic runtime policy; no model decides it.
 *
 * The model endpoint is the mg gateway (magpie) that the box already runs: one OpenAI-compatible
 * base URL, model id `auto/deepseek-v4.1-flash`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPluginRegistry } from './plugins/registry.ts';

export interface RunBudget {
  maxTurnsPerRun: number;
  maxTokensPerRun: number;
}

export interface ShellConfig {
  /** Working directory the read/write/edit/bash tools are caged to. */
  workspaceRoot: string;
  /** Cogmem project id every write is stamped with. */
  projectId: string;
  /** The companion's own agent identity, used as `metadata.sourceAgent` on every write. */
  agentId: string;
  /** Session id for this process; a restart gets a new one (the day thread is the durable one). */
  sessionId: string;
  /** Cogmem database file. `:memory:` is supported for tests. */
  dbPath: string;
  /** Shell runtime state (checkpoint, lock, event log, probes). */
  dataDir: string;
  /** IANA time zone for the time context and the dream window. */
  timeZone: string;
  model: { baseUrl: string; apiKey: string; model: string; timeoutMs: number };
  /** The context bandwidth gauge's denominator (spec §6's "甜点带宽"); F14 has no controller yet. */
  contextSweetSpot: number;
  /** The tight cage: pure autonomous runs (emergence, idle checks, dreams) and the fallback. */
  budgets: RunBudget & { toolWhitelist: string[] | null };
  /**
   * The work cage: a user-assigned run, or an autonomous wake continuing one. Kept beside `budgets`
   * because the tool whitelist is shared and only the two numeric limits differ.
   */
  workBudget: RunBudget;
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

/**
 * `<dataDir>/budgets.json`, the operating copy beside the rhythm env file. Both tiers are optional:
 * a missing file or missing tier falls back to the source defaults. A file that exists but cannot
 * be understood is a startup error, not a silent fallback — a user who edited a number must not be
 * left believing it applied.
 */
function readBudgetConfig(dataDir: string): { work?: Partial<RunBudget>; autonomous?: Partial<RunBudget> } {
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
  };
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

export function defaultShellConfig(overrides: Partial<ShellConfig> = {}): ShellConfig {
  const workspaceRoot = overrides.workspaceRoot ?? env('COGMEM_SHELL_WORKSPACE') ?? process.cwd();
  const dataDir = overrides.dataDir ?? env('COGMEM_SHELL_DATA') ?? `${workspaceRoot}/.cogmem-shell`;
  const operating = readBudgetConfig(dataDir);
  const autonomous: RunBudget = { ...DEFAULT_AUTONOMOUS_BUDGET, ...operating.autonomous };
  const work: RunBudget = { ...DEFAULT_WORK_BUDGET, ...operating.work };
  // The registry is read here, once, so a plugin registered by `/plugins add` reaches the next
  // process and nothing re-reads the file mid-run. A corrupt file is a startup error (see registry).
  const registryPlugins = readPluginRegistry(dataDir);
  return {
    workspaceRoot,
    projectId: overrides.projectId ?? env('COGMEM_SHELL_PROJECT') ?? 'companion',
    agentId: overrides.agentId ?? env('COGMEM_SHELL_AGENT') ?? 'cogmem-companion',
    sessionId: overrides.sessionId ?? env('COGMEM_SHELL_SESSION') ?? `session-${Date.now().toString(36)}`,
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
      toolWhitelist: ['read', 'write', 'edit', 'bash', 'propose_command', 'propose_soul_edit', 'ask_user', 'web_search', 'web_fetch', 'web_recall', 'list_workflows', 'propose_workflow', 'veto_workflow'],
    },
    workBudget: overrides.workBudget ?? work,
    contextSweetSpot: overrides.contextSweetSpot ?? 6_000,
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
      port: Number(env('COGMEM_SHELL_HTTP_PORT') ?? 7338),
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

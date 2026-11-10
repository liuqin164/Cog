/**
 * Shell configuration. Every value here is deterministic runtime policy; no model decides it.
 *
 * The model endpoint is the mg gateway (magpie) that the box already runs: one OpenAI-compatible
 * base URL, model id `auto/deepseek-v4.1-flash`.
 */
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
  budgets: { maxTurnsPerRun: number; maxTokensPerRun: number; toolWhitelist: string[] | null };
  dream: { windowStartHour: number; windowEndHour: number; runKernelNight: boolean; maxEpisodes: number };
  idleWakeIntervalMs: number;
  /** Tick interval for due intents/dream/emergence. Deterministic; tests drive ticks directly. */
  tickIntervalMs: number;
  mcp: { enabled: boolean; port: number; hostname: string; path: string; profile: 'core' | 'admin' | 'full' };
  pi: { adapterEnabled: boolean; plugins: string[] };
  terminalEnabled: boolean;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function defaultShellConfig(overrides: Partial<ShellConfig> = {}): ShellConfig {
  const workspaceRoot = overrides.workspaceRoot ?? env('COGMEM_SHELL_WORKSPACE') ?? process.cwd();
  const dataDir = overrides.dataDir ?? env('COGMEM_SHELL_DATA') ?? `${workspaceRoot}/.cogmem-shell`;
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
    budgets: overrides.budgets ?? { maxTurnsPerRun: 6, maxTokensPerRun: 20_000, toolWhitelist: ['read', 'write', 'edit', 'bash'] },
    dream: overrides.dream ?? { windowStartHour: 2, windowEndHour: 5, runKernelNight: true, maxEpisodes: 25 },
    idleWakeIntervalMs: overrides.idleWakeIntervalMs ?? 30 * 60_000,
    tickIntervalMs: overrides.tickIntervalMs ?? 30_000,
    mcp: overrides.mcp ?? {
      enabled: env('COGMEM_SHELL_MCP') !== 'off',
      port: Number(env('COGMEM_SHELL_MCP_PORT') ?? 7338),
      hostname: '127.0.0.1',
      path: '/mcp',
      profile: 'core',
    },
    pi: overrides.pi ?? {
      adapterEnabled: env('COGMEM_SHELL_PI_ADAPTER') !== 'off',
      plugins: (env('COGMEM_SHELL_PI_PLUGINS') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    },
    terminalEnabled: overrides.terminalEnabled ?? env('COGMEM_SHELL_TERMINAL') !== 'off',
  };
}

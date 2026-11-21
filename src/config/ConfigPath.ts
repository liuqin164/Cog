import { statSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Where a config lives, and nothing else.
 *
 * This is split out of `CogmemConfig.ts` because the CLI dispatcher has to know
 * whether `[update] check` is off before it decides to start a version check, and
 * loading the config module for one boolean pulls in the kernel, the model
 * registry and the encryption provider — measured on this machine, `cogmem
 * --version` went from 30 ms to 70 ms. The resolution itself is four file-system
 * calls, so it lives where a hot path can afford it, and `CogmemConfig` re-exports
 * it so every existing caller keeps its import (#150).
 */

export type EnvLike = Record<string, string | undefined>;

export type CogmemConfigKind = 'toml' | 'missing';

export interface CogmemConfigResolution {
  kind: CogmemConfigKind;
  path: string;
}

export interface CogmemConfigResolutionOptions {
  configPath?: string;
  cwd?: string;
  env?: EnvLike;
}

export function defaultCogmemHome(env: EnvLike = process.env): string {
  return join(env.HOME || homedir(), '.cogmem');
}

/**
 * The home of the account running this process, ignoring `$HOME`.
 *
 * Both `os.homedir()` and `os.userInfo()` honour `$HOME` on POSIX, so neither
 * can tell a test with an overridden HOME from the real user. The password
 * database can, which is what makes it usable as a boundary for the
 * project-config walk: a config under the account's home is a global config.
 */
function osUserHome(): string | undefined {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) return undefined;
  try {
    const passwd = readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const fields = line.split(':');
      if (fields.length < 6) continue;
      if (Number(fields[2]) !== uid) continue;
      return fields[5] || undefined;
    }
  } catch {
    // No passwd database (or not readable): fall back to no extra boundary.
  }
  return undefined;
}

export function defaultCogmemConfigPath(env: EnvLike = process.env): string {
  return join(defaultCogmemHome(env), 'config.toml');
}

interface CompanionInstall {
  dataDir: string;
  projectId?: string;
  agentId?: string;
}

function readCompanionInstall(env: EnvLike): CompanionInstall | undefined {
  const companionDir = join(defaultCogmemHome(env), 'companion');
  const installPath = join(companionDir, 'install.json');
  if (!existsSync(installPath)) return undefined;
  try {
    const state = JSON.parse(readFileSync(installPath, 'utf8')) as {
      choices?: { dataDir?: unknown; projectId?: unknown; agentId?: unknown };
    };
    const choices = state.choices;
    const dataDir = typeof choices?.dataDir === 'string' && choices.dataDir.trim()
      ? resolvePath(choices.dataDir, companionDir, env)
      : companionDir;
    const projectId = typeof choices?.projectId === 'string' && choices.projectId.trim()
      ? choices.projectId
      : undefined;
    const agentId = typeof choices?.agentId === 'string' && choices.agentId.trim()
      ? choices.agentId
      : undefined;
    return { dataDir, projectId, agentId };
  } catch {
    return undefined;
  }
}

export function companionCliConfigPath(env: EnvLike = process.env): string | undefined {
  const install = readCompanionInstall(env);
  return install ? join(install.dataDir, 'cogmem-cli.toml') : undefined;
}

export interface CompanionCliIdentity {
  projectId: string;
  agentId: string;
}

export function companionIdentityForConfig(configPath: string, env: EnvLike = process.env): CompanionCliIdentity | undefined {
  const expected = companionCliConfigPath(env);
  if (!expected || resolve(expected) !== resolve(configPath)) return undefined;
  const install = readCompanionInstall(env);
  return {
    projectId: install?.projectId ?? 'companion',
    agentId: install?.agentId ?? 'cogmem-companion',
  };
}

export function resolveCogmemConfigPath(options: CogmemConfigResolutionOptions = {}): CogmemConfigResolution {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const explicit = options.configPath;
  if (explicit?.trim()) {
    const path = resolvePath(explicit.trim(), cwd, env);
    // An explicit path that is not a readable file is not a config. Returning it as one let commands
    // that tolerate a missing config carry on against whatever database they found instead, and made
    // the ones that read the file fail with `invalid_toml: ENOENT` — a typo that looks like success or
    // like a malformed file, never like a typo.
    const isFile = existsSync(path) && (() => { try { return statSync(path).isFile(); } catch { return false; } })();
    return isFile ? { kind: 'toml', path } : { kind: 'missing', path };
  }

  // A resident companion sets this for its own tool processes: the CLI must resolve the companion's
  // database, not the operator's global or project config (#277).
  const fromEnv = env.COGMEM_CONFIG?.trim();
  if (fromEnv) {
    const path = resolvePath(fromEnv, cwd, env);
    const isFile = existsSync(path) && (() => { try { return statSync(path).isFile(); } catch { return false; } })();
    return isFile ? { kind: 'toml', path } : { kind: 'missing', path };
  }

  const globalConfig = defaultCogmemConfigPath(env);
  // The walk up for a project config stops at every home it could reach:
  // `<home>/.cogmem/config.toml` is that home's *global* config, never a project
  // one. Without the stop, a run with an overridden HOME adopts another user's
  // config, and any test that meant to isolate itself inherits the developer's.
  const projectConfig = findUp(cwd, join('.cogmem', 'config.toml'), [dirname(globalConfig), osUserHome()]);
  if (projectConfig) return { kind: 'toml', path: projectConfig };

  if (existsSync(globalConfig)) return { kind: 'toml', path: globalConfig };

  const companionConfig = companionCliConfigPath(env);
  if (companionConfig) {
    return existsSync(companionConfig) ? { kind: 'toml', path: companionConfig } : { kind: 'missing', path: companionConfig };
  }

  return { kind: 'missing', path: globalConfig };
}

export function findUp(start: string, relativePath: string, stopAt: Array<string | undefined> = []): string | undefined {
  const stops = new Set(stopAt.filter((entry): entry is string => Boolean(entry)).map((entry) => resolve(entry)));
  let current = resolve(start);
  while (true) {
    if (stops.has(current)) return undefined;
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolvePath(value: string, baseDir: string, env: EnvLike): string {
  const expanded = expandHome(value, env);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function expandHome(value: string, env: EnvLike): string {
  if (value === '~') return env.HOME || homedir();
  if (value.startsWith('~/')) return join(env.HOME || homedir(), value.slice(2));
  return value;
}

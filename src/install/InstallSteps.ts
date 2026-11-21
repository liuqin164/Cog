import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

import { cliArg } from '../utils/CliArgument.js';

/**
 * The Install actor vocabulary: who carries out one install step.
 * Defined once here so the installer, `init`, `doctor` and `update` all speak
 * the same three words. See ADR-0003.
 */
export type InstallActor = 'agent' | 'operator' | 'host';

/**
 * One install step: every step names exactly one actor, and only `agent` steps
 * may be `safeForAutomation`.
 */
export interface InstallStep {
  id: string;
  actor: InstallActor;
  safeForAutomation: boolean;
  command: string;
  when: string;
  purpose: string;
}

/** The four Install gate outcomes. `not_installed` is not a failure. */
export type InstallGateLevel = 'not_installed' | 'ok' | 'warn' | 'fail';

export interface InstallGateDiagnostic {
  code: string;
  message: string;
}

export interface InstallGate {
  level: InstallGateLevel;
  exitCode: 0 | 1;
  summary: string;
  diagnostics: InstallGateDiagnostic[];
  nextSteps: InstallStep[];
}

const EXIT_CODE: Record<InstallGateLevel, 0 | 1> = {
  not_installed: 0,
  ok: 0,
  warn: 0,
  fail: 1,
};

const SUMMARY: Record<InstallGateLevel, string> = {
  not_installed: 'not installed yet',
  ok: 'installed and working',
  warn: 'installed but degraded',
  fail: 'broken',
};

export function buildGate(
  level: InstallGateLevel,
  diagnostics: InstallGateDiagnostic[],
  nextSteps: InstallStep[],
): InstallGate {
  return {
    level,
    exitCode: EXIT_CODE[level],
    summary: SUMMARY[level],
    diagnostics,
    nextSteps,
  };
}

/**
 * The step that runs the Install gate.
 *
 * Defined once because it appears in more than one list, and the two copies had
 * already drifted apart in the one field that legitimately differs — when it is
 * run — while the rest must never diverge.
 */
export function installGateStep(bin: string, when = 'after the install'): InstallStep {
  return {
    id: 'install_gate',
    actor: 'agent',
    safeForAutomation: true,
    command: `${bin} doctor --json`,
    when,
    purpose: 'the Install gate: not installed, OK, WARN or FAIL, plus the next step',
  };
}

export function installPathSteps(bin: string): InstallStep[] {
  return [
    {
      id: 'companion_install',
      actor: 'operator',
      safeForAutomation: false,
      command: `${bin} install`,
      when: 'with a terminal available',
      purpose: 'the companion installer: preflight, place, model, rhythm, resident, awake',
    },
    installGateStep(bin),
  ];
}

/**
 * The directory the CLI is installed into, when it can be told apart from a
 * source checkout. `COGMEM_BIN_DIR` wins. The dispatcher may be invoked via a
 * symlink that Bun/Node resolves in `process.argv[1]`, so also match the
 * launched file against `cogmem` entries on PATH.
 */
export function resolveCliBinDir(
  argv1: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const override = env.COGMEM_BIN_DIR?.trim();
  if (override) return resolve(override);
  if (!argv1) return undefined;
  const script = resolve(argv1);
  const leaf = basename(script);
  // Only a launcher named for the CLI counts: a source checkout runs
  // `src/bin/doctor.ts`, which is not an installed layout.
  if (leaf !== 'cogmem' && !/^cogmem\.[cm]?js$/.test(leaf)) return undefined;
  const dir = dirname(script);
  const base = basename(dir);
  if ((base === 'bin' || base === '.bin') && leaf === 'cogmem') return dir;

  // The package's own dispatcher, `<pkg>/dist/bin/cogmem.js`. A user who ran the
  // one-line installer has the launcher in `<pkg parent>/.bin`, and that
  // directory is often not on PATH yet: Bun resolves the shim, so `argv[1]` is
  // this file rather than the launcher. Without this, the gate answered `ok` on a
  // machine where `cogmem` did not resolve at all — the silent success ADR-0003
  // forbids. A global npm install puts its launcher on PATH and the scan below
  // still handles it.
  if (base === 'bin') {
    const shimDir = join(dirname(dirname(dirname(dir))), '.bin');
    if (existsSync(join(shimDir, 'cogmem'))) return shimDir;
    // A **global** npm install keeps its shims in `<prefix>/bin`, not in a sibling
    // `node_modules/.bin`, so the branch above never fires for it. The script Bun
    // reports is `<prefix>/lib/node_modules/cogmem/dist/bin/cogmem.js`; walking up
    // four levels lands on `lib`, and the shim is beside it. Without this the
    // resolver gave up on an install that was sitting right there (#94).
    const above = dirname(dirname(dirname(dirname(dir))));
    const prefix = basename(above) === 'lib' ? dirname(above) : above;
    if (existsSync(join(prefix, 'bin', 'cogmem'))) return join(prefix, 'bin');
  }

  let launchedFile: string;
  try {
    launchedFile = realpathSync(script);
  } catch {
    return undefined;
  }
  for (const entry of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(resolve(entry), 'cogmem');
    if (!existsSync(candidate)) continue;
    try {
      if (realpathSync(candidate) === launchedFile) return resolve(entry);
    } catch {
      // Ignore an invalid PATH entry and continue looking for the launcher.
    }
  }
  return undefined;
}

/**
 * The managed launcher: one per user, at a path no installation owns.
 *
 * Configurations written from here point here and never at an installation. This
 * path does not move when the installation does — an npm prefix change, a moved
 * checkout, a different package manager and an upgrade all leave it valid —
 * because the installation is resolved when the launcher runs, not when it is
 * written.
 *
 * That is the whole difference from what #86, #94 and #96 were symptoms of: an
 * installation's absolute path was baked into the artifacts written from it, so
 * each of those moves broke the integration, and the answer each time was to
 * notice harder instead of to stop writing the path.
 */
export function cogmemLauncherDir(env: Record<string, string | undefined> = process.env): string {
  return env.COGMEM_LAUNCHER_DIR?.trim() || join(env.HOME || homedir(), '.cogmem', 'bin');
}

export function cogmemLauncherPath(env: Record<string, string | undefined> = process.env): string {
  return join(cogmemLauncherDir(env), 'cogmem');
}

export function cogmemLauncherRecordPath(env: Record<string, string | undefined> = process.env): string {
  return join(cogmemLauncherDir(env), 'cogmem.target');
}

export function hasCogmemLauncher(env: Record<string, string | undefined> = process.env): boolean {
  return existsSync(cogmemLauncherPath(env));
}

/** The recorded installation, when it still exists and can be executed. */
export function readCogmemLauncherTarget(env: Record<string, string | undefined> = process.env): string | undefined {
  const recorded = readCogmemLauncherRecord(env);
  if (!recorded || recorded === cogmemLauncherPath(env)) return undefined;
  return isExecutableFile(recorded) ? recorded : undefined;
}

function readCogmemLauncherRecord(env: Record<string, string | undefined>): string | undefined {
  try {
    return readFileSync(cogmemLauncherRecordPath(env), 'utf8').split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * How to invoke this CLI in a command that is about to be printed into a
 * configuration.
 *
 * The absolute launcher when the CLI is installed but its directory is not on
 * `PATH`: a printed step that says `cogmem` on a machine where `cogmem` does not
 * resolve is a step that fails the moment it is pasted. The bare name when it
 * does resolve, so nothing bakes a machine-specific path into a config that
 * outlives this checkout (ADR-0010, #78).
 *
 * One function because four commands had four answers: `doctor` printed an
 * absolute path unconditionally, one printed a literal project-local
 * `.bin/cogmem` path that exists only in a JS project with a local dependency,
 * one printed the bin *directory*, and an integration wrote a bare `cogmem`
 * into a config on machines where it was not on `PATH`.
 */
export function resolveCogmemInvocation(
  env: Record<string, string | undefined> = process.env,
  argv1: string | undefined = process.argv[1],
): string {
  // An operator who names the binary means it, for the printed steps as much as
  // for a printed step. Honouring it here is what makes this *the* answer
  // rather than a fifth one that agrees only when nothing is set.
  const explicit = env.COGMEM_BIN?.trim();
  if (explicit) return explicit;
  // The managed launcher next, and before any path this installation owns: it is the
  // one entry that survives an upgrade, a moved checkout, a changed npm prefix and a
  // different package manager, which is exactly what a host configuration outlives
  // (#114). An operator who has no launcher gets the previous answer, unchanged.
  if (hasCogmemLauncher(env)) return cogmemLauncherPath(env);
  const installation = resolveCogmemInstallation(env, argv1);
  if (!installation) return 'cogmem';
  return isOnPath(dirname(installation), env) ? 'cogmem' : installation;
}

/**
 * The installed launcher this process is running from, when it is running from one.
 *
 * A source checkout run through `src/bin/*.ts` has none, and undefined is the honest
 * answer there: there is nothing for a host configuration to point at.
 */
export function resolveCogmemInstallation(
  env: Record<string, string | undefined> = process.env,
  argv1: string | undefined = process.argv[1],
): string | undefined {
  const binDir = resolveCliBinDir(argv1, env);
  if (!hasInstalledLauncher(binDir)) return undefined;
  return join(binDir, 'cogmem');
}

/**
 * Whether a directory actually holds the CLI launcher. One predicate because
 * "is this an installation" was being spelled out wherever it was asked.
 */
export function hasInstalledLauncher(binDir: string | undefined): binDir is string {
  return Boolean(binDir && existsSync(join(binDir, 'cogmem')));
}

export function isOnPath(dir: string, env: Record<string, string | undefined> = process.env): boolean {
  const pathValue = env.PATH ?? '';
  return pathValue.split(':').filter(Boolean).some((entry) => resolve(entry) === resolve(dir));
}

/**
 * The one wording for "the CLI is not on PATH", used by the installer and the
 * gate so a person and an agent are told the same thing.
 */
export function pathWarningSteps(binDir: string): InstallStep[] {
  return [
    {
      id: 'fix_path',
      actor: 'operator',
      safeForAutomation: false,
      command: `export PATH="${binDir}:$PATH"`,
      when: 'now, and in your shell profile if you want it to persist',
      purpose: 'put the cogmem CLI on PATH so `cogmem` resolves without an absolute path',
    },
    {
      id: 'use_absolute_bin',
      actor: 'agent',
      safeForAutomation: true,
      command: `${resolve(binDir)}/cogmem`,
      when: 'instead of fixing PATH',
      purpose: 'call the CLI by absolute path; do not depend on PATH being set',
    },
  ];
}

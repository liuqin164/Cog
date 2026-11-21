#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGate,
  cogmemLauncherPath,
  hasCogmemLauncher,
  hasInstalledLauncher,
  installPathSteps,
  isOnPath,
  pathWarningSteps,
  printJsonDocument,
  readCogmemLauncherTarget,
  resolveCliBinDir,
  resolveCogmemInvocation,
  type InstallGateDiagnostic,
  type InstallStep,
} from 'cogmem/internal';
import { defaultFetchHealth, runDoctor, type DoctorCheck } from './doctor.ts';
import { defaultShellHome } from './layout.ts';
import { defaultRunner, type Platform, type ServiceSpec } from './service.ts';

const USAGE = [
  'Usage: cogmem doctor [--data <dir>] [--json] [--out <path>]',
  '  --data <dir>  companion data directory (default ~/.cogmem/companion)',
  '  --out <path>  write the same JSON the command prints to a file',
].join('\n');

interface InstallState {
  schema: 1;
  done: string[];
  failedAt?: string;
  choices?: {
    dataDir?: string;
    workspaceRoot?: string;
    projectId?: string;
    agentId?: string;
    httpPort?: number;
    platform?: string;
    serviceName?: string;
  };
  pid?: number;
}

interface Options {
  dataDir?: string;
  json: boolean;
  help: boolean;
}

function usageError(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

function parse(argv: string[]): Options {
  const options: Options = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) usageError(`unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split('=');
    if (name === 'json') {
      if (inline !== undefined) usageError('--json takes no value');
      options.json = true;
      continue;
    }
    if (name === 'help') {
      options.help = true;
      continue;
    }
    if (name !== 'data' && name !== 'out') usageError(`unknown flag --${name}`);
    const value = inline ?? argv[index + 1];
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) {
      usageError(name === 'out' ? '--out needs a file path: `--out <path>` or `--out=<path>`' : '--data needs a directory');
    }
    if (inline === undefined) index += 1;
    if (name === 'data') options.dataDir = value;
  }
  return options;
}

function readState(path: string): InstallState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as InstallState;
    if (parsed.schema === 1 && Array.isArray(parsed.done)) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function checkDiagnostics(checks: DoctorCheck[]): InstallGateDiagnostic[] {
  return checks
    .filter((check) => check.warn || !check.ok)
    .map((check) => ({ code: check.id, message: check.detail }));
}

function gateLevel(checks: DoctorCheck[]): 'ok' | 'warn' | 'fail' {
  if (checks.some((check) => !check.ok && !check.warn)) return 'fail';
  if (checks.some((check) => check.warn)) return 'warn';
  return 'ok';
}

function pathDiagnostics(): { diagnostics: InstallGateDiagnostic[]; steps: InstallStep[] } {
  const binDir = resolveCliBinDir(process.argv[1], process.env);
  if (!hasInstalledLauncher(binDir) || isOnPath(binDir, process.env)) return { diagnostics: [], steps: [] };
  return {
    diagnostics: [{ code: 'cli_not_on_path', message: `the cogmem CLI at ${binDir} is not reachable as cogmem` }],
    steps: pathWarningSteps(binDir),
  };
}

function launcherDiagnostic(): InstallGateDiagnostic | undefined {
  return hasCogmemLauncher() && !readCogmemLauncherTarget()
    ? {
      code: 'launcher_target_missing',
      message: `The managed launcher ${cogmemLauncherPath()} has no installation to run. Delete it; this release does not write one.`,
    }
    : undefined;
}

function printChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    console.log(`${check.warn ? 'WARN' : check.ok ? 'OK  ' : 'FAIL'} ${check.id}: ${check.detail}`);
  }
}

function printSteps(steps: InstallStep[]): void {
  if (steps.length === 0) {
    console.log('');
    console.log('Next steps: none — nothing is outstanding.');
    return;
  }
  console.log('');
  console.log('Next steps:');
  for (const step of steps) {
    console.log(`  [${step.actor}] ${step.command}`);
    console.log(`      ${step.when} — ${step.purpose}`);
  }
}

function emit(payload: Record<string, unknown>, gate: ReturnType<typeof buildGate>, text: () => void, json: boolean): never {
  if (json) {
    printJsonDocument(JSON.stringify({
      schemaVersion: 'cogmem.cli.v1',
      command: 'doctor',
      ...payload,
      installGate: {
        level: gate.level,
        exitCode: gate.exitCode,
        summary: gate.summary,
        diagnostics: gate.diagnostics,
      },
      nextSteps: gate.nextSteps,
    }, null, 2));
  } else {
    text();
    console.log('');
    console.log(`Install gate: ${gate.level.toUpperCase()} — ${gate.summary}`);
    printSteps(gate.nextSteps);
  }
  process.exit(gate.exitCode);
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const homeDir = process.env.HOME || homedir();
  const dataDir = resolve(options.dataDir ?? join(homeDir, '.cogmem', 'companion'));
  const statePath = join(dataDir, 'install.json');
  const state = readState(statePath);
  const invocation = resolveCogmemInvocation(process.env, process.argv[1]);
  const path = pathDiagnostics();
  const launcher = launcherDiagnostic();
  const baseDiagnostics = [...path.diagnostics, ...(launcher ? [launcher] : [])];

  if (!state || !state.done.includes('resident') || !state.done.includes('awake')) {
    const reason = state === undefined
      ? `no companion install at ${statePath}`
      : `the install at ${statePath} has not finished${state.failedAt ? ` (stopped at ${state.failedAt})` : ''}`;
    const gate = buildGate('not_installed', [{ code: state ? 'incomplete_install' : 'missing_install', message: reason }, ...baseDiagnostics], [
      ...path.steps,
      ...installPathSteps(invocation),
    ]);
    const text = (): void => {
      if (!options.json) console.log(`cogmem companion is not installed yet (looked for ${statePath}).`);
    };
    emit({ dataDir, installState: state ? statePath : null, checks: [] }, gate, text, options.json);
  }

  const choices = state.choices ?? {};
  const platform: Platform = choices.platform === 'darwin' || (!choices.platform && process.platform === 'darwin') ? 'darwin' : 'linux';
  const serviceName = choices.serviceName ?? 'cogmem-companion';
  const spec: ServiceSpec = {
    serviceName,
    bunPath: process.execPath,
    shellDir: defaultShellHome(dirname(fileURLToPath(import.meta.url))),
    dataDir,
    workspaceRoot: choices.workspaceRoot ?? process.cwd(),
    projectId: choices.projectId ?? 'companion',
    agentId: choices.agentId ?? 'cogmem-companion',
    httpPort: choices.httpPort ?? 7338,
    envFile: join(dataDir, 'env'),
    logFile: join(dataDir, 'service.log'),
    homeDir,
    env: {},
  };
  const healthUrl = `http://127.0.0.1:${spec.httpPort}/health`;
  const report = await runDoctor({
    dataDir,
    dbPath: join(dataDir, 'memory.sqlite'),
    socketPath: join(dataDir, 'attach.sock'),
    healthUrl,
    fetchHealth: () => defaultFetchHealth(healthUrl),
    spec,
    platform,
    run: defaultRunner(),
    mode: state.pid ? 'process' : 'service',
    pid: state.pid,
  });
  const level = gateLevel(report.checks);
  const gate = buildGate(level, [...checkDiagnostics(report.checks), ...baseDiagnostics], path.steps);
  const text = (): void => {
    if (!options.json) console.log(`cogmem home ${dataDir}`);
    if (!options.json) console.log(`health ${healthUrl}`);
    if (!options.json) printChecks(report.checks);
  };
  emit({
    dataDir,
    dbPath: join(dataDir, 'memory.sqlite'),
    healthUrl,
    installState: statePath,
    checks: report.checks,
    ...(report.storage ? { storage: report.storage } : {}),
    ...(report.backlog ? { backlog: report.backlog } : {}),
  }, gate, text, options.json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

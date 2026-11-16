/**
 * Finding the server processes a test run leaves behind (#244).
 *
 * A test that starts a real observatory must stop it; a run that is killed cannot.
 * These scans are the two halves of that: the preload sweeps servers whose run root
 * is gone, and `leak-check.ts` fails the gate when one is still alive afterwards.
 *
 * The match is deliberately narrow — `bin/observatory.ts` (or the built `.js`)
 * whose arguments name a `cogmem-run-*` root or the repo's `.cogmem/tmp`. A
 * developer's real resident has neither, so it is never touched.
 */

export interface ServerProcess {
  pid: number;
  args: string;
}

export interface TestUnit {
  unit: string;
  /** The pid embedded in `cogmem-150-<pid>-<random>.service`. */
  pid: number;
  active: boolean;
}

export function parseObservatoryProcesses(psOutput: string): ServerProcess[] {
  const found: ServerProcess[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2]!;
    // The executable, not any argument: a shell whose command line merely quotes
    // this path is not the server.
    const [head, entry] = args.split(/\s+/);
    if (!head || !/(?:^|\/)(?:bun|node)$/.test(head)) continue;
    if (!entry || !/bin\/observatory\.(ts|js)$/.test(entry)) continue;
    found.push({ pid: Number(match[1]), args });
  }
  return found;
}

/** A server this suite started: its arguments name a run root. */
export function isTestServer(args: string): boolean {
  return /cogmem-run-\d+/.test(args) || /[\\/]\.cogmem[\\/]tmp[\\/]/.test(args);
}

/** The `cogmem-run-<pid>` the server was started under, when its args carry one. */
export function runRootPid(args: string): number | undefined {
  const match = /cogmem-run-(\d+)/.exec(args);
  return match ? Number(match[1]) : undefined;
}

/**
 * Test servers whose run root process is gone. A live run root means another suite
 * is still using it; a dead one means nobody will ever stop that server.
 */
export function leakedServers(psOutput: string, alive: (pid: number) => boolean = isProcessAlive): ServerProcess[] {
  return parseObservatoryProcesses(psOutput).filter((server) => {
    if (!isTestServer(server.args)) return false;
    const root = runRootPid(server.args);
    return root === undefined || !alive(root);
  });
}

/** Parse `systemctl --user list-units --all --plain --no-legend 'cogmem-150-*'`. */
export function parseTestUnits(output: string): TestUnit[] {
  const units: TestUnit[] = [];
  for (const line of output.split('\n')) {
    const [unit, , active] = line.trim().split(/\s+/);
    const match = /^cogmem-150-(\d+)-\d+\.service$/.exec(unit ?? '');
    if (!match) continue;
    units.push({ unit: unit!, pid: Number(match[1]), active: active === 'active' || active === 'activating' });
  }
  return units;
}

/** Test units still running, or left behind by a run whose pid is gone. */
export function leakedUnits(units: TestUnit[], alive: (pid: number) => boolean = isProcessAlive): TestUnit[] {
  return units.filter((unit) => unit.active && !alive(unit.pid));
}

export function readProcessTable(): string {
  const proc = Bun.spawnSync({ cmd: ['ps', '-eo', 'pid=,args='], stdout: 'pipe', stderr: 'pipe' });
  return proc.stdout.toString();
}

export function readUserUnits(): string {
  if (!Bun.which('systemctl')) return '';
  const proc = Bun.spawnSync({
    cmd: ['systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', 'cogmem-150-*'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.exitCode === 0 ? proc.stdout.toString() : '';
}

/** Kill servers left by a run that no longer exists, and stop their units. */
export function sweepOrphanServers(psOutput = readProcessTable()): number {
  let killed = 0;
  for (const server of leakedServers(psOutput)) {
    try {
      process.kill(server.pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Already gone between the scan and the kill.
    }
  }
  return killed;
}

export function sweepOrphanUnits(unitsOutput = readUserUnits()): number {
  let stopped = 0;
  for (const unit of leakedUnits(parseTestUnits(unitsOutput))) {
    const proc = Bun.spawnSync({ cmd: ['systemctl', '--user', 'stop', unit.unit], stdout: 'pipe', stderr: 'pipe' });
    if (proc.exitCode === 0) stopped += 1;
  }
  return stopped;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

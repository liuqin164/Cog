/**
 * The install's own doctor: the checks that decide whether the six steps actually produced a living
 * companion, run against the running resident rather than a second kernel.
 *
 * It asks the resident's loopback `/health` for kernel state on purpose. Opening a second
 * `MemoryKernel` on the same database file to ask how the first one is doing would be two writers on
 * one path, which CONCURRENT_ACCESS.md forbids — the health face is the surface that exists so this
 * command does not have to.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bwrapUsable } from '../plugins/builtin-tools.ts';
import { formatBytes } from '../memory.ts';
import { serviceStatus, type Platform, type Runner, type ServiceSpec } from './service.ts';

export interface HealthPayload {
  status: string;
  bind: string;
  port?: number;
  dbPath?: string;
  state?: string;
  kernel?: { status?: string; package?: string; dbPath?: string };
  memory?: { rssBytes?: number; limitBytes?: number; highBytes?: number; source?: string };
  contextAssembly?: {
    failures: number;
    consecutive: number;
    lastFailure: { at: number; message: string } | null;
  };
  memoryModel?: { state?: string; line?: string };
}

export interface DoctorContext {
  dataDir: string;
  dbPath: string;
  socketPath: string;
  healthUrl: string;
  fetchHealth: () => Promise<HealthPayload>;
  spec: ServiceSpec;
  platform: Platform;
  run: Runner;
  /** `service` checks the unit; `process` checks the pid an install without a manager left behind. */
  mode: 'service' | 'process';
  pid?: number;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
  /**
   * Not green, but not a failed install: the shell degrades visibly instead (#284). The check keeps
   * `ok` true so every consumer that reads `!ok` as a failure does not misname the upgrade gate.
   */
  warn?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export async function runDoctor(ctx: DoctorContext): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. The data directory is the private one the installer made.
  try {
    const dirMode = mode(ctx.dataDir);
    checks.push({
      id: 'data-dir',
      ok: dirMode === 0o700,
      detail: `${ctx.dataDir} mode ${dirMode.toString(8)}`,
    });
  } catch (error) {
    checks.push({ id: 'data-dir', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  // 2. Snapshot output is private too (the security posture printed at install time).
  const snapshots = join(ctx.dataDir, 'snapshots');
  checks.push({
    id: 'snapshot-dir',
    ok: existsSync(snapshots) && mode(snapshots) === 0o700,
    detail: existsSync(snapshots) ? `${snapshots} mode ${mode(snapshots).toString(8)}` : `${snapshots} missing`,
  });

  // 3. The resident is up and its kernel says ok; the payload also carries the bind address.
  try {
    const health = await ctx.fetchHealth();
    const kernelOk = health.kernel?.status === 'ok' && health.kernel?.package === 'cogmem';
    const assembly = health.contextAssembly;
    checks.push({
      id: 'resident-health',
      ok: health.status === 'ok' && kernelOk && health.kernel?.dbPath === ctx.dbPath,
      detail: `${ctx.healthUrl} state=${health.state ?? '?'} kernel=${health.kernel?.status ?? '?'}/${health.kernel?.package ?? '?'} db=${health.kernel?.dbPath ?? '?'}`
        + (assembly
          ? ` contextAssembly=${assembly.consecutive >= 3 ? 'degraded' : 'ok'} failures=${assembly.failures} consecutive=${assembly.consecutive}`
            + (assembly.lastFailure ? ` last=${new Date(assembly.lastFailure.at).toISOString()}:${assembly.lastFailure.message}` : '')
          : ''),
    });
    checks.push({
      id: 'loopback-only',
      ok: LOOPBACK.has(health.bind),
      detail: `bind=${health.bind}`,
    });
    if (health.memoryModel !== undefined) {
      const state = health.memoryModel.state ?? 'unknown';
      checks.push({
        id: 'memory-model',
        ok: true,
        warn: state !== 'reachable',
        detail: health.memoryModel.line ?? `memory model ${state}`,
      });
    }
    // The unit's ceiling is only observable through the resident's own cgroup reading. A service
    // install must have one; a no-manager process legitimately has none.
    const memory = health.memory;
    const capped = typeof memory?.limitBytes === 'number' && memory.limitBytes > 0;
    const capRequired = ctx.platform === 'linux' && ctx.mode === 'service';
    checks.push({
      id: 'memory-cap',
      ok: capRequired ? capped : true,
      detail: memory
        ? `rss=${formatBytes(memory.rssBytes)} high=${formatBytes(memory.highBytes)} max=${formatBytes(memory.limitBytes)} via ${memory.source ?? '?'}`
        : 'resident reports no memory reading (older build?)',
    });
  } catch (error) {
    checks.push({ id: 'resident-health', ok: false, detail: error instanceof Error ? error.message : String(error) });
    checks.push({ id: 'loopback-only', ok: false, detail: 'resident unreachable, bind unknown' });
  }

  // 4. The control socket `cog` attaches to.
  checks.push({ id: 'attach-socket', ok: existsSync(ctx.socketPath), detail: ctx.socketPath });

  // 5. The service manager knows the unit (or the process an install without one left behind).
  if (ctx.mode === 'process') {
    let alive = false;
    try {
      if (ctx.pid) process.kill(ctx.pid, 0);
      alive = Boolean(ctx.pid);
    } catch {
      alive = false;
    }
    checks.push({ id: 'resident-process', ok: alive, detail: ctx.pid ? `pid ${ctx.pid}` : 'no pid recorded' });
  } else {
    try {
      const status = await serviceStatus(ctx.run, ctx.spec, ctx.platform);
      checks.push({ id: 'service', ok: status === 'active' || status === 'loaded', detail: status });
      if (ctx.platform === 'linux') {
        const shown = await ctx.run('systemctl', [
          '--user', 'show', `${ctx.spec.serviceName}.service`,
          '--property=ActiveState,SubState,Result,NRestarts,StartLimitBurst',
        ]);
        const fields = Object.fromEntries(shown.stdout
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        const restarts = Number(fields.NRestarts ?? '0');
        const burst = Number(fields.StartLimitBurst ?? '5');
        // systemd 255 keeps `Result=exit-code` when the start limit trips; the distinguishable
        // state is "failed after at least a full burst of restarts". Newer versions also name it.
        const stopped = fields.Result === 'start-limit-hit'
          || (fields.ActiveState === 'failed' && restarts > 0 && restarts >= burst);
        checks.push({
          id: 'start-limit',
          ok: !stopped,
          detail: stopped
            ? `stopped by StartLimit (Result=${fields.Result ?? '?'}, NRestarts=${fields.NRestarts ?? '?'}): inspect ${ctx.spec.logFile}`
            : `ActiveState=${fields.ActiveState ?? '?'} Result=${fields.Result ?? '?'} NRestarts=${fields.NRestarts ?? '?'}`,
        });
      }
    } catch (error) {
      checks.push({ id: 'service', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // 6. bash isolation. A missing bubblewrap is a WARN, not a FAIL: the shell still runs, but every
  // bash result says `[sandbox: off]` and `/status` reports it, so the degradation is not silent.
  const sandbox = bwrapUsable();
  checks.push({
    id: 'sandbox',
    ok: true,
    warn: !sandbox,
    detail: sandbox
      ? 'bubblewrap usable: bash runs isolated'
      : 'bubblewrap unavailable: bash runs unsandboxed and says so; install bubblewrap on Linux to restore isolation',
  });

  return { ok: checks.every((check) => check.ok || check.warn === true), checks };
}

export async function defaultFetchHealth(url: string): Promise<HealthPayload> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return (await response.json()) as HealthPayload;
}

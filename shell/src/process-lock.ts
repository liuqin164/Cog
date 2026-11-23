import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ACQUIRING_GRACE_MS = 5_000;
const LOCK_POLL_CELL = new Int32Array(new SharedArrayBuffer(4));

export class RuntimeLockHeldError extends Error {
  readonly code = 'runtime_lock_held';
  constructor(readonly pid: number) {
    super(`runtime_lock_held: another companion shell owns this data directory${pid > 0 ? ` (pid ${pid})` : ''}`);
  }
}

export interface RuntimeLock {
  pid: number;
  at: number;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ProcessLock {
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, 'runtime.lock');
  }

  acquire(pid = process.pid, now = Date.now()): { recoveredStalePid?: number } {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {}
    const contents = JSON.stringify({ pid, at: now });
    const temp = join(this.dir, `runtime.lock.${pid}.${now}.tmp`);
    writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 });
    let recoveredStalePid: number | undefined;
    const result = () => recoveredStalePid === undefined ? {} : { recoveredStalePid };
    try {
      for (let attempt = 0; attempt < 64; attempt += 1) {
        try {
          linkSync(temp, this.path);
          if (this.read()?.pid === pid) return result();
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const holderPid = this.read()?.pid;
        if (holderPid === pid) {
          writeFileSync(this.path, contents, 'utf8');
          return result();
        }
        if (holderPid !== undefined && isAlive(holderPid)) throw new RuntimeLockHeldError(holderPid);
        if (holderPid === undefined) {
          const ageMs = this.ageMs();
          if (ageMs === undefined || ageMs < ACQUIRING_GRACE_MS) {
            Atomics.wait(LOCK_POLL_CELL, 0, 0, 1);
            continue;
          }
        } else recoveredStalePid = holderPid;
        const stalePath = `${this.path}.${pid}.${attempt}.stale`;
        try {
          renameSync(this.path, stalePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (this.read(stalePath)?.pid !== holderPid) {
          try {
            linkSync(stalePath, this.path);
          } catch {}
        }
        rmSync(stalePath, { force: true });
      }
    } finally {
      rmSync(temp, { force: true });
    }
    throw new RuntimeLockHeldError(this.read()?.pid ?? 0);
  }

  private read(path = this.path): RuntimeLock | undefined {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RuntimeLock;
    } catch {
      return undefined;
    }
  }

  private ageMs(): number | undefined {
    try {
      return Date.now() - statSync(this.path).mtimeMs;
    } catch {
      return undefined;
    }
  }

  release(pid = process.pid): void {
    try {
      const holder = JSON.parse(readFileSync(this.path, 'utf8')) as RuntimeLock;
      if (holder.pid === pid) rmSync(this.path, { force: true });
    } catch {}
  }
}

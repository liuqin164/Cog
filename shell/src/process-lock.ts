import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export class RuntimeLockHeldError extends Error {
  readonly code = 'runtime_lock_held';
  constructor(readonly pid: number) {
    super(`runtime_lock_held: another companion shell (pid ${pid}) owns this data directory`);
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
    let recoveredStalePid: number | undefined;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      let fd: number;
      try {
        fd = openSync(this.path, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = this.read();
        if (holder?.pid === pid) {
          writeFileSync(this.path, JSON.stringify({ pid, at: now }), 'utf8');
          return recoveredStalePid === undefined ? {} : { recoveredStalePid };
        }
        if (holder && isAlive(holder.pid)) throw new RuntimeLockHeldError(holder.pid);
        if (holder?.pid !== undefined) recoveredStalePid = holder.pid;
        const stalePath = `${this.path}.${pid}.${attempt}.stale`;
        try {
          renameSync(this.path, stalePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
        }
        rmSync(stalePath, { force: true });
        continue;
      }
      try {
        writeSync(fd, JSON.stringify({ pid, at: now }));
      } finally {
        closeSync(fd);
      }
      const holder = this.read();
      if (holder?.pid === pid) return recoveredStalePid === undefined ? {} : { recoveredStalePid };
    }
    throw new RuntimeLockHeldError(this.read()?.pid ?? pid);
  }

  private read(): RuntimeLock | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as RuntimeLock;
    } catch {
      return undefined;
    }
  }

  release(pid = process.pid): void {
    if (!existsSync(this.path)) return;
    try {
      const holder = JSON.parse(readFileSync(this.path, 'utf8')) as RuntimeLock;
      if (holder.pid === pid) rmSync(this.path, { force: true });
    } catch {}
  }
}

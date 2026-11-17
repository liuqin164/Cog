/**
 * One temp root per test process (#312). The old preload deleted every `companion-*` directory
 * under `TMPDIR` at the start of a run; when two runs overlapped, one deleted the other's live
 * data, and an embedding worker loading from that directory failed with ENOENT. A run root named
 * after its pid lets the next run tell stale garbage from a live process's directories.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RUN_ROOT_PREFIX = 'companion-run-';

export function runRoot(pid = process.pid): string {
  return join(tmpdir(), `${RUN_ROOT_PREFIX}${pid}`);
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Create this run's root and remove only roots whose owning process is gone. */
export function prepareRunRoot(): string {
  const root = runRoot();
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(RUN_ROOT_PREFIX)) continue;
    if (isAlive(Number(entry.slice(RUN_ROOT_PREFIX.length)))) continue;
    rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }
  return root;
}

/**
 * Size cap for the resident's stdout/stderr log (#226).
 *
 * systemd writes `service.log` through an inherited append fd, and launchd does the same; neither
 * offers a size limit. Renaming the file would leave the daemon writing to the renamed inode, so the
 * only rotation that works without a second process is copytruncate: keep the last `maxBytes` as
 * `.1`, then truncate the live file in place. The writer's O_APPEND fd continues at the new end.
 *
 * shortcut: a write that lands between the tail read and the truncate is lost; acceptable for a
 * service log, upgrade to logrotate copytruncate if audit-grade lines ever live here.
 */
import { closeSync, openSync, readSync, statSync, truncateSync, writeFileSync } from 'node:fs';

export const SERVICE_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** True when the file was over the cap and rotated; false when absent or small enough. */
export function rotateLogFile(path: string, maxBytes = SERVICE_LOG_MAX_BYTES): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;
  const keep = Math.min(size, maxBytes);
  const buffer = Buffer.allocUnsafe(keep);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, keep, size - keep);
  } finally {
    closeSync(fd);
  }
  writeFileSync(`${path}.1`, buffer, { mode: 0o600 });
  truncateSync(path, 0);
  return true;
}

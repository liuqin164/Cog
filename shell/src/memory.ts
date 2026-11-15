/**
 * The resident's own memory reading (#226): RSS, and the cgroup ceiling the service unit sets.
 *
 * Read from procfs/cgroupfs rather than `systemctl show` because the health face must answer without
 * a service manager and without a subprocess. On cgroup v2 the unit's `MemoryHigh`/`MemoryMax` are
 * `memory.high`/`memory.max`; cgroup v1 has only the hard `memory.limit_in_bytes`. A value of
 * `max` (v2) or the v1 "unlimited" sentinel is reported as absent, not as a number.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface MemoryReading {
  rssBytes: number;
  /** The hard limit (`MemoryMax` / `memory.max`), absent when unlimited or unknown. */
  limitBytes?: number;
  /** The throttle threshold (`MemoryHigh` / `memory.high`), absent on cgroup v1. */
  highBytes?: number;
  source: 'cgroup-v2' | 'cgroup-v1' | 'proc';
}

export interface MemoryReadOptions {
  pid?: number;
  /** Test seams; production uses `/proc` and `/sys/fs/cgroup`. */
  procRoot?: string;
  cgroupRoot?: string;
  readFile?: (path: string) => string;
  rss?: () => number;
}

function parseCgroupLimit(raw: string): number | undefined {
  const text = raw.trim();
  if (text === '' || text === 'max') return undefined;
  const value = Number(text);
  // cgroup v1's "unlimited" is PAGE_COUNTER_MAX pages, not a real cap the user set.
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 50) return undefined;
  return value;
}

function readRss(options: MemoryReadOptions, read: (path: string) => string): number {
  if (options.rss) return options.rss();
  const procRoot = options.procRoot ?? '/proc';
  const pid = options.pid ?? process.pid;
  try {
    const status = read(join(procRoot, String(pid), 'status'));
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    if (match) return Number(match[1]) * 1024;
  } catch {
    // macOS and anything without procfs falls through to the runtime's own counter.
  }
  return process.memoryUsage().rss;
}

/**
 * cgroup v2 limits are hierarchical: the effective ceiling is the smallest limit on the way up to
 * the root. systemd puts the unit's MemoryHigh/MemoryMax on the unit cgroup, which may be an
 * ancestor of the process's own cgroup, so walk the chain instead of reading only the leaf.
 */
function readV2Limits(
  leaf: string,
  root: string,
  read: (path: string) => string,
): { limitBytes?: number; highBytes?: number } {
  let limitBytes: number | undefined;
  let highBytes: number | undefined;
  for (let current = leaf; current.startsWith(root); current = dirname(current)) {
    try {
      const limit = parseCgroupLimit(read(join(current, 'memory.max')));
      if (limit !== undefined) limitBytes = limitBytes === undefined ? limit : Math.min(limitBytes, limit);
    } catch {
      // A level without the file contributes no limit.
    }
    try {
      const high = parseCgroupLimit(read(join(current, 'memory.high')));
      if (high !== undefined) highBytes = highBytes === undefined ? high : Math.min(highBytes, high);
    } catch {
      // Same.
    }
    if (current === root) break;
  }
  return { limitBytes, highBytes };
}

export function readMemoryUsage(options: MemoryReadOptions = {}): MemoryReading {
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const rssBytes = readRss(options, read);
  const procRoot = options.procRoot ?? '/proc';
  const cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
  const pid = options.pid ?? process.pid;
  try {
    const lines = read(join(procRoot, String(pid), 'cgroup')).split('\n');
    const v2 = lines.find((line) => line.startsWith('0::'));
    if (v2) {
      const base = join(cgroupRoot, v2.slice(3));
      return { rssBytes, ...readV2Limits(base, cgroupRoot, read), source: 'cgroup-v2' };
    }
    const v1 = lines.find((line) => /^\d+:memory:/u.test(line));
    if (v1) {
      const base = join(cgroupRoot, 'memory', v1.split(':').slice(2).join(':'));
      return { rssBytes, limitBytes: parseCgroupLimit(read(join(base, 'memory.limit_in_bytes'))), source: 'cgroup-v1' };
    }
  } catch {
    // No cgroup files: report the RSS alone rather than inventing a ceiling.
  }
  return { rssBytes, source: 'proc' };
}

/** One human line for doctor/health; absent readings say "none", not "0". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'none';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * The notice's one rule: speak once when RSS reaches the ceiling, re-arm below 90% (hysteresis), do
 * nothing with no ceiling or while still over it. Pure so the alert has a discriminator without a
 * real cgroup.
 */
export function memoryPressureAction(reading: MemoryReading, warned: boolean): 'warn' | 'hold' | 'reset' {
  const ceiling = reading.highBytes ?? reading.limitBytes;
  if (ceiling === undefined) return 'reset';
  if (reading.rssBytes < ceiling * 0.9) return 'reset';
  if (reading.rssBytes >= ceiling && !warned) return 'warn';
  return 'hold';
}

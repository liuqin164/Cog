/**
 * #226: the bounds and ceilings the audit found, each with a discriminator.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from '../src/install/doctor.ts';
import { writeDefaultSoul } from '../src/install/soul.ts';
import type { Runner, ServiceSpec } from '../src/install/service.ts';
import { rotateLogFile } from '../src/log-rotation.ts';
import { formatBytes, memoryPressureAction, readMemoryUsage, type MemoryReading } from '../src/memory.ts';
import { TraceLog } from '../src/trace.ts';
import { MAX_TRANSCRIPT_ENTRIES, TuiView } from '../src/tui/view.ts';
import { makeTempDir } from './helpers.ts';

describe('memory reading (#226)', () => {
  test('cgroup v2: RSS, MemoryHigh and MemoryMax come from the process own cgroup', () => {
    const cgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/cogmem-companion.service';
    const files = new Map<string, string>([
      ['/proc/42/status', 'Name:\tbun\nVmRSS:\t  2048 kB\n'],
      ['/proc/42/cgroup', `0::${cgroup}\n`],
      [`/sys/fs/cgroup${cgroup}/memory.max`, '2147483648\n'],
      [`/sys/fs/cgroup${cgroup}/memory.high`, '1610612736\n'],
    ]);
    const reading = readMemoryUsage({
      pid: 42,
      readFile: (path) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT ${path}`);
        return value;
      },
    });
    expect(reading.rssBytes).toBe(2 * 1024 * 1024);
    expect(reading.limitBytes).toBe(2_147_483_648);
    expect(reading.highBytes).toBe(1_610_612_736);
    expect(reading.source).toBe('cgroup-v2');
  });

  test('an unlimited cgroup reports absent limits, not 0', () => {
    const cgroup = '/user.slice/cogmem-companion.service';
    const files = new Map<string, string>([
      ['/proc/42/status', 'VmRSS:\t 100 kB\n'],
      ['/proc/42/cgroup', `0::${cgroup}\n`],
      [`/sys/fs/cgroup${cgroup}/memory.max`, 'max\n'],
      [`/sys/fs/cgroup${cgroup}/memory.high`, 'max\n'],
    ]);
    const reading = readMemoryUsage({
      pid: 42,
      readFile: (path) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT ${path}`);
        return value;
      },
    });
    expect(reading.limitBytes).toBeUndefined();
    expect(reading.highBytes).toBeUndefined();
  });

  test('a limit on an ancestor unit cgroup is the effective one', () => {
    const unit = '/user.slice/user-1000.slice/user@1000.service/app.slice/cogmem-companion.service';
    const leaf = `${unit}/child.scope`;
    const files = new Map<string, string>([
      ['/proc/42/status', 'VmRSS:\t 100 kB\n'],
      ['/proc/42/cgroup', `0::${leaf}\n`],
      [`/sys/fs/cgroup${leaf}/memory.max`, 'max\n'],
      [`/sys/fs/cgroup${unit}/memory.max`, '2147483648\n'],
      [`/sys/fs/cgroup${unit}/memory.high`, '1610612736\n'],
    ]);
    const reading = readMemoryUsage({
      pid: 42,
      readFile: (path) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT ${path}`);
        return value;
      },
    });
    expect(reading.limitBytes).toBe(2_147_483_648);
    expect(reading.highBytes).toBe(1_610_612_736);
  });

  test('cgroup v1 hard limit and its unlimited sentinel', () => {
    const read = (limit: string) => readMemoryUsage({
      pid: 7,
      readFile: (path) => {
        if (path === '/proc/7/status') return 'VmRSS:\t 512 kB\n';
        if (path === '/proc/7/cgroup') return '4:memory:/docker/abc\n';
        if (path === '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes') return `${limit}\n`;
        throw new Error(`ENOENT ${path}`);
      },
    });
    expect(read('1073741824').limitBytes).toBe(1_073_741_824);
    expect(read('9223372036854771712').limitBytes).toBeUndefined();
  });

  test('formatting keeps absent distinct from zero', () => {
    expect(formatBytes(undefined)).toBe('none');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536 * 1024 * 1024)).toBe('1.50 GiB');
  });

  test('the pressure notice speaks once, re-arms below 90%, and holds while over', () => {
    const reading = (rssBytes: number, highBytes?: number, limitBytes?: number): MemoryReading => ({
      rssBytes, highBytes, limitBytes, source: 'cgroup-v2',
    });
    expect(memoryPressureAction(reading(800, 1000), false)).toBe('reset');
    expect(memoryPressureAction(reading(950, 1000), false)).toBe('hold');
    expect(memoryPressureAction(reading(1000, 1000), false)).toBe('warn');
    expect(memoryPressureAction(reading(1000, 1000), true)).toBe('hold');
    expect(memoryPressureAction(reading(1000, undefined, 1000), false)).toBe('warn');
    expect(memoryPressureAction(reading(10 ** 12, undefined, undefined), false)).toBe('reset');
  });
});

describe('on-disk caps (#226)', () => {
  test('service.log copytruncate keeps the tail and empties the live file', () => {
    const dir = makeTempDir();
    const path = join(dir, 'service.log');
    writeFileSync(path, `${'a'.repeat(1024)}${'b'.repeat(1024)}`);
    expect(rotateLogFile(path, 1024)).toBe(true);
    expect(statSync(path).size).toBe(0);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('b'.repeat(1024));
    // Below the cap is a no-op, not a rewrite.
    writeFileSync(path, 'small');
    expect(rotateLogFile(path, 1024)).toBe(false);
  });

  test('the trace rotates at the cap, keeps one generation, and keeps recording', () => {
    const dir = makeTempDir();
    const trace = new TraceLog(dir, 'events.jsonl', { maxBytes: 256 });
    for (let index = 0; index < 40; index += 1) trace.append('tick', { index });
    const live = trace.read();
    expect(live.length).toBeGreaterThan(0);
    expect(live.some((record) => record.kind === 'trace_rotated')).toBe(true);
    expect(statSync(join(dir, 'events.jsonl.1')).size).toBeGreaterThan(0);
    // Every live record parses; the rotated file is the previous generation.
    expect(trace.read().every((record) => typeof record.at === 'number')).toBe(true);
  });
});

describe('transcript bounds (#226)', () => {
  test('the mirrored transcript stops at MAX_TRANSCRIPT_ENTRIES and drops old dirty marks', () => {
    const view = new TuiView();
    for (let index = 0; index < MAX_TRANSCRIPT_ENTRIES + 37; index += 1) {
      view.push({ kind: 'user', id: `u${index}`, text: `line ${index}` });
    }
    expect(view.entries.length).toBe(MAX_TRANSCRIPT_ENTRIES);
    expect(view.entries[0]).toMatchObject({ id: `u37` });
    expect(view.dirty.size).toBe(MAX_TRANSCRIPT_ENTRIES);
  });

  test('an attach snapshot larger than the cap is trimmed in the view', () => {
    const view = new TuiView();
    view.load({
      entries: Array.from({ length: MAX_TRANSCRIPT_ENTRIES + 10 }, (_, index) => ({
        kind: 'user' as const,
        id: `s${index}`,
        text: `line ${index}`,
      })),
    });
    expect(view.entries.length).toBe(MAX_TRANSCRIPT_ENTRIES);
    expect(view.entries[0]).toMatchObject({ id: 's10' });
  });

});

describe('doctor memory ceiling (#226)', () => {
  function context() {
    const dir = makeTempDir();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'snapshots'), { recursive: true, mode: 0o700 });
    const dbPath = join(dataDir, 'memory.sqlite');
    writeDefaultSoul(dbPath, 'agent-a');
    const socketPath = join(dataDir, 'attach.sock');
    writeFileSync(socketPath, '');
    const spec: ServiceSpec = {
      serviceName: 'cogmem-companion',
      bunPath: '/usr/bin/bun',
      shellDir: '/opt/cogmem/shell',
      dataDir,
      workspaceRoot: dir,
      projectId: 'p',
      agentId: 'agent-a',
      httpPort: 7338,
      envFile: join(dataDir, 'env'),
      logFile: join(dataDir, 'service.log'),
      homeDir: dir,
      env: {},
    };
    return { dataDir, dbPath, socketPath, spec };
  }

  test('a service install whose resident reports no hard cap fails the check', async () => {
    const { dataDir, dbPath, socketPath, spec } = context();
    const report = await runDoctor({
      dataDir, dbPath, agentId: 'agent-a', socketPath, healthUrl: 'http://127.0.0.1:7338/health',
      fetchHealth: async () => ({
        status: 'ok', bind: '127.0.0.1', state: 'IDLE',
        kernel: { status: 'ok', package: 'cogmem', dbPath },
        memory: { rssBytes: 200 * 1024 * 1024, source: 'cgroup-v2' },
      }),
      spec, platform: 'linux', run: async () => ({ code: 0, stdout: 'active', stderr: '' }), mode: 'service',
    });
    expect(report.checks.find((check) => check.id === 'memory-cap')?.ok).toBe(false);
  });

  test('an uncapped no-manager process is not failed', async () => {
    const { dataDir, dbPath, socketPath, spec } = context();
    const report = await runDoctor({
      dataDir, dbPath, agentId: 'agent-a', socketPath, healthUrl: 'http://127.0.0.1:7338/health',
      fetchHealth: async () => ({
        status: 'ok', bind: '127.0.0.1', state: 'IDLE',
        kernel: { status: 'ok', package: 'cogmem', dbPath },
        memory: { rssBytes: 200 * 1024 * 1024, source: 'proc' },
      }),
      spec, platform: 'linux', run: async () => ({ code: 0, stdout: '', stderr: '' }), mode: 'process', pid: process.pid,
    });
    expect(report.checks.find((check) => check.id === 'memory-cap')?.ok).toBe(true);
  });

  test('a unit stopped by StartLimit is visible and not reported as a healthy service', async () => {
    const { dataDir, dbPath, socketPath, spec } = context();
    const runner: Runner = async (_command, args) => {
      if (args.includes('is-active')) return { code: 3, stdout: '', stderr: '' };
      if (args.includes('show')) {
        return {
          code: 0,
          stdout: 'ActiveState=failed\nSubState=failed\nResult=exit-code\nNRestarts=5\nStartLimitBurst=5\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const report = await runDoctor({
      dataDir, dbPath, agentId: 'agent-a', socketPath, healthUrl: 'http://127.0.0.1:7338/health',
      fetchHealth: async () => {
        throw new Error('resident unreachable');
      },
      spec, platform: 'linux', run: runner, mode: 'service',
    });
    const check = report.checks.find((entry) => entry.id === 'start-limit');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('stopped by StartLimit');
    expect(check?.detail).toContain('NRestarts=5');
  });
});

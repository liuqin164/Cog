import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './helpers/tmp.js';

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const doctorBin = join(coreRoot, 'src/bin/doctor.ts');
const BUN_DIR = dirname(process.execPath);

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function install(httpPort: number) {
  const home = makeTempDir('cogmem-doctor-nodb-');
  const dataDir = join(home, '.cogmem', 'companion');
  const dbPath = join(dataDir, 'memory.sqlite');
  const snapshots = join(dataDir, 'snapshots');
  mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  chmodSync(snapshots, 0o700);
  writeFileSync(join(dataDir, 'attach.sock'), '');
  writeFileSync(dbPath, 'this is not a sqlite database\n');
  writeFileSync(join(dataDir, 'install.json'), JSON.stringify({
    schema: 1,
    done: ['preflight', 'place', 'model', 'rhythm', 'resident', 'awake'],
    choices: {
      dataDir,
      workspaceRoot: join(home, 'workspace'),
      projectId: 'companion',
      agentId: 'cogmem-companion',
      httpPort,
      platform: 'linux',
      serviceName: 'cogmem-companion',
    },
    pid: process.pid,
    updatedAt: 0,
  }));
  return { home, dataDir, dbPath };
}

function runDoctor(home: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, doctorBin, '--json'],
    cwd: coreRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      COGMEM_UPDATE_CHECK: '0',
      PATH: [BUN_DIR, process.env.PATH].filter(Boolean).join(':'),
    },
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
}

test('doctor trusts the running health face and never opens the database', async () => {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('not found', { status: 404 }) });
  const port = probe.port ?? 0;
  probe.stop(true);

  const { home, dbPath } = install(port);
  server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: () => Response.json({
      status: 'ok',
      bind: '127.0.0.1',
      state: 'IDLE',
      kernel: { status: 'ok', package: 'cogmem', dbPath },
      memory: { rssBytes: 1, source: 'proc' },
    }),
  });

  const result = await runDoctor(home);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    installGate: { level: string; diagnostics: Array<{ code: string }> };
    checks: Array<{ id: string; ok: boolean }>;
  };
  expect(['ok', 'warn']).toContain(payload.installGate.level);
  expect(payload.checks.find((check) => check.id === 'resident-health')?.ok).toBe(true);
});

test('a stopped resident fails the gate instead of opening its database', async () => {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('not found', { status: 404 }) });
  const port = probe.port ?? 0;
  probe.stop(true);

  const { home } = install(port);
  const result = await runDoctor(home);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    installGate: { level: string; diagnostics: Array<{ code: string }> };
  };
  expect(payload.installGate.level).toBe('fail');
  expect(payload.installGate.diagnostics.map((diagnostic) => diagnostic.code)).toContain('resident-health');
});

describe('the doctor sources have no database call', () => {
  for (const file of ['src/bin/doctor.ts', 'shell/src/install/doctor.ts', 'shell/src/install/doctor-cli.ts']) {
    test(file, () => {
      const source = readFileSync(join(coreRoot, file), 'utf8');
      expect(source).not.toMatch(/new Database\(|createMemoryKernel\(|createMemoryKernelFromConfig\(|readSoul\(/);
    });
  }
});

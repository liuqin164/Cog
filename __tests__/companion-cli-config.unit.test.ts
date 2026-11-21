import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KernelAgentMemoryBackend } from '../src/agent/index.js';
import { createMemoryKernel } from '../src/factory.js';
import { CORE_VERSION } from '../src/version.js';
import { makeTempDir } from './helpers/tmp.js';

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cogmemBin = join(coreRoot, 'src/bin/cogmem.ts');
const BUN_DIR = dirname(process.execPath);

function run(args: string[], options: { cwd: string; home: string; env?: Record<string, string> }) {
  const proc = Bun.spawn({
    cmd: ['bun', ...args],
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: options.home,
      COGMEM_CONFIG: '',
      COGMEM_UPDATE_CHECK: '0',
      PATH: [BUN_DIR, process.env.PATH].filter(Boolean).join(':'),
      ...options.env,
    },
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
}

async function companionOnlyHome(token: string) {
  const home = makeTempDir('cogmem-companion-cli-');
  const companionDir = join(home, '.cogmem', 'companion');
  const configPath = join(companionDir, 'cogmem-cli.toml');
  const dbPath = join(companionDir, 'memory.sqlite');
  mkdirSync(companionDir, { recursive: true });
  writeFileSync(configPath, `[core]\ndb_path = ${JSON.stringify(dbPath)}\n`);
  writeFileSync(join(companionDir, 'install.json'), JSON.stringify({
    schema: 1,
    done: ['preflight', 'place', 'model', 'rhythm', 'resident', 'awake'],
    choices: { dataDir: companionDir, projectId: 'companion', agentId: 'cogmem-companion' },
    updatedAt: 0,
  }));
  const kernel = createMemoryKernel({ dbPath });
  try {
    await new KernelAgentMemoryBackend(kernel).rememberTurnWithResult({
      agentId: 'cogmem-companion',
      projectId: 'companion',
      sessionId: 'companion-cli',
      userText: token,
      assistantText: '记下了。',
    });
  } finally {
    kernel.close();
  }
  return { home, companionDir, configPath, dbPath };
}

describe('the management CLI on a companion-only install (#344)', () => {
  test('doctor resolves the companion config and reports the real install', async () => {
    const token = '部署窗口同伴库探针';
    const { home, configPath, dbPath } = await companionOnlyHome(token);
    const { stdout, stderr, exitCode } = await run([cogmemBin, 'doctor', '--json'], {
      cwd: home,
      home,
    });

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      configPath?: string;
      dbPath?: string;
      installGate: { level: string; diagnostics: Array<{ code: string }> };
      nextSteps: Array<{ id: string; command: string }>;
      version: { disk: string; serving: unknown[] };
      health: { status: string };
    };
    expect(parsed.installGate.level).not.toBe('not_installed');
    expect(parsed.installGate.diagnostics.some((diagnostic) => diagnostic.code === 'missing_config')).toBe(false);
    expect(parsed.configPath).toBe(configPath);
    expect(parsed.dbPath).toBe(dbPath);
    expect(parsed.version.disk).toBe(CORE_VERSION);
    expect(Array.isArray(parsed.version.serving)).toBe(true);
    expect(parsed.health.status).not.toBe('');
    expect(parsed.nextSteps.some((step) => step.id === 'operator_init' || step.id === 'agent_init')).toBe(false);
  }, 30_000);

  test('memory recall reads the companion database without --project', async () => {
    const token = '部署窗口同伴库探针';
    const { home } = await companionOnlyHome(token);
    const { stdout, stderr, exitCode } = await run([
      cogmemBin, 'memory', 'recall', '--query', token, '--json',
    ], { cwd: home, home });

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { projectId: string; items: Array<{ text: string }> };
    expect(parsed.projectId).toBe('companion');
    expect(JSON.stringify(parsed.items)).toContain(token);
  }, 30_000);

  test('a companion install without its CLI config does not recommend cogmem init', async () => {
    const home = makeTempDir('cogmem-companion-cli-missing-');
    const companionDir = join(home, '.cogmem', 'companion');
    mkdirSync(companionDir, { recursive: true });
    writeFileSync(join(companionDir, 'install.json'), JSON.stringify({
      schema: 1,
      done: ['preflight', 'place'],
      choices: { dataDir: companionDir },
      updatedAt: 0,
    }));
    const { stdout, exitCode } = await run([cogmemBin, 'doctor', '--json'], { cwd: home, home });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      installGate: { level: string };
      nextSteps: Array<{ id: string }>;
    };
    expect(parsed.installGate.level).toBe('not_installed');
    expect(parsed.nextSteps.some((step) => step.id === 'operator_init' || step.id === 'agent_init')).toBe(false);
  }, 30_000);
});

describe('bare-kernel and explicit config resolution do not regress (#344)', () => {
  test('a global config wins over the companion fallback', async () => {
    const token = '同伴配置不应抢走全局配置';
    const { home } = await companionOnlyHome(token);
    const globalConfig = join(home, '.cogmem', 'config.toml');
    const globalDb = join(home, '.cogmem', 'memory.db');
    writeFileSync(globalConfig, `[core]\ndb_path = ${JSON.stringify(globalDb)}\n`);
    const kernel = createMemoryKernel({ dbPath: globalDb });
    kernel.close();

    const { stdout, stderr, exitCode } = await run([cogmemBin, 'doctor', '--json'], { cwd: home, home });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { configPath?: string; dbPath?: string };
    expect(parsed.configPath).toBe(globalConfig);
    expect(parsed.dbPath).toBe(globalDb);
  }, 30_000);

  test('COGMEM_CONFIG still wins over the companion fallback', async () => {
    const token = '显式配置优先';
    const { home } = await companionOnlyHome(token);
    const envConfig = join(home, 'explicit', 'config.toml');
    const envDb = join(home, 'explicit', 'memory.db');
    mkdirSync(dirname(envConfig), { recursive: true });
    writeFileSync(envConfig, `[core]\ndb_path = ${JSON.stringify(envDb)}\n`);
    const kernel = createMemoryKernel({ dbPath: envDb });
    kernel.close();

    const { stdout, stderr, exitCode } = await run([cogmemBin, 'doctor', '--json'], {
      cwd: home,
      home,
      env: { COGMEM_CONFIG: envConfig },
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { configPath?: string; dbPath?: string };
    expect(parsed.configPath).toBe(envConfig);
    expect(parsed.dbPath).toBe(envDb);
  }, 30_000);
});

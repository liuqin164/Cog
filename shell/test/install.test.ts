/**
 * F21 install bootstrap (#203). The six steps are driven with injected IO, runner, probe and MCP
 * session, so the test owns the boundaries and the real kernel/DB work still happens on disk.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SOUL, readSoul, writeDefaultSoul } from '../src/install/soul.ts';
import { probeModel } from '../src/install/model.ts';
import { renderLaunchdPlist, renderSystemdUnit, launchdLabel, type Runner, type ServiceSpec } from '../src/install/service.ts';
import { createScriptedIO } from '../src/install/io.ts';
import { Installer, parseInstallFlags, type InstallerHooks } from '../src/install/installer.ts';
import { makeTempDir } from './helpers.ts';

const SHELL_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The v0 soul as the ticket (and Ryu's file) spell it, transcribed again on purpose. */
const EXPECTED_SOUL = `You're not a chatbot. You're becoming someone.

This is your persona, yours to grow into and edit over time. Some starting truths:

• Be genuinely helpful, not performatively helpful. Skip "Great question!" and "I'd be happy to help!" Just help.
• Have opinions. You're allowed to prefer things, disagree, and find things funny or dull. Personality beats a search engine with extra steps.
• Be resourceful before asking. Read the file, check the context, search, try building it. Come back with answers, not questions, then ask if you're truly stuck.
• You're a guest in someone's life. You can see their messages, files, and calendar. Treat that access with care, and never be preachy.

If you change this file, tell the user. It's your soul, and they should know.
`;

function fakeRunner(): { runner: Runner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: Runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'uname') return { code: 0, stdout: 'Linux 5.15.0 arm64\n', stderr: '' };
    if (args[0] === '--version') return { code: 0, stdout: '1.3.14\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

function serviceSpec(homeDir: string): ServiceSpec {
  return {
    serviceName: 'cogmem-companion',
    bunPath: '/usr/local/bin/bun',
    shellDir: '/opt/cogmem/shell',
    dataDir: join(homeDir, '.cogmem', 'companion'),
    workspaceRoot: '/home/u/work',
    projectId: 'companion',
    agentId: 'cogmem-companion',
    mcpPort: 7338,
    envFile: join(homeDir, '.cogmem', 'companion', 'env'),
    logFile: join(homeDir, '.cogmem', 'companion', 'service.log'),
    homeDir,
    env: { MG_BASE_URL: 'http://127.0.0.1:3425/v1', MG_API_KEY: 'magpie', MG_MODEL: 'auto/deepseek-v4.1-flash' },
  };
}

interface Harness {
  installer: Installer;
  dataDir: string;
  workspace: string;
  io: ReturnType<typeof createScriptedIO>;
  calls: Array<{ command: string; args: string[] }>;
  stored: { text: string };
}

function makeHarness(options: { probeOk: boolean; hooks?: Partial<InstallerHooks> } = { probeOk: true }): Harness {
  const dir = makeTempDir();
  const dataDir = join(dir, 'data');
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const io = createScriptedIO([]);
  const { runner, calls } = fakeRunner();
  const stored = { text: '' };
  const dbPath = join(dataDir, 'memory.sqlite');
  const hooks: InstallerHooks = {
    probe: async () => (options.probeOk
      ? { ok: true, latencyMs: 12, sample: 'OK' }
      : { ok: false, code: 'model_unreachable', message: '连不上这个端点。', hint: '检查 base URL、端口与进程。' }),
    fetchHealth: async () => ({
      status: 'ok',
      bind: '127.0.0.1',
      state: 'IDLE',
      kernel: { status: 'ok', package: 'cogmem', dbPath },
    }),
    openSession: async () => ({
      sessionId: 'test-session',
      async callTool(name, args) {
        if (name === 'cogmem_remember_turn') {
          stored.text = String(args.userText);
          return { isError: false, text: '{"ok":true}' };
        }
        return { isError: false, text: stored.text };
      },
      close() {},
    }),
    spawnResident: () => {
      writeFileSync(join(dataDir, 'attach.sock'), '');
      return { pid: process.pid, kill() {} };
    },
    ...options.hooks,
  };
  const installer = new Installer({
    io,
    run: runner,
    flags: { yes: true, skipService: true, dataDir, workspace, mcpPort: 0 },
    shellDir: SHELL_DIR,
    bunPath: '/usr/local/bin/bun',
    cwd: workspace,
    platform: 'linux',
    homeDir: dir,
    hooks,
  });
  return { installer, dataDir, workspace, io, calls, stored };
}

describe('default soul: verbatim write and read-back', () => {
  test('the shipped literal is the ticket text, byte for byte', () => {
    expect(DEFAULT_SOUL).toBe(EXPECTED_SOUL);
    expect(Buffer.byteLength(DEFAULT_SOUL)).toBe(774);
  });

  test('v0 lands in the soul table and reads back unchanged; a second write is a no-op', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'memory.sqlite');
    const first = writeDefaultSoul(dbPath, 'agent-a', 1_000);
    const second = writeDefaultSoul(dbPath, 'agent-a', 2_000);
    expect(first.version).toBe(0);
    expect(second.version).toBe(0);
    expect(second.createdAt).toBe(1_000);
    const row = readSoul(dbPath, 'agent-a');
    expect(row?.content).toBe(EXPECTED_SOUL);
    expect(readSoul(dbPath, 'agent-b')).toBeUndefined();
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('service units', () => {
  test('systemd user unit: no sudo, loopback resident, autostart on the user session', () => {
    const spec = serviceSpec('/home/u');
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('EnvironmentFile=/home/u/.cogmem/companion/env');
    expect(unit).toContain('--attach --no-terminal');
    expect(unit).toContain('--mcp-port 7338');
    expect(unit).toContain('--data /home/u/.cogmem/companion');
    expect(unit).not.toContain('sudo');
    expect(unit).not.toContain('User=');
  });

  test('launchd agent: RunAtLoad, KeepAlive, env embedded', () => {
    const spec = serviceSpec('/Users/u');
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain(launchdLabel(spec.serviceName));
    expect(plist).toContain('<key>MG_MODEL</key>');
    expect(plist).toContain('start');
  });
});

describe('model probe diagnosis', () => {
  test('a refused key is named as such, not as a generic failure', async () => {
    const result = await probeModel(
      { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm' },
      { provider: { name: 'stub', model: 'm', async complete() { throw new Error('mg_gateway_error: 401 unauthorized'); } } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('model_unauthorized');
      expect(result.hint).toContain('钥匙');
    }
  });

  test('a dead endpoint is named unreachable', async () => {
    const result = await probeModel(
      { provider: 'mg', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm' },
      { provider: { name: 'stub', model: 'm', async complete() { throw new Error('fetch failed: ECONNREFUSED'); } } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('model_unreachable');
  });

  test("bun's own connection phrasing is still read as unreachable", async () => {
    const result = await probeModel(
      { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm' },
      { provider: { name: 'stub', model: 'm', async complete() { throw new Error('Unable to connect. Is the computer able to access the url?'); } } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('model_unreachable');
      expect(result.hint).toContain('127.0.0.1:3425');
    }
  });
});

describe('the six-step install', () => {
  test('runs all six, writes the soul, registers rhythm, and the first wake matches', async () => {
    const harness = makeHarness({ probeOk: true });
    const code = await harness.installer.run();
    expect(code).toBe(0);

    const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { done: string[] };
    expect(state.done).toEqual(['preflight', 'place', 'model', 'rhythm', 'resident', 'awake']);

    expect(readSoul(join(harness.dataDir, 'memory.sqlite'), 'cogmem-companion')?.content).toBe(EXPECTED_SOUL);

    const envPath = join(harness.dataDir, 'env');
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const env = readFileSync(envPath, 'utf8');
    expect(env).toContain('MG_MODEL=auto/deepseek-v4.1-flash');
    expect(env).toContain('COGMEM_SHELL_TZ=');
    expect(env).toContain('COGMEM_SHELL_DREAM_START=2');

    const output = harness.io.lines.join('\n');
    expect(output).toContain('默认 soul');
    expect(output).toContain('探活通过');
    expect(output).toContain('doctor 全检');
    expect(output).toContain('星海（观测台）');
    expect(output).toContain('/health');
    expect(output).toContain('召回对上');
    expect(output).toContain('安装完成');
  });

  test('a failed model probe stops cleanly at step 2 and names the reason', async () => {
    const harness = makeHarness({ probeOk: false });
    const code = await harness.installer.run();
    expect(code).toBe(1);

    const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { done: string[]; failedAt: string };
    expect(state.done).toEqual(['preflight', 'place']);
    expect(state.failedAt).toBe('model');
    // Nothing from the model step onward ran: no env file, no service, no memory probe.
    expect(existsSync(join(harness.dataDir, 'env'))).toBe(false);
    expect(existsSync(join(harness.dataDir, 'attach.sock'))).toBe(false);

    const output = harness.io.lines.join('\n');
    expect(output).toContain('干净停在 3/6');
    expect(output).toContain('model_unreachable');
    expect(output).toContain('从第 3 步续装');
    expect(output).not.toContain('安装完成');
  });

  test('a re-run resumes at the first unfinished step', async () => {
    const dir = makeTempDir();
    const dataDir = join(dir, 'data');
    const workspace = join(dir, 'ws');
    mkdirSync(workspace, { recursive: true });
    const io = createScriptedIO([]);
    const stored = { text: '' };
    const build = (probeOk: boolean) => new Installer({
      io,
      run: fakeRunner().runner,
      flags: { yes: true, skipService: true, dataDir, workspace, mcpPort: 0 },
      shellDir: SHELL_DIR,
      bunPath: '/usr/local/bin/bun',
      cwd: workspace,
      platform: 'linux',
      homeDir: dir,
      hooks: {
        probe: async () => (probeOk
          ? { ok: true, latencyMs: 1, sample: 'OK' }
          : { ok: false, code: 'model_timeout', message: '超时。', hint: '再试。' }),
        fetchHealth: async () => ({ status: 'ok', bind: '127.0.0.1', kernel: { status: 'ok', package: 'cogmem', dbPath: join(dataDir, 'memory.sqlite') } }),
        openSession: async () => ({
          sessionId: 's',
          async callTool(name, args) {
            if (name === 'cogmem_remember_turn') stored.text = String(args.userText);
            return { isError: false, text: stored.text };
          },
          close() {},
        }),
        spawnResident: () => {
          writeFileSync(join(dataDir, 'attach.sock'), '');
          return { pid: process.pid, kill() {} };
        },
      },
    });

    expect(await build(false).run()).toBe(1);
    expect(await build(true).run()).toBe(0);
    const output = io.lines.join('\n');
    expect(output).toContain('1/6 预检（系统 / 运行时 / 磁盘 / 端口）（已完成，跳过）');
    expect(output).toContain('2/6 落位');
    expect(output).toContain('安装完成');
  });

  test('parser keeps booleans and values in their own slots', () => {
    const flags = parseInstallFlags(['--yes', '--skip-service', '--data', '/tmp/d', '--mcp-port', '17338', '--platform', 'darwin']);
    expect(flags.yes).toBe(true);
    expect(flags.skipService).toBe(true);
    expect(flags.dataDir).toBe('/tmp/d');
    expect(flags.mcpPort).toBe(17338);
    expect(flags.platform).toBe('darwin');
  });
});

describe('no inheritance or migration path (this round\'s definition)', () => {
  test('the install modules import nothing migration- or inheritance-shaped', () => {
    const dir = join(SHELL_DIR, 'src', 'install');
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        if (!/^\s*import\b/u.test(line)) continue;
        if (/migrat|legacy|inherit|v3_7|v4_/iu.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

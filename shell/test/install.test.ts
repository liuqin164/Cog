/**
 * F21 install bootstrap (#203). The six steps are driven with injected IO, runner, probe and attach
 * probe session, so the test owns the boundaries and the real kernel/DB work still happens on disk.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SOUL, readSoul, writeDefaultSoul } from '../src/install/soul.ts';
import { probeModel } from '../src/install/model.ts';
import { renderLaunchdPlist, renderSystemdUnit, residentArgs, launchdLabel, type Runner, type ServiceSpec } from '../src/install/service.ts';
import { createScriptedIO } from '../src/install/io.ts';
import { Installer, parseEnvFile, parseInstallFlags, type InstallerHooks, type InstallFlags } from '../src/install/installer.ts';
import { cliEntry, cogEntry, defaultShellHome, isSourceShell, supervisorEntry } from '../src/install/layout.ts';
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
    httpPort: 7338,
    envFile: join(homeDir, '.cogmem', 'companion', 'env'),
    logFile: join(homeDir, '.cogmem', 'companion', 'service.log'),
    homeDir,
    env: { MG_BASE_URL: 'http://127.0.0.1:3425/v1', MG_API_KEY: 'magpie', MG_MODEL: 'auto/deepseek-v4.1-flash' },
  };
}

interface Harness {
  installer: Installer;
  buildInstaller: () => Installer;
  dataDir: string;
  workspace: string;
  io: ReturnType<typeof createScriptedIO>;
  calls: Array<{ command: string; args: string[] }>;
  stored: { text: string };
}

function makeHarness(options: {
  probeOk: boolean;
  hooks?: Partial<InstallerHooks>;
  io?: ReturnType<typeof createScriptedIO>;
  flags?: Partial<InstallFlags>;
  shellDir?: string;
  /** Overrides where the workspace sits, given the harness's own temp root (e.g. `(dir) => dir`). */
  workspaceRoot?: (dir: string) => string;
  platform?: string;
} = { probeOk: true }): Harness {
  const dir = makeTempDir();
  const dataDir = join(dir, 'data');
  const workspace = options.workspaceRoot?.(dir) ?? join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const io = options.io ?? createScriptedIO([]);
  const { runner, calls } = fakeRunner();
  const stored = { text: '' };
  const dbPath = join(dataDir, 'memory.sqlite');
  const hooks: InstallerHooks = {
    ensureEmbedding: async () => ({ ok: true, downloaded: false, detail: 'test stub' }),
    probe: async () => (options.probeOk
      ? { ok: true, latencyMs: 12, sample: 'OK' }
      : { ok: false, code: 'model_unreachable', message: '连不上这个端点。', hint: '检查 base URL、端口与进程。' }),
    fetchHealth: async () => ({
      status: 'ok',
      bind: '127.0.0.1',
      state: 'IDLE',
      kernel: { status: 'ok', package: 'cogmem', dbPath },
    }),
    openProbe: async () => ({
      async remember(text) {
        stored.text = text;
        return { ok: true, text: 'evt-1' };
      },
      async recall() {
        return { ok: true, text: stored.text };
      },
      async embed() {
        return { ok: true, text: 'dimensions=768', dimensions: 768 };
      },
      close() {},
    }),
    spawnResident: () => {
      writeFileSync(join(dataDir, 'attach.sock'), '');
      return { pid: process.pid, kill() {} };
    },
    ...options.hooks,
  };
  const buildInstaller = () => new Installer({
    io,
    run: runner,
    flags: {
      yes: true,
      skipService: true,
      dataDir,
      workspace,
      httpPort: 0,
      provider: 'mg',
      baseUrl: 'http://127.0.0.1:3425/v1',
      model: 'auto/deepseek-v4.1-flash',
      ...options.flags,
    },
    shellDir: options.shellDir ?? SHELL_DIR,
    bunPath: '/usr/local/bin/bun',
    cwd: workspace,
    platform: options.platform ?? 'linux',
    homeDir: dir,
    hooks,
  });
  const installer = buildInstaller();
  return { installer, buildInstaller, dataDir, workspace, io, calls, stored };
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
    expect(unit).toContain('MemoryHigh=1536M');
    expect(unit).toContain('MemoryMax=2048M');
    expect(unit).toContain('Documentation=https://github.com/liuqin164/Cog');
    expect(unit).not.toContain('liuqin164/cogmem');
    expect(unit).toContain('StartLimitIntervalSec=300');
    expect(unit).toContain('StartLimitBurst=5');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ProtectHome=read-only');
    expect(unit).toContain(`ReadWritePaths=${spec.workspaceRoot} ${spec.dataDir}`);
    expect(unit).toContain('RestrictSUIDSGID=true');
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK');
    expect(unit).toContain('EnvironmentFile=/home/u/.cogmem/companion/env');
    expect(unit).toContain('--attach --no-terminal');
    expect(unit).toContain('--http-port 7338');
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

  test('a missing model is named as a model problem, not a generic HTTP error', async () => {
    const result = await probeModel(
      { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'nope' },
      { provider: { name: 'stub', model: 'nope', async complete() { throw new Error('mg_gateway_error: 404 {"error":{"message":"model not found"}}'); } } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('model_not_found');
      expect(result.hint).toContain('模型名');
    }
  });

  test('a timeout is named as a timeout, and 429 keeps its rate-limit name', async () => {
    const timedOut = await probeModel(
      { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm' },
      { provider: { name: 'stub', model: 'm', async complete() { throw new Error('TimeoutError: The operation was aborted due to timeout'); } } },
    );
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.code).toBe('model_timeout');

    const limited = await probeModel(
      { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm' },
      { provider: { name: 'stub', model: 'm', async complete() { throw new Error('mg_gateway_error: 429 rate limit exceeded'); } } },
    );
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.code).toBe('model_rate_limited');
  });

  test('a diagnosis never echoes the key, even when the endpoint does', async () => {
    const result = await probeModel(
      { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-leak-me', model: 'm' },
      { provider: { name: 'stub', model: 'm', async complete() { throw new Error('mg_gateway_error: 401 {"error":{"message":"bad key sk-leak-me"}}'); } } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('model_unauthorized');
      expect(`${result.message} ${result.hint}`).not.toContain('sk-leak-me');
      expect(result.hint).toContain('钥匙');
    }
  });

  test('the real probe passes against a local fake OpenAI endpoint (no stub)', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    try {
      const result = await probeModel({ provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-real', model: 'test-model' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.sample).toBe('OK');
    } finally {
      server.stop(true);
    }
  });
});

describe('the six-step install', () => {
  test('macOS is refused before any state write, plist or launchctl, even when install.json says preflight is done', async () => {
    const harness = makeHarness({ probeOk: true, platform: 'darwin' });
    mkdirSync(harness.dataDir, { recursive: true });
    const statePath = join(harness.dataDir, 'install.json');
    const stateBefore = `${JSON.stringify({
      schema: 1,
      done: ['preflight', 'place', 'model', 'rhythm', 'resident', 'awake'],
      choices: { platform: 'darwin', serviceName: 'cogmem-companion' },
      updatedAt: 1,
    }, null, 2)}\n`;
    writeFileSync(statePath, stateBefore);

    expect(await harness.installer.run()).toBe(1);

    const output = harness.io.lines.join('\n');
    expect(output).toContain('平台：macOS');
    expect(output).toContain('不支持的平台：macOS');
    expect(output).toContain('只支持 Linux');
    expect(harness.calls).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(existsSync(join(harness.dataDir, 'observatory-token'))).toBe(false);
    expect(existsSync(join(harness.dataDir, 'env'))).toBe(false);
    expect(existsSync(join(harness.dataDir, '..', 'Library', 'LaunchAgents'))).toBe(false);
  });

  test('--uninstall on macOS is still allowed and removes an old plist', async () => {
    const harness = makeHarness({ probeOk: true, platform: 'darwin', flags: { uninstall: true } });
    mkdirSync(harness.dataDir, { recursive: true });
    writeFileSync(join(harness.dataDir, 'install.json'), `${JSON.stringify({
      schema: 1,
      done: ['preflight', 'place', 'model', 'rhythm', 'resident', 'awake'],
      choices: { platform: 'darwin', serviceName: 'cogmem-companion' },
      updatedAt: 1,
    })}\n`);
    const launchAgents = join(harness.dataDir, '..', 'Library', 'LaunchAgents');
    const plist = join(launchAgents, `${launchdLabel('cogmem-companion')}.plist`);
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(plist, 'old plist\n');

    expect(await harness.installer.run()).toBe(0);

    expect(existsSync(plist)).toBe(false);
    expect(harness.calls).toContainEqual({ command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 501}/${launchdLabel('cogmem-companion')}`] });
  });

  test('the rhythm step refuses a zero-length dream window and says why', async () => {
    const io = createScriptedIO(['小海', 'UTC', '3', '3', '', 'y']);
    const harness = makeHarness({ probeOk: true, io, flags: { yes: false } });
    const step = (harness.installer as unknown as {
      stepRhythm(): Promise<{ ok: boolean; message?: string; hint?: string }>;
    }).stepRhythm();
    const result = await step;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('窗口长度为零');
    expect(result.hint).toContain('23 → 6');
    expect(harness.io.lines.join('\n')).not.toContain('节律已写入');
  });

  test('runs all six, writes the soul, registers rhythm, and the first wake matches', async () => {
    const harness = makeHarness({ probeOk: true });
    const code = await harness.installer.run();
    expect(code).toBe(0);

    const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { done: string[]; choices: { companionName?: string } };
    expect(state.done).toEqual(['preflight', 'place', 'model', 'rhythm', 'resident', 'awake']);
    expect(state.choices.companionName).toBe('Cog');

    expect(readSoul(join(harness.dataDir, 'memory.sqlite'), 'cogmem-companion')?.content).toBe(EXPECTED_SOUL);

    const envPath = join(harness.dataDir, 'env');
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const env = readFileSync(envPath, 'utf8');
    expect(env).toContain('MG_MODEL=auto/deepseek-v4.1-flash');
    expect(env).toContain('COG_TZ=');
    expect(env).toContain('COG_DREAM_START=2');
    // The observatory's soul-write token (#283): minted once, owner-only.
    const tokenPath = join(harness.dataDir, 'observatory-token');
    expect(readFileSync(tokenPath, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/u);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    // mg is the built-in route: a default install writes no custom-route file at all.
    expect(existsSync(join(harness.dataDir, 'routes.json'))).toBe(false);

    const output = harness.io.lines.join('\n');
    expect(output).toContain('平台：Linux');
    expect(output).toContain('默认 soul');
    expect(output).toContain('探活通过');
    expect(output).toContain('doctor 全检');
    expect(output).toContain('星海（观测台）');
    expect(output).toContain('/health');
    expect(output).toContain('召回对上');
    expect(output).toContain('安装完成');
  });

  test('the plugin registry preinstalls the official channel and a re-run never overwrites it', async () => {
    const harness = makeHarness({ probeOk: true });
    expect(await harness.installer.run()).toBe(0);
    const pluginsPath = join(harness.dataDir, 'plugins.json');
    expect(JSON.parse(readFileSync(pluginsPath, 'utf8'))).toEqual(['builtin:web-channel', 'builtin:telegram-channel']);
    expect(statSync(pluginsPath).mode & 0o777).toBe(0o600);

    // What `/plugins add` would have written. A re-run that goes through the place step again (a lost
    // install.json is the realistic case) must keep it, the same way budgets.json is kept.
    writeFileSync(pluginsPath, `${JSON.stringify(['./plugins/hello.ts'])}\n`, 'utf8');
    const token = readFileSync(join(harness.dataDir, 'observatory-token'), 'utf8');
    rmSync(join(harness.dataDir, 'install.json'), { force: true });
    expect(await harness.installer.run()).toBe(0);
    expect(JSON.parse(readFileSync(pluginsPath, 'utf8'))).toEqual(['./plugins/hello.ts']);
    expect(readFileSync(join(harness.dataDir, 'observatory-token'), 'utf8')).toBe(token);
  });

  test('a fresh install persists a stable session id; a re-run with the state file gone keeps it', async () => {
    const first = makeHarness({ probeOk: true });
    expect(await first.installer.run()).toBe(0);
    const envPath = join(first.dataDir, 'env');
    const original = parseEnvFile(envPath).COG_SESSION;
    expect(original).toMatch(/^session-[0-9a-f-]{36}$/u);

    // A second fresh install is a different identity, not a copied constant.
    const other = makeHarness({ probeOk: true });
    expect(await other.installer.run()).toBe(0);
    expect(parseEnvFile(join(other.dataDir, 'env')).COG_SESSION).not.toBe(original);

    // Losing install.json makes the place step run again; the value already on disk must survive.
    rmSync(join(first.dataDir, 'install.json'), { force: true });
    expect(await first.buildInstaller().run()).toBe(0);
    expect(parseEnvFile(envPath).COG_SESSION).toBe(original);
    expect(first.io.lines.join('\n')).toContain('沿用已有');
  });

  test('an install that predates the session id gets one without losing the rest of its env file', async () => {
    const harness = makeHarness({ probeOk: true });
    mkdirSync(harness.dataDir, { recursive: true });
    writeFileSync(join(harness.dataDir, 'env'), 'MG_API_KEY=keep-me\n', { mode: 0o600 });

    expect(await harness.installer.run()).toBe(0);
    const env = parseEnvFile(join(harness.dataDir, 'env'));
    expect(env.MG_API_KEY).toBe('keep-me');
    expect(env.COG_SESSION).toMatch(/^session-[0-9a-f-]{36}$/u);
  });

  test('a failed model probe stops cleanly at step 2 and names the reason', async () => {
    const harness = makeHarness({ probeOk: false });
    const code = await harness.installer.run();
    expect(code).toBe(1);

    const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { done: string[]; failedAt: string };
    expect(state.done).toEqual(['preflight', 'place']);
    expect(state.failedAt).toBe('model');
    // Nothing from the model step onward ran: the env file holds only the session id, no model key,
    // no service and no memory probe.
    expect(readFileSync(join(harness.dataDir, 'env'), 'utf8')).toMatch(/^COG_SESSION=session-/u);
    expect(readFileSync(join(harness.dataDir, 'env'), 'utf8')).not.toContain('MG_API_KEY');
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
      flags: {
        yes: true,
        skipService: true,
        dataDir,
        workspace,
        httpPort: 0,
        provider: 'mg',
        baseUrl: 'http://127.0.0.1:3425/v1',
        model: 'auto/deepseek-v4.1-flash',
      },
      shellDir: SHELL_DIR,
      bunPath: '/usr/local/bin/bun',
      cwd: workspace,
      platform: 'linux',
      homeDir: dir,
      hooks: {
        ensureEmbedding: async () => ({ ok: true, downloaded: false, detail: 'test stub' }),
        probe: async () => (probeOk
          ? { ok: true, latencyMs: 1, sample: 'OK' }
          : { ok: false, code: 'model_timeout', message: '超时。', hint: '再试。' }),
        fetchHealth: async () => ({ status: 'ok', bind: '127.0.0.1', kernel: { status: 'ok', package: 'cogmem', dbPath: join(dataDir, 'memory.sqlite') } }),
        openProbe: async () => ({
          async remember(text) {
            stored.text = text;
            return { ok: true, text: 'evt-1' };
          },
          async recall() {
            return { ok: true, text: stored.text };
          },
          async embed() {
            return { ok: true, text: 'dimensions=768', dimensions: 768 };
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
  }, 60_000);

  test('a damaged install.json is reported and kept, not treated as a fresh install', () => {
    const harness = makeHarness();
    mkdirSync(harness.dataDir, { recursive: true });
    writeFileSync(join(harness.dataDir, 'install.json'), '{ not json');
    expect(() => harness.buildInstaller()).toThrow('install_state_corrupt');
    expect(readFileSync(join(harness.dataDir, 'install.json.broken'), 'utf8')).toBe('{ not json');
    expect(existsSync(join(harness.dataDir, 'install.json'))).toBe(false);
  });

  test('a failed env or state write leaves the previous file whole', async () => {
    const harness = makeHarness({ probeOk: true });
    mkdirSync(harness.dataDir, { recursive: true });
    const statePath = join(harness.dataDir, 'install.json');
    const stateBefore = `${JSON.stringify({ schema: 1, done: ['preflight', 'place'], choices: {}, updatedAt: 1 }, null, 2)}\n`;
    writeFileSync(statePath, stateBefore);
    const envPath = join(harness.dataDir, 'env');
    writeFileSync(envPath, 'MG_MODEL=old-model\n');
    mkdirSync(`${statePath}.${process.pid}.tmp`);
    mkdirSync(`${envPath}.${process.pid}.tmp`);

    await expect(harness.buildInstaller().run()).rejects.toThrow();
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(readFileSync(envPath, 'utf8')).toBe('MG_MODEL=old-model\n');
  });

  test('a workspace that is $HOME is called out loudly and recorded (#302)', async () => {
    const harness = makeHarness({ probeOk: true, workspaceRoot: (dir) => dir });
    expect(await harness.installer.run()).toBe(0);

    const output = harness.io.lines.join('\n');
    expect(output).toContain('[警告] workspace 落在危险位置');
    expect(output).toContain('workspace 就是家目录');
    // `--yes` is on in this harness, and the warning still reached the output and the state file.
    const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { workspaceWarning?: string };
    expect(state.workspaceWarning).toContain('workspace 就是家目录');
  });

  test('a dedicated workspace gets no warning', async () => {
    const harness = makeHarness({ probeOk: true });
    expect(await harness.installer.run()).toBe(0);
    expect(harness.io.lines.join('\n')).not.toContain('workspace 落在危险位置');
  });

  test('an installed package layout resolves every entry without a source checkout', () => {
    const dir = makeTempDir();
    const pkg = join(dir, 'node_modules', 'cogmem');
    mkdirSync(join(pkg, 'dist', 'shell', 'install'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'shell', 'cli.js'), '');
    writeFileSync(join(pkg, 'dist', 'public.js'), '');

    expect(isSourceShell(pkg)).toBe(false);
    expect(cliEntry(pkg)).toBe(join(pkg, 'dist', 'shell', 'cli.js'));
    expect(cogEntry(pkg)).toBe(join(pkg, 'dist', 'shell', 'cog.js'));
    expect(supervisorEntry(pkg)).toBe(join(pkg, 'dist', 'shell', 'upgrade', 'supervisor.js'));
    expect(defaultShellHome(join(pkg, 'dist', 'shell', 'install'))).toBe(pkg);
    const spec = { ...serviceSpec(dir), shellDir: pkg };
    expect(residentArgs(spec)).toContain(join(pkg, 'dist', 'shell', 'cli.js'));
  });

  test('a degraded semantic lane is reported at install time, not hidden behind lexical recall (#280)', async () => {
    const harness = makeHarness({
      probeOk: true,
      hooks: {
        openProbe: async () => ({
          async remember(text: string) {
            harness.stored.text = text;
            return { ok: true, text: 'evt-1' };
          },
          async recall() {
            // Lexical recall still matches, which is exactly why it cannot be the only probe.
            return { ok: true, text: harness.stored.text };
          },
          async embed() {
            return { ok: false, text: 'embedding_unavailable: worker script rejected' };
          },
          close() {},
        }),
      },
    });

    expect(await harness.installer.run()).toBe(0);
    const output = harness.io.lines.join('\n');
    expect(output).toContain('语义探针：未通过');
    expect(output).toContain('语义召回未就绪');
    expect(output).toContain('embedding_unavailable');
    expect(output).not.toContain('六步全过');
  });

  test('parser keeps booleans and values in their own slots', () => {
    const flags = parseInstallFlags(['--yes', '--skip-service', '--data', '/tmp/d', '--http-port', '17338', '--platform', 'linux']);
    expect(flags.yes).toBe(true);
    expect(flags.skipService).toBe(true);
    expect(flags.dataDir).toBe('/tmp/d');
    expect(flags.httpPort).toBe(17338);
    expect(flags.platform).toBe('linux');
  });

  test('--yes without a model route fails before the probe and names every missing flag', async () => {
    let probed = false;
    const harness = makeHarness({
      probeOk: true,
      flags: { provider: undefined, baseUrl: undefined, model: undefined },
      hooks: {
        probe: async () => {
          probed = true;
          return { ok: true, latencyMs: 1, sample: 'OK' };
        },
      },
    });

    expect(await harness.installer.run()).toBe(1);
    expect(probed).toBe(false);
    expect(existsSync(join(harness.dataDir, 'install.json'))).toBe(false);
    const output = harness.io.lines.join('\n');
    expect(output).toContain('安装没有开始：--yes 缺少模型路线参数');
    expect(output).toContain('--provider、--base-url、--model');
    expect(output).not.toContain('探活：');
  });
});

describe('the model step: a custom OpenAI-protocol route', () => {
  test('collects name / baseUrl / model / key, probes, persists a 0600 route, and never prints the key', async () => {
    const io = createScriptedIO([
      'openai_compatible',
      'http://127.0.0.1:9/v1',
      'my-model',
      'myroute',
      'sk-custom-secret',
      '',
      '小海',
      '',
      '',
      '',
      '',
      'y',
    ]);
    const probed: Array<{ provider: string; baseUrl: string; model: string }> = [];
    const harness = makeHarness({
      probeOk: true,
      io,
      flags: { yes: false },
      hooks: {
        probe: async (choice) => {
          probed.push({ provider: choice.provider, baseUrl: choice.baseUrl, model: choice.model });
          return { ok: true, latencyMs: 3, sample: 'OK' };
        },
      },
    });

    expect(await harness.installer.run()).toBe(0);
    expect(probed).toEqual([{ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'my-model' }]);
    // The route is the first question the installer asks; nothing has a provider default.
    expect(io.lines.find((line) => line.includes(' -> '))).toContain('模型路线');

    const routesPath = join(harness.dataDir, 'routes.json');
    expect(statSync(routesPath).mode & 0o777).toBe(0o600);
    const routes = JSON.parse(readFileSync(routesPath, 'utf8')) as { active: string; routes: unknown[] };
    expect(routes.active).toBe('myroute');
    expect(routes.routes).toEqual([{ name: 'myroute', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-custom-secret', model: 'my-model' }]);

    const output = io.lines.join('\n');
    expect(output).toContain('自定义路线「myroute」');
    expect(output).toContain('内置 mg 网关路线原样保留');
    expect(output).not.toContain('sk-custom-secret');

    // The built-in mg route is untouched: the env file keeps mg's own pointer, not the custom endpoint.
    const env = readFileSync(join(harness.dataDir, 'env'), 'utf8');
    expect(env).not.toContain('sk-custom-secret');
    expect(env).not.toContain('http://127.0.0.1:9/v1');
    expect(env).not.toContain('MG_API_KEY=sk-custom-secret');
  });

  test('a custom route that fails its probe stops at the model step and writes no route', async () => {
    const io = createScriptedIO(['openai_compatible', 'http://127.0.0.1:1/v1', 'my-model', 'myroute', 'sk-dead']);
    const harness = makeHarness({
      probeOk: false,
      io,
      flags: { yes: false },
      hooks: {
        probe: async () => ({ ok: false, code: 'model_unreachable', message: '连不上这个端点。', hint: '检查 base URL、端口与进程。' }),
      },
    });

    expect(await harness.installer.run()).toBe(1);
    expect(existsSync(join(harness.dataDir, 'routes.json'))).toBe(false);
    const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { done: string[]; failedAt: string };
    expect(state.done).toEqual(['preflight', 'place']);
    expect(state.failedAt).toBe('model');
    expect(io.lines.join('\n')).not.toContain('sk-dead');
  });
});

describe('the vector provider step (#313)', () => {
  test('a remote provider is probed and its config lands in the 0600 env file, never the key in output', async () => {
    const previous = process.env.COGMEM_EMBEDDING_API_KEY;
    process.env.COGMEM_EMBEDDING_API_KEY = 'sk-vector-secret';
    try {
      const harness = makeHarness({
        probeOk: true,
        flags: {
          embeddingProvider: 'openai',
          embeddingBaseUrl: 'http://127.0.0.1:9/v1',
          embeddingModel: 'text-embedding-v3',
          embeddingDimensions: '1024',
        },
        hooks: {
          probeEmbedding: async (config, key) => {
            expect(config.provider).toBe('openai');
            expect(key).toBe('sk-vector-secret');
            return { ok: true, dimensions: 1024, detail: 'fixture' };
          },
        },
      });

      expect(await harness.installer.run()).toBe(0);
      const env = readFileSync(join(harness.dataDir, 'env'), 'utf8');
      expect(env).toContain('COGMEM_EMBEDDING_PROVIDER=openai');
      expect(env).toContain('COGMEM_EMBEDDING_BASE_URL=http://127.0.0.1:9/v1');
      expect(env).toContain('COGMEM_EMBEDDING_MODEL=text-embedding-v3');
      expect(env).toContain('COGMEM_EMBEDDING_DIMENSIONS=1024');
      expect(env).toContain('COGMEM_EMBEDDING_API_KEY=sk-vector-secret');
      expect(harness.io.lines.join('\n')).not.toContain('sk-vector-secret');

      const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { choices: { embedding: unknown } };
      expect(state.choices.embedding).toEqual({
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'text-embedding-v3',
        dimensions: 1024,
      });
      expect(JSON.stringify(state)).not.toContain('sk-vector-secret');
    } finally {
      if (previous === undefined) delete process.env.COGMEM_EMBEDDING_API_KEY;
      else process.env.COGMEM_EMBEDDING_API_KEY = previous;
    }
  });

  test('a failed vector probe stops the install at the model step', async () => {
    const harness = makeHarness({
      probeOk: true,
      flags: {
        embeddingProvider: 'ollama',
        embeddingBaseUrl: 'http://127.0.0.1:9',
        embeddingModel: 'qwen3-embedding:0.6b',
      },
      hooks: {
        probeEmbedding: async () => ({ ok: false, detail: '端点没有返回向量' }),
      },
    });

    expect(await harness.installer.run()).toBe(1);
    expect(harness.io.lines.join('\n')).toContain('向量探针失败');
    const state = JSON.parse(readFileSync(join(harness.dataDir, 'install.json'), 'utf8')) as { done: string[]; failedAt: string };
    expect(state.done).toEqual(['preflight', 'place']);
    expect(state.failedAt).toBe('model');
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

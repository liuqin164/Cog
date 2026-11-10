import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { PluginHost } from '../src/plugins/host.ts';
import { PiCompatAdapter, resolvePiExtensionEntry } from '../src/pi/adapter.ts';
import { PI_TARGET_PACKAGE, PI_TARGET_VERSION } from '../src/pi/target.ts';
import { makeTempDir } from './helpers.ts';

const shellRoot = join(import.meta.dir, '..');
const repoRoot = join(shellRoot, '..');

async function online(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4_000) });
    return response.ok;
  } catch {
    return false;
  }
}

interface CapturedMessage {
  text: string;
  deliverAs: string;
  customType?: string;
}

const ianaUp = await online('https://www.iana.org/help/example-domains');

describe('Pi compatibility adapter', () => {
  test('the pinned target version is the installed one', () => {
    const manifest = JSON.parse(readFileSync(join(shellRoot, 'node_modules', PI_TARGET_PACKAGE, 'package.json'), 'utf8')) as { version: string };
    expect(manifest.version).toBe(PI_TARGET_VERSION);
  });

  test('the real plugin set is pinned by version in the test', () => {
    const toolPlugin = JSON.parse(readFileSync(join(shellRoot, 'node_modules', 'pi-web-access', 'package.json'), 'utf8')) as { version: string };
    const channelPlugin = JSON.parse(readFileSync(join(shellRoot, 'node_modules', '@lalalic', 'channel', 'package.json'), 'utf8')) as { version: string };
    expect(toolPlugin.version).toBe('0.47.0');
    expect(channelPlugin.version).toBe('1.0.6');
  });

  test.skipIf(!ianaUp)('a real tool plugin loads and one tool executes', async () => {
    const host = new PluginHost();
    host.seedService('eventBus', host.bus);
    const adapter = new PiCompatAdapter({ host, pluginName: 'pi-web-access', cwd: shellRoot, sessionId: 's' });
    const result = await adapter.load(resolvePiExtensionEntry('pi-web-access', shellRoot));
    await adapter.emitSessionStart();
    expect(result.status).toBe('loaded');
    expect(result.version).toBe('0.47.0');
    expect(result.tools).toContain('fetch_content');
    expect(host.tools.has('fetch_content')).toBe(true);
    const output = await host.tools.invoke('fetch_content', { toolCallId: 't1', input: { url: 'https://www.iana.org/help/example-domains', mode: 'raw' } }, { runId: 'r' });
    expect(output.isError).toBe(false);
    expect(output.output.length).toBeGreaterThan(100);
  }, 60_000);

  test('a real channel plugin delivers an inbound message to the shell', async () => {
    const dir = makeTempDir('pi-channel-');
    const cwd = join(dir, 'agent');
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()));
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify({
        channels: [{ id: 'wechat-main', name: 'Ryu', type: 'wechat', enabled: true, channel: 'Ryu', wechatDaemon: `ws://127.0.0.1:${port}`, default: true, forwardToolCalls: true }],
      }),
      'utf8',
    );
    const fakeBro = join(cwd, 'wechat-bro');
    writeFileSync(
      fakeBro,
      '#!/usr/bin/env bun\nlet buffer = "";\nprocess.stdin.on("data", (chunk) => { buffer += chunk; const index = buffer.indexOf("\\n"); if (index < 0) return; const request = JSON.parse(buffer.slice(0, index)); if (request.cmd === "status") console.log(JSON.stringify({ ok: true, data: { loggedIn: true } })); else console.log(JSON.stringify({ ok: true })); });\n',
      'utf8',
    );
    chmodSync(fakeBro, 0o755);

    const previousBin = process.env.WECHAT_BRO_BIN;
    process.env.WECHAT_BRO_BIN = fakeBro;
    const received: CapturedMessage[] = [];
    const host = new PluginHost();
    host.seedService('eventBus', host.bus);
    const adapter = new PiCompatAdapter({
      host,
      pluginName: '@lalalic/channel',
      cwd,
      sessionId: 's',
      onSendMessage: (message) => received.push(message),
    });
    try {
      const result = await adapter.load(resolvePiExtensionEntry('@lalalic/channel', shellRoot));
      expect(result.status).toBe('loaded');
      expect(result.version).toBe('1.0.6');
      expect(result.dropped.some((entry) => entry.startsWith('registerMessageRenderer'))).toBe(true);
      await adapter.emitSessionStart();
      const client = await new Promise<any>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('channel plugin did not open its WebSocket')), 8_000);
        server.once('connection', (socket: any) => {
          clearTimeout(timer);
          resolvePromise(socket);
        });
      });
      client.send(JSON.stringify({ event: 'message:private', data: { from: 'Ryu', Content: 'hello from the channel', MsgId: 'm1', timestamp: Math.floor(Date.now() / 1000) } }));
      const started = Date.now();
      while (received.length === 0 && Date.now() - started < 8_000) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      expect(received.length).toBeGreaterThan(0);
      expect(received[0].text).toContain('hello from the channel');
      expect(received[0].text).toContain('<channel-ctx');
      expect(received[0].customType).toBe('channel-inbound');
      expect(received[0].deliverAs).toBe('followUp');
      await adapter.emitSessionShutdown();
    } finally {
      process.env.WECHAT_BRO_BIN = previousBin;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }, 30_000);

  test('deleting the adapter leaves the shell and native plugins working', async () => {
    const dir = makeTempDir('pi-detach-');
    const copy = join(dir, 'shell');
    mkdirSync(copy, { recursive: true });
    cpSync(join(shellRoot, 'src'), join(copy, 'src'), { recursive: true });
    rmSync(join(copy, 'src', 'pi'), { recursive: true, force: true });
    expect(existsSync(join(copy, 'src', 'pi'))).toBe(false);
    symlinkSync(join(shellRoot, 'node_modules'), join(copy, 'node_modules'), 'dir');
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'detached-shell', private: true, type: 'module' }), 'utf8');
    writeFileSync(
      join(copy, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          types: ['bun-types'],
          baseUrl: '.',
          paths: { cogmem: [join(repoRoot, 'src', 'public.ts')], 'cogmem/internal': [join(repoRoot, 'src', 'internal.ts')] },
        },
        include: ['src/**/*.ts'],
      }),
      'utf8',
    );
    writeFileSync(
      join(copy, 'detach.ts'),
      [
        "import { CompanionShell } from './src/app.ts';",
        "import { mkdirSync } from 'node:fs';",
        'const dir = process.argv[2]!;',
        "const provider = { name: 'scripted', model: 'scripted/detached', async complete() { return { text: 'detached reply', toolCalls: [] }; } };",
        'const shell = new CompanionShell({',
        '  config: { workspaceRoot: dir, dataDir: dir + "/data", dbPath: dir + "/data/memory.sqlite", timeZone: "UTC", projectId: "detached", agentId: "detached-agent", sessionId: "s", terminalEnabled: false, mcp: { enabled: false, port: 0, hostname: "127.0.0.1", path: "/mcp", profile: "core" }, pi: { adapterEnabled: false, plugins: [] } },',
        '  modelProvider: provider,',
        '  tick: false,',
        '});',
        'await shell.start();',
        'const summary = await shell.submit("hello");',
        "console.log('REPLY:' + (summary?.assistantText ?? ''));",
        'await shell.stop();',
      ].join('\n'),
      'utf8',
    );
    const child = spawn('bun', [join(copy, 'detach.ts'), join(dir, 'ws')], { cwd: copy, env: { ...process.env, TMPDIR: join(shellRoot, '.tmp') } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolvePromise) => child.once('exit', (exitCode) => resolvePromise(exitCode)));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('REPLY:detached reply');
  }, 60_000);

  test('the core has no static import of the adapter', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'pi') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(join(shellRoot, 'src'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from\s+['"][^'"]*pi\/adapter/);
    }
    expect(readFileSync(join(shellRoot, 'src', 'app.ts'), 'utf8')).toContain("await import('./pi/adapter.ts')");
  });
});

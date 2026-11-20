/**
 * The companion-reachable native plugin install surface (#223, converted in #224): `/plugins add`
 * registers a native plugin in the data directory, the next process loads it, and the load result
 * is a fact on the health face.
 *
 * The cycle here is the acceptance's: register in one process, start a second process on the same
 * data directory (the restart), and read the loaded list back. The restart itself is a service
 * manager call in production and is injected; the "no manager" path is exercised for real.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionShell } from '../src/app.ts';
import { defaultShellConfig } from '../src/config.ts';
import { CheckpointStore, emptyCheckpoint } from '../src/state/checkpoint.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'native-plugin.ts');

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe('register in one process, load in the next', () => {
  test('the full cycle: /plugins add → new process → loaded list on /health', async () => {
    const dir = makeTempDir('native-install-');
    const dataDir = join(dir, 'data');

    const firstConfig = defaultShellConfig({ dataDir, workspaceRoot: dir });
    expect(firstConfig.plugins).toEqual([]);
    const first = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { dataDir, plugins: firstConfig.plugins });
    await first.start();
    try {
      const reply = await first.runCommand('plugins', `add ${FIXTURE}`);
      expect(reply.text).toContain(`已登记 ${FIXTURE}`);
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([FIXTURE]);
      const registered = first.trace.read().find((record) => record.kind === 'plugin_registered');
      expect(registered?.spec).toBe(FIXTURE);
      expect(registered?.source).toBe('command');
      expect(registered?.registry).toBe(join(dataDir, 'plugins.json'));
      // No unit in this temp dir, so the restart is the owner's and the receipt says so.
      expect(reply.text).toContain('手动重启');
      expect(first.trace.read().some((record) => record.kind === 'plugin_restart_skipped' && record.reason === 'no_service_manager')).toBe(true);
      // It is registered but not loaded in this process: the report must not claim otherwise.
      expect((await first.runCommand('plugins')).text).toContain('本进程未加载');
    } finally {
      await first.stop();
    }

    const secondConfig = defaultShellConfig({ dataDir, workspaceRoot: dir });
    expect(secondConfig.plugins).toEqual([FIXTURE]);
    const second = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      plugins: secondConfig.plugins,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await second.start();
    try {
      expect(second.host.tools.has('fixture-native-echo')).toBe(true);
      expect(second.pluginResults.find((entry) => entry.spec === FIXTURE)?.status).toBe('loaded');
      const loaded = second.trace.read().find((record) => record.kind === 'plugin_loaded');
      expect(loaded?.plugin).toBe('fixture-native');
      expect(loaded?.spec).toBe(FIXTURE);

      const health = (await (await fetch(`${second.httpUrl}/health`)).json()) as {
        plugins?: { registered: string[]; results: Array<{ spec: string; status: string; tools: string[] }> };
      };
      expect(health.plugins?.registered).toEqual([FIXTURE]);
      expect(health.plugins?.results[0]?.spec).toBe(FIXTURE);
      expect(health.plugins?.results[0]?.status).toBe('loaded');
      expect(health.plugins?.results[0]?.tools).toContain('fixture-native-echo');
    } finally {
      await second.stop();
    }
  }, 30_000);

  test('a failed load is on the same face with its reason, not hidden', async () => {
    const dir = makeTempDir('native-install-failed-');
    const broken = join(dir, 'broken-plugin');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'index.ts'), 'throw new Error("boom at import");\n', 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      plugins: [broken],
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await shell.start();
    try {
      const health = (await (await fetch(`${shell.httpUrl}/health`)).json()) as {
        plugins?: { results: Array<{ spec: string; status: string; reason?: string }> };
      };
      expect(health.plugins?.results[0]?.status).toBe('failed');
      expect(health.plugins?.results[0]?.reason).toContain('boom at import');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

describe('the restart is the existing service path', () => {
  test('a unit on disk schedules one restart and marks the assignment for continuation', async () => {
    const dir = makeTempDir('native-install-restart-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'install.json'),
      `${JSON.stringify({ done: ['place'], choices: { platform: 'linux', serviceName: 'cogmem-companion', httpPort: 7338 } })}\n`,
      'utf8',
    );
    new CheckpointStore(dataDir).save({
      ...emptyCheckpoint(),
      state: 'IDLE',
      runtime: {
        openAssignment: { id: 'assignment-1', origin: 'user_message', text: 'install the plugin', startedAt: 1 },
      },
    });

    let restarts = 0;
    const shell = new CompanionShell({
      config: {
        workspaceRoot: join(dir, 'ws'),
        dataDir,
        dbPath: join(dataDir, 'memory.sqlite'),
        timeZone: 'UTC',
        projectId: 'companion-test',
        agentId: 'cogmem-companion-test',
        sessionId: 'session-test',
        terminalEnabled: false,
        http: { enabled: false, port: 0, hostname: '127.0.0.1' },
        plugins: [],
      },
      modelProvider: new ScriptedProvider([{ text: 'ok', toolCalls: [] }]),
      tick: false,
      restartResident: () => {
        restarts += 1;
      },
    });
    await shell.start();
    const unitDir = join(dir, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    // The unit must name this data dir: a unit for another install is not this process's manager.
    writeFileSync(join(unitDir, 'cogmem-companion.service'), `[Service]\nExecStart=bun start --data ${dataDir}\n`, 'utf8');
    const previousHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const reply = await shell.runCommand('plugins', `add ${FIXTURE}`);
      expect(reply.text).toContain('重启自己');
      expect(shell.machine.runtime.resumeAfterRestart?.assignmentId).toBe('assignment-1');
      const scheduled = shell.trace.read().find((record) => record.kind === 'plugin_restart_scheduled');
      expect(scheduled?.service).toBe('cogmem-companion');
      expect(scheduled?.resumeAssignmentId).toBe('assignment-1');
    } finally {
      process.env.HOME = previousHome;
      await shell.stop();
    }
    await waitFor(() => restarts === 1);
  }, 30_000);

  test('an already-registered spec is not written twice and does not restart', async () => {
    const dir = makeTempDir('native-install-again-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'plugins.json'), `${JSON.stringify([FIXTURE])}\n`, 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      plugins: [FIXTURE],
    });
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', `add ${FIXTURE}`);
      expect(reply.text).toContain('已经在注册表里');
      expect(shell.trace.read().some((record) => record.kind === 'plugin_restart_scheduled')).toBe(false);
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([FIXTURE]);
    } finally {
      await shell.stop();
    }
  });

  test('a multi-line spec is refused before it reaches the file', async () => {
    const dir = makeTempDir('native-install-invalid-');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const reply = await shell.installPlugin('a\nb');
      expect(reply.text).toContain('invalid_plugin_spec');
      expect(existsSync(join(dir, 'data', 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });
});

describe('the install path enforces hygiene before the registry', () => {
  test('a plugin source with a secret is refused and traced', async () => {
    const dir = makeTempDir('native-install-secret-');
    const plugin = join(dir, 'ws', 'plugins', 'leaky.ts');
    mkdirSync(join(dir, 'ws', 'plugins'), { recursive: true });
    writeFileSync(plugin, `export default { name: 'leaky', apply() {} };\nconst OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyz';\n`, 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', 'add ./plugins/leaky.ts');
      expect(reply.text).toContain('plugin_secret_text');
      expect(shell.trace.read().some((record) => record.kind === 'plugin_install_rejected' && String(record.reason).includes('plugin_secret_text'))).toBe(true);
      expect(existsSync(join(dir, 'data', 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });

  test('an oversized plugin source is refused and traced', async () => {
    const dir = makeTempDir('native-install-large-');
    const plugin = join(dir, 'ws', 'plugins', 'large.ts');
    mkdirSync(join(dir, 'ws', 'plugins'), { recursive: true });
    writeFileSync(plugin, `export default { name: 'large', apply() {} };\n// ${'x'.repeat(256 * 1024)}\n`, 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', 'add ./plugins/large.ts');
      expect(reply.text).toContain('plugin_source_too_large');
      expect(shell.trace.read().some((record) => record.kind === 'plugin_install_rejected' && String(record.reason).includes('plugin_source_too_large'))).toBe(true);
      expect(existsSync(join(dir, 'data', 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });

  test('a path outside the workspace and shell tree is refused and traced', async () => {
    const dir = makeTempDir('native-install-outside-');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', 'add /etc/passwd');
      expect(reply.text).toContain('path_outside_workspace');
      expect(shell.trace.read().some((record) => record.kind === 'plugin_install_rejected' && String(record.reason).includes('path_outside_workspace'))).toBe(true);
      expect(existsSync(join(dir, 'data', 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });

  test('a valid plugin in the workspace installs', async () => {
    const dir = makeTempDir('native-install-valid-');
    const plugin = join(dir, 'ws', 'plugins', 'hello.ts');
    mkdirSync(join(dir, 'ws', 'plugins'), { recursive: true });
    writeFileSync(plugin, `export default { name: 'hygiene-ok', apply() {} };\n`, 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', 'add ./plugins/hello.ts');
      expect(reply.text).toContain('已登记 ./plugins/hello.ts');
      expect(JSON.parse(readFileSync(join(dir, 'data', 'plugins.json'), 'utf8'))).toEqual(['./plugins/hello.ts']);
      expect(shell.trace.read().some((record) => record.kind === 'plugin_registered')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('an unparseable plugin entry is refused and traced', async () => {
    const dir = makeTempDir('native-install-broken-');
    const plugin = join(dir, 'ws', 'plugins', 'broken.ts');
    mkdirSync(join(dir, 'ws', 'plugins'), { recursive: true });
    writeFileSync(plugin, 'export default {\n', 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', 'add ./plugins/broken.ts');
      expect(reply.text).toContain('plugin_unparseable');
      expect(shell.trace.read().some((record) => record.kind === 'plugin_install_rejected' && String(record.reason).includes('plugin_unparseable'))).toBe(true);
      expect(existsSync(join(dir, 'data', 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });
});

describe('a requested restart continues the open assignment once', () => {
  test('the next process runs the assignment with its findings in the prompt', async () => {
    const dir = makeTempDir('native-install-resume-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    new CheckpointStore(dataDir).save({
      ...emptyCheckpoint(),
      state: 'IDLE',
      runtime: {
        openAssignment: {
          id: 'assignment-1',
          origin: 'user_message',
          text: 'install the telegram plugin',
          startedAt: 1,
          findings: '注册表在 shell/src/config.ts:147，安装面是 /plugins。',
        },
        resumeAfterRestart: { assignmentId: 'assignment-1', at: 2, reason: 'plugins' },
      },
    });
    const provider = new ScriptedProvider([{ text: '继续完成', toolCalls: [] }]);
    const shell = makeShell(dir, provider, { dataDir });
    let settled = 0;
    shell.host.bus.on('agent_settled', () => {
      settled += 1;
    });
    await shell.start();
    try {
      await waitFor(() => settled === 1);
      expect(provider.calls).toHaveLength(1);
      const request = (provider.calls[0].messages ?? []).map((message) => String(message.content)).join('\n');
      expect(request).toContain('confirmed findings: 注册表在 shell/src/config.ts:147');
      expect(request).toContain('install the telegram plugin');
      expect(shell.trace.read().some((record) => record.kind === 'assignment_resume' && record.assignmentId === 'assignment-1')).toBe(true);
      // Cleared before the run, so a run that dies cannot restart into another resume.
      expect(shell.machine.runtime.resumeAfterRestart).toBeUndefined();
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

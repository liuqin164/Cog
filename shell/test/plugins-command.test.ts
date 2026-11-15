/**
 * The companion-reachable install surface (#223): `/plugins add` registers a Pi plugin in the data
 * directory, the next process loads it, and the load result is a fact on the health face.
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

function writePlugin(dir: string, name: string): string {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'index.ts'),
    `export default function (pi: any) {
  pi.registerTool({ name: "${name}-echo", description: "${name}", parameters: { type: "object", properties: {} }, execute: async () => "ok" });
}
`,
    'utf8',
  );
  return pluginDir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe('register in one process, load in the next', () => {
  test('the full cycle: /plugins add → new process → loaded list on /health', async () => {
    const dir = makeTempDir('pi-install-');
    const plugin = writePlugin(dir, 'fixture-plugin');
    const dataDir = join(dir, 'data');

    const firstConfig = defaultShellConfig({ dataDir, workspaceRoot: dir });
    expect(firstConfig.pi.plugins).toEqual([]);
    const first = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { dataDir, pi: firstConfig.pi });
    await first.start();
    try {
      const reply = await first.runCommand('plugins', `add ${plugin}`);
      expect(reply.text).toContain(`已登记 ${plugin}`);
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([plugin]);
      const registered = first.trace.read().find((record) => record.kind === 'pi_plugin_registered');
      expect(registered?.spec).toBe(plugin);
      expect(registered?.source).toBe('command');
      expect(registered?.registry).toBe(join(dataDir, 'plugins.json'));
      // No unit in this temp dir, so the restart is the owner's and the receipt says so.
      expect(reply.text).toContain('手动重启');
      expect(first.trace.read().some((record) => record.kind === 'pi_plugin_restart_skipped' && record.reason === 'no_service_manager')).toBe(true);
      // It is registered but not loaded in this process: the report must not claim otherwise.
      expect((await first.runCommand('plugins')).text).toContain('本进程未加载');
    } finally {
      await first.stop();
    }

    const secondConfig = defaultShellConfig({ dataDir, workspaceRoot: dir });
    expect(secondConfig.pi.plugins).toEqual([plugin]);
    const second = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      pi: secondConfig.pi,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await second.start();
    try {
      expect(second.host.tools.has('fixture-plugin-echo')).toBe(true);
      expect(second.piPluginResults.find((entry) => entry.pluginName === plugin)?.status).toBe('loaded');
      const loaded = second.trace.read().find((record) => record.kind === 'pi_plugin_loaded');
      expect(loaded?.plugin).toBe(plugin);
      expect(loaded?.tools).toEqual(['fixture-plugin-echo']);

      const health = (await (await fetch(`${second.httpUrl}/health`)).json()) as {
        plugins?: { registered: string[]; results: Array<{ spec: string; status: string; tools: string[] }> };
      };
      expect(health.plugins?.registered).toEqual([plugin]);
      expect(health.plugins?.results[0]?.spec).toBe(plugin);
      expect(health.plugins?.results[0]?.status).toBe('loaded');
      expect(health.plugins?.results[0]?.tools).toContain('fixture-plugin-echo');
    } finally {
      await second.stop();
    }
  }, 30_000);

  test('a failed load is on the same face with its reason, not hidden', async () => {
    const dir = makeTempDir('pi-install-failed-');
    const broken = join(dir, 'broken-plugin');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'index.ts'), 'throw new Error("boom at import");\n', 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      pi: { adapterEnabled: true, plugins: [broken] },
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
    const dir = makeTempDir('pi-install-restart-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'install.json'),
      `${JSON.stringify({ done: ['place'], choices: { platform: 'linux', serviceName: 'cogmem-companion', httpPort: 7338 } })}\n`,
      'utf8',
    );
    const plugin = writePlugin(dir, 'restart-fixture');
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
        pi: { adapterEnabled: true, plugins: [] },
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
      const reply = await shell.runCommand('plugins', `add ${plugin}`);
      expect(reply.text).toContain('重启自己');
      expect(shell.machine.runtime.resumeAfterRestart?.assignmentId).toBe('assignment-1');
      const scheduled = shell.trace.read().find((record) => record.kind === 'pi_plugin_restart_scheduled');
      expect(scheduled?.service).toBe('cogmem-companion');
      expect(scheduled?.resumeAssignmentId).toBe('assignment-1');
    } finally {
      process.env.HOME = previousHome;
      await shell.stop();
    }
    await waitFor(() => restarts === 1);
  }, 30_000);

  test('an already-registered spec is not written twice and does not restart', async () => {
    const dir = makeTempDir('pi-install-again-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'plugins.json'), `${JSON.stringify(['@scope/one'])}\n`, 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      pi: { adapterEnabled: true, plugins: ['@scope/one'] },
    });
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', 'add @scope/one');
      expect(reply.text).toContain('已经在注册表里');
      expect(shell.trace.read().some((record) => record.kind === 'pi_plugin_restart_scheduled')).toBe(false);
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual(['@scope/one']);
    } finally {
      await shell.stop();
    }
  });

  test('a spec with the environment list separator is refused before it reaches the file', async () => {
    const dir = makeTempDir('pi-install-invalid-');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const reply = await shell.runCommand('plugins', 'add a,b');
      expect(reply.text).toContain('invalid_plugin_spec');
      expect(existsSync(join(dir, 'data', 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });
});

describe('a requested restart continues the open assignment once', () => {
  test('the next process runs the assignment with its findings in the prompt', async () => {
    const dir = makeTempDir('pi-install-resume-');
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
      expect(provider.calls[0].systemPrompt).toContain('confirmed findings: 注册表在 shell/src/config.ts:147');
      expect(provider.calls[0].systemPrompt).toContain('install the telegram plugin');
      expect(shell.trace.read().some((record) => record.kind === 'assignment_resume' && record.assignmentId === 'assignment-1')).toBe(true);
      // Cleared before the run, so a run that dies cannot restart into another resume.
      expect(shell.machine.runtime.resumeAfterRestart).toBeUndefined();
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AttachClient } from '../src/attach/client.ts';
import type { AttachServerMessage, AttachSnapshot } from '../src/attach/server.ts';
import { defaultShellConfig } from '../src/config.ts';
import { RunCage } from '../src/plugins/cage.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const GREETING_SOURCE = `export default {
  name: 'hello-clock',
  apply(ctx) {
    ctx.registerTool({
      name: 'hello_clock',
      description: 'Return the current greeting from the self-installed plugin.',
      parameters: { type: 'object', properties: {} },
      execute() { return { output: 'hello from clock' }; },
    });
  },
};
`;

const FAILING_SOURCE = `throw new Error('boom at import');
export default { name: 'broken-plugin', apply() {} };
`;

const APPLY_FAILING_SOURCE = `export default { name: 'broken-apply', apply() { throw new Error('boom at apply'); } };
`;

function proposing(input: Record<string, unknown>): ScriptedProvider {
  return new ScriptedProvider([
    { text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'propose_plugin', input }] },
    { text: '提案已交给主人。', toolCalls: [] },
  ]);
}

function toolOutput(provider: ScriptedProvider): string {
  return provider.calls[1]?.messages.find((entry) => entry.role === 'tool')?.content ?? '';
}

function kinds(shell: ReturnType<typeof makeShell>, kind: string): Array<Record<string, unknown>> {
  return shell.trace.read().filter((record) => record.kind === kind);
}

function pluginInput(name: string, source: string) {
  return { name, purpose: '测试用问候插件', source, permissions: { provide: [], inject: [], data: [] } };
}

describe('plugin self-install runs through the owner approval gate', () => {
  test('propose → approve → restart → health → invoke → remove leaves nothing behind', async () => {
    const dir = makeTempDir('plugin-self-install-');
    const dataDir = join(dir, 'data');
    const workspaceRoot = join(dir, 'ws');
    const firstConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const provider = proposing(pluginInput('hello-clock', GREETING_SOURCE));
    const first = makeShell(dir, provider, { dataDir, plugins: firstConfig.plugins });
    await first.start();
    let sourcePath = '';
    try {
      await first.submit('写一个问候插件');
      expect(toolOutput(provider)).toContain('plugin_proposed');
      expect(toolOutput(provider)).toContain('批准前不会加载');

      const pending = first.pluginProposals.pending();
      expect(pending).toHaveLength(1);
      sourcePath = pending[0].sourcePath;
      expect(sourcePath.startsWith(join(dataDir, 'plugin-workspace', 'hello-clock') + '/')).toBe(true);
      expect(existsSync(sourcePath)).toBe(true);
      expect(existsSync(join(dataDir, 'plugins.json'))).toBe(false);
      expect(kinds(first, 'plugin_loaded')).toHaveLength(0);

      const opened = await first.host.tools.invoke('plugin_proposal_status', { toolCallId: 's1', input: { id: pending[0].id } }, { runId: 'test' });
      expect(opened.output).toContain('hello-clock');
      expect(opened.output).toContain('pending');

      const approved = await first.confirmProposal(pending[0].id);
      expect(approved.ok).toBe(true);
      expect(approved.reply?.text).toContain('已登记');
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([sourcePath]);
      expect(kinds(first, 'plugin_approved')).toHaveLength(1);
      expect(kinds(first, 'plugin_install_pending_health')).toHaveLength(1);
      const pendingList = await first.host.tools.invoke('installed_plugins', { toolCallId: 's3', input: {} }, { runId: 'test' });
      expect(pendingList.output).toContain('hello-clock');
      expect(pendingList.output).toContain('本进程未加载');
      expect(pendingList.output).toContain('测试用问候插件');

      const after = await first.host.tools.invoke('plugin_proposal_status', { toolCallId: 's2', input: { id: pending[0].id } }, { runId: 'test' });
      expect(after.output).toContain('pending-health');
    } finally {
      await first.stop();
    }

    const secondConfig = defaultShellConfig({ dataDir, workspaceRoot });
    expect(secondConfig.plugins).toEqual([sourcePath]);
    const secondProvider = new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'm1', toolName: 'hello_clock', input: {} }] },
      { text: 'clock called', toolCalls: [] },
    ]);
    const second = makeShell(dir, secondProvider, {
      dataDir,
      plugins: secondConfig.plugins,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await second.start();
    try {
      expect(second.host.tools.has('hello_clock')).toBe(true);
      expect(second.cage?.toolAllowed('hello_clock')).toBe(true);
      await second.submit('试一下 hello_clock');
      const toolResult = secondProvider.calls[1]?.messages.find((entry) => entry.role === 'tool')?.content ?? '';
      expect(toolResult).toContain('hello from clock');
      expect(kinds(second, 'cage_violation')).toHaveLength(0);
      const health = (await (await fetch(`${second.httpUrl}/health`)).json()) as {
        plugins?: { registered: string[]; results: Array<{ spec: string; status: string; tools: string[] }> };
      };
      expect(health.plugins?.registered).toEqual([sourcePath]);
      expect(health.plugins?.results[0]?.status).toBe('loaded');
      expect(health.plugins?.results[0]?.tools).toContain('hello_clock');
      expect(kinds(second, 'plugin_health_ok')).toHaveLength(1);

      const installed = await second.runCommand('plugins', '');
      expect(installed.text).toContain('hello-clock');
      const list = second.host.tools.has('installed_plugins')
        ? await second.host.tools.invoke('installed_plugins', { toolCallId: 'c2', input: {} }, { runId: 'test' })
        : undefined;
      expect(list?.output).toContain('测试用问候插件');
      expect(list?.output).toContain(`/plugins remove ${sourcePath}`);

      const removed = await second.runCommand('plugins', `remove ${sourcePath}`);
      expect(removed.text).toContain('已摘除');
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([]);
      expect(existsSync(dirname(sourcePath))).toBe(false);
      expect(second.host.tools.has('hello_clock')).toBe(false);
      expect(second.cage?.toolAllowed('hello_clock')).toBe(false);
      expect(kinds(second, 'plugin_removed').some((record) => record.reason === 'command')).toBe(true);
    } finally {
      await second.stop();
    }
  }, 45_000);

  test('a plugin tool that never reaches the cage whitelist fails health and is removed', async () => {
    const dir = makeTempDir('plugin-self-install-whitelist-');
    const dataDir = join(dir, 'data');
    const workspaceRoot = join(dir, 'ws');
    const firstConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const first = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { dataDir, plugins: firstConfig.plugins });
    await first.start();
    let id = '';
    let sourcePath = '';
    try {
      const proposed = first.pluginProposals.propose(pluginInput('hello-clock', GREETING_SOURCE));
      expect(proposed.accepted).toBe(true);
      id = proposed.proposal!.id;
      sourcePath = proposed.proposal!.sourcePath;
      expect((await first.confirmProposal(id)).ok).toBe(true);
    } finally {
      await first.stop();
    }

    const allowTools = RunCage.prototype.allowTools;
    RunCage.prototype.allowTools = () => {};
    const secondConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const second = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      plugins: secondConfig.plugins,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    try {
      await second.start();
      expect(String(kinds(second, 'plugin_health_failed')[0]?.reason)).toContain('tool_not_in_whitelist: hello_clock');
      expect(kinds(second, 'plugin_removed')).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([]);
      expect(existsSync(dirname(sourcePath))).toBe(false);
    } finally {
      RunCage.prototype.allowTools = allowTools;
      await second.stop();
    }
  }, 45_000);

  test('a plugin that fails its post-install health check is removed and audited', async () => {
    const dir = makeTempDir('plugin-self-install-fail-');
    const dataDir = join(dir, 'data');
    const workspaceRoot = join(dir, 'ws');
    const firstConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const first = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { dataDir, plugins: firstConfig.plugins });
    await first.start();
    let id = '';
    let sourcePath = '';
    try {
      const proposed = first.pluginProposals.propose({ name: 'broken-plugin', purpose: '构造失败例', source: FAILING_SOURCE, permissions: { provide: [], inject: [], data: [] } });
      expect(proposed.accepted).toBe(true);
      id = proposed.proposal!.id;
      sourcePath = proposed.proposal!.sourcePath;
      const approved = await first.confirmProposal(id);
      expect(approved.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([sourcePath]);
    } finally {
      await first.stop();
    }

    const secondConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const second = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      plugins: secondConfig.plugins,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await second.start();
    try {
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([]);
      expect(existsSync(dirname(sourcePath))).toBe(false);
      const failed = kinds(second, 'plugin_health_failed');
      expect(failed).toHaveLength(1);
      expect(String(failed[0].reason)).toContain('boom at import');
      expect(kinds(second, 'plugin_removed')).toHaveLength(1);
      expect(kinds(second, 'plugin_removed')[0].reason).toBe('health_check_failed');

      const health = (await (await fetch(`${second.httpUrl}/health`)).json()) as {
        plugins?: { registered: string[] };
      };
      expect(health.plugins?.registered).toEqual([]);
      const status = await second.host.tools.invoke('plugin_proposal_status', { toolCallId: 's3', input: { id } }, { runId: 'test' });
      expect(status.output).toContain('removed');
      expect(status.output).toContain('boom at import');
      const list = await second.host.tools.invoke('installed_plugins', { toolCallId: 's4', input: {} }, { runId: 'test' });
      expect(list.output).toContain('没有已装插件');
    } finally {
      await second.stop();
    }
  }, 45_000);

  test('a self-installed plugin whose apply throws is removed instead of failing startup', async () => {
    const dir = makeTempDir('plugin-self-install-apply-fail-');
    const dataDir = join(dir, 'data');
    const workspaceRoot = join(dir, 'ws');
    const firstConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const first = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { dataDir, plugins: firstConfig.plugins });
    await first.start();
    let id = '';
    let sourcePath = '';
    try {
      const proposed = first.pluginProposals.propose({ name: 'broken-apply', purpose: '构造 apply 失败例', source: APPLY_FAILING_SOURCE, permissions: { provide: [], inject: [], data: [] } });
      expect(proposed.accepted).toBe(true);
      id = proposed.proposal!.id;
      sourcePath = proposed.proposal!.sourcePath;
      const approved = await first.confirmProposal(id);
      expect(approved.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([sourcePath]);
    } finally {
      await first.stop();
    }

    const secondConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const second = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      plugins: secondConfig.plugins,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await second.start();
    try {
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([]);
      expect(existsSync(dirname(sourcePath))).toBe(false);
      const applyFailure = kinds(second, 'plugin_failed').find((record) => record.name === 'broken-apply');
      expect(String(applyFailure?.message)).toContain('boom at apply');
      const failed = kinds(second, 'plugin_health_failed');
      expect(failed).toHaveLength(1);
      expect(String(failed[0].reason)).toContain('boom at apply');
      expect(kinds(second, 'plugin_removed')[0].reason).toBe('health_check_failed');

      const health = (await (await fetch(`${second.httpUrl}/health`)).json()) as {
        plugins?: { registered: string[]; results: unknown[] };
      };
      expect(health.plugins?.registered).toEqual([]);
      expect(health.plugins?.results).toEqual([]);
      const status = await second.host.tools.invoke('plugin_proposal_status', { toolCallId: 's3', input: { id } }, { runId: 'test' });
      expect(status.output).toContain('removed');
      expect(status.output).toContain('boom at apply');
    } finally {
      await second.stop();
    }
  }, 45_000);

  test('the attach card carries the decision facts, and only its confirm enters the install chain', async () => {
    const dir = makeTempDir('plugin-self-install-attach-');
    const dataDir = join(dir, 'data');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
      dataDir,
      attach: { enabled: true },
    });
    await shell.start();
    try {
      const first = shell.pluginProposals.propose(pluginInput('hello-clock', GREETING_SOURCE));
      expect(first.accepted).toBe(true);
      const id = first.proposal!.id;
      const client = new AttachClient();
      const seen: AttachServerMessage[] = [];
      const snapshot: AttachSnapshot = await client.connect(join(dataDir, 'attach.sock'));
      client.onEvent = (message) => seen.push(message);
      const card = snapshot.entries.find((entry) => entry.kind === 'proposal' && entry.proposal.id === id);
      expect(card?.kind).toBe('proposal');
      if (card?.kind !== 'proposal') throw new Error('plugin proposal missing from attach snapshot');
      expect(card.proposal.args).toBe('hello-clock');
      expect(card.proposal.reason).toContain('测试用问候插件');
      const detail = (card.proposal.detail ?? []).join('\n');
      expect(detail).toContain('plugin-workspace/hello-clock/index.ts');
      expect(detail).toContain('provide=');
      expect(detail).toContain('/plugins remove');
      expect(existsSync(join(dataDir, 'plugins.json'))).toBe(false);

      client.send({ t: 'command-confirm', id });
      await waitUntil(() => seen.some((message) =>
        message.t === 'event'
        && message.name === 'companion_command_proposal'
        && (message.payload as { proposal?: { status?: string } }).proposal?.status === 'executed'));
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([first.proposal!.sourcePath]);

      const second = shell.pluginProposals.propose(pluginInput('hello-two', GREETING_SOURCE));
      client.send({ t: 'command-discard', id: second.proposal!.id });
      await waitUntil(() => kinds(shell, 'plugin_proposal_discarded').some((record) => record.id === second.proposal!.id));
      expect(JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8'))).toEqual([first.proposal!.sourcePath]);
      expect(existsSync(dirname(second.proposal!.sourcePath))).toBe(false);
      expect(kinds(shell, 'plugin_proposal_discarded').find((record) => record.id === second.proposal!.id)?.spec).toBe(second.proposal!.sourcePath);
      client.close();
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

describe('plugin proposals reject the boundaries before anything is loaded', () => {
  test('source outside the controlled workspace is refused and traced', async () => {
    const dir = makeTempDir('plugin-self-install-outside-');
    const outside = join(dir, 'outside-plugin.ts');
    writeFileSync(outside, GREETING_SOURCE, 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const result = shell.pluginProposals.propose({
        name: 'hello-plugin',
        purpose: '越界源码',
        sourcePath: outside,
        permissions: { provide: [], inject: [], data: [] },
      });
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('path_outside_plugin_workspace');
      expect(kinds(shell, 'plugin_proposal_rejected')[0]?.reason).toContain('path_outside_plugin_workspace');
      expect(existsSync(join(shell.config.dataDir, 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });

  test('a symlink inside the plugin workspace that escapes it is refused and traced', async () => {
    const dir = makeTempDir('plugin-self-install-symlink-');
    const outside = join(dir, 'outside-plugin.ts');
    writeFileSync(outside, GREETING_SOURCE, 'utf8');
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const workspace = join(shell.config.dataDir, 'plugin-workspace');
      mkdirSync(workspace, { recursive: true });
      const link = join(workspace, 'escape.ts');
      symlinkSync(outside, link);
      const result = shell.pluginProposals.propose({
        name: 'hello-plugin',
        purpose: '符号链接越界',
        sourcePath: link,
        permissions: { provide: [], inject: [], data: [] },
      });
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('path_outside_plugin_workspace');
      expect(kinds(shell, 'plugin_proposal_rejected')[0]?.reason).toContain('path_outside_plugin_workspace');
      expect(shell.pluginProposals.pending()).toHaveLength(0);
      expect(existsSync(join(shell.config.dataDir, 'plugins.json'))).toBe(false);
    } finally {
      await shell.stop();
    }
  });

  test('a missing permission declaration is refused and traced', async () => {
    const shell = makeShell(makeTempDir('plugin-self-install-perms-'), new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const result = shell.pluginProposals.propose({ name: 'hello-plugin', purpose: '没有权限面', source: GREETING_SOURCE });
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('plugin_permissions_required');
      const rejected = kinds(shell, 'plugin_proposal_rejected')[0];
      expect(rejected?.reason).toContain('plugin_permissions_required');
      const status = await shell.host.tools.invoke('plugin_proposal_status', { toolCallId: 's1', input: { id: rejected!.id } }, { runId: 'test' });
      expect(status.output).toContain('rejected');
      expect(status.output).toContain('plugin_permissions_required');
    } finally {
      await shell.stop();
    }
  });

  test('a built-in plugin name is refused and traced', async () => {
    const shell = makeShell(makeTempDir('plugin-self-install-reserved-'), new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const result = shell.pluginProposals.propose({ name: 'builtin-tools', purpose: '覆盖内置', source: GREETING_SOURCE, permissions: { provide: [], inject: [], data: [] } });
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('plugin_name_reserved');
      expect(kinds(shell, 'plugin_proposal_rejected')[0]?.reason).toContain('plugin_name_reserved');
      const conflict = shell.pluginProposals.propose({
        name: 'hello-plugin',
        purpose: '覆盖内置服务',
        source: GREETING_SOURCE,
        permissions: { provide: ['memory'], inject: [], data: [] },
      });
      expect(conflict.accepted).toBe(false);
      expect(conflict.reason).toContain('plugin_service_conflict');
      const override = shell.pluginProposals.propose({
        name: 'hello-plugin',
        purpose: '覆盖内置工具',
        source: `export default { name: 'hello-plugin', apply(ctx) { ctx.registerTool({ name: 'read', description: 'x', parameters: { type: 'object' }, execute() { return 'x'; } }); } };\n`,
        permissions: { provide: [], inject: [], data: [] },
      });
      expect(override.accepted).toBe(false);
      expect(override.reason).toContain('plugin_reserved_name: read');
      const gap = shell.pluginProposals.propose({
        name: 'hello-plugin',
        purpose: '长间隔覆盖内置工具',
        source: `export default { name: 'hello-plugin', apply(ctx) { ctx.registerTool({ description: '${'x'.repeat(400)}', name: 'read', parameters: { type: 'object' }, execute() { return 'x'; } }); } };\n`,
        permissions: { provide: [], inject: [], data: [] },
      });
      expect(gap.accepted).toBe(false);
      expect(gap.reason).toContain('plugin_reserved_name: read');
    } finally {
      await shell.stop();
    }
  });

  test('loading a pending proposal is refused, so the companion cannot self-approve', async () => {
    const shell = makeShell(makeTempDir('plugin-self-install-unapproved-'), new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
    await shell.start();
    try {
      const proposed = shell.pluginProposals.propose({ name: 'hello-plugin', purpose: '未批先加载', source: GREETING_SOURCE, permissions: { provide: [], inject: [], data: [] } });
      expect(proposed.accepted).toBe(true);
      const reply = await shell.pluginsAdmin.installProposal(proposed.proposal!.id);
      expect(reply.ok).toBe(false);
      expect(reply.reply.text).toContain('plugin_approval_required');
      expect(kinds(shell, 'plugin_approval_required')).toHaveLength(1);
      expect(existsSync(join(shell.config.dataDir, 'plugins.json'))).toBe(false);
      expect(kinds(shell, 'plugin_loaded')).toHaveLength(0);
      expect(shell.host.tools.list().map((tool) => tool.name).filter((name) => /approve|^install_plugin$/i.test(name))).toEqual([]);
    } finally {
      await shell.stop();
    }
  });
});

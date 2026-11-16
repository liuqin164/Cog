/**
 * #291 route A: an owner-approved plugin proposal is applied, snapshotted, and proved by the next
 * boot. The three acceptance cases live here: the full circle loads and is callable, a broken
 * plugin is rolled back while the resident stays up, and an unapproved proposal is refused.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultShellConfig } from '../src/config.ts';
import { readPluginRegistry } from '../src/plugins/registry.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const ECHO_PLUGIN = `export default {
  name: 'self-written-echo',
  apply(ctx: any) {
    ctx.registerTool({
      name: 'self_written_echo',
      description: 'Echo text from a plugin the companion wrote itself.',
      parameters: { type: 'object' },
      execute({ args }: any) {
        return { output: 'echo:' + args.text };
      },
    });
  },
};
`;

const BROKEN_IMPORT = `throw new Error('boom at import');\n`;
const BROKEN_APPLY = `export default {
  name: 'broken-self-change',
  apply() { throw new Error('boom in apply'); },
};
`;

function proposalInput(content: string): Record<string, unknown> {
  return {
    kind: 'plugin',
    origin: 'self',
    reason: '给同伴加一个自己写的小插件，验证提案批准后能真的安装并经重启加载。',
    files: [{ path: 'index.ts', content }],
    diff: { added: content.split('\n').length, removed: 0, files: 1 },
    tests: { command: 'bun test shell/test/self-change-apply.test.ts', passed: true },
    rollback: '删除数据目录下的自写插件目录并恢复 plugins.json',
  };
}

function lastProposalId(shell: ReturnType<typeof makeShell>): string {
  const records = shell.trace.read().filter((entry) => entry.kind === 'hygiene_proposal_received');
  return String(records[records.length - 1]?.id);
}

function secondProcess(dir: string): ReturnType<typeof makeShell> {
  const config = defaultShellConfig({ dataDir: join(dir, 'data'), workspaceRoot: join(dir, 'ws') });
  return makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { plugins: config.plugins });
}

describe('an approved plugin proposal is applied and proved by the next boot', () => {
  test('propose → owner approval → apply → restart → callable, with the origin on /plugins', async () => {
    const dir = makeTempDir('self-change-full-');
    const dataDir = join(dir, 'data');
    let id = '';
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'p1', toolName: 'propose_self_change', input: proposalInput(ECHO_PLUGIN) }] },
      { text: '提案已记录。', toolCalls: [] },
      { text: '收到批准。', toolCalls: [] },
      () => ({ text: '', toolCalls: [{ toolCallId: 'a1', toolName: 'apply_self_change', input: { proposal_id: id } }] }),
      { text: '已应用，等重启。', toolCalls: [] },
    ]);
    const first = makeShell(dir, provider);
    await first.start();
    try {
      await first.submit('给自己加一个小插件');
      id = lastProposalId(first);
      expect(first.state).toBe('SUSPENDED');
      expect(first.hygiene.get(id)?.status).toBe('awaiting_owner');

      await first.submit('批准');
      expect(first.hygiene.get(id)?.status).toBe('approved');

      await first.submit('应用它');
      expect(first.trace.read().some((entry) => entry.kind === 'self_change_apply_started' && entry.proposalId === id)).toBe(true);
      const record = first.selfChange.records().find((entry) => entry.proposalId === id);
      expect(record?.status).toBe('pending');
      expect(readPluginRegistry(dataDir)).toEqual([record!.spec]);
      expect(existsSync(join(record!.targetDir, 'index.ts'))).toBe(true);
      // The temp data dir has no service unit, so the restart is the owner's and is said so.
      expect(first.trace.read().some((entry) => entry.kind === 'plugin_restart_skipped' && entry.spec === record?.spec)).toBe(true);
      expect((await first.runCommand('plugins')).text).toContain(`自写提案 ${id} · pending`);
    } finally {
      await first.stop();
    }

    const second = secondProcess(dir);
    await second.start();
    try {
      const record = second.selfChange.records().find((entry) => entry.proposalId === id);
      expect(record?.status).toBe('applied');
      expect(record?.tools).toContain('self_written_echo');
      expect(second.pluginResults.find((entry) => entry.spec === record?.spec)?.status).toBe('loaded');

      const called = await second.host.tools.invoke('self_written_echo', { toolCallId: 't1', input: { text: 'hello' } }, { runId: 'run-1' });
      expect(called.isError).toBe(false);
      expect(called.output).toBe('echo:hello');

      const verified = second.trace.read().find((entry) => entry.kind === 'self_change_apply_verified');
      expect(verified?.proposalId).toBe(id);
      expect(verified?.health).toBe('ok');
      expect(verified?.tools).toContain('self_written_echo');
      const report = await second.runCommand('plugins');
      expect(report.text).toContain(`自写提案 ${id} · applied`);
      expect(report.text).toContain('self_written_echo');
    } finally {
      await second.stop();
    }
  }, 30_000);
});

describe('a broken plugin is rolled back and the resident stays up', () => {
  for (const [label, content] of [['import', BROKEN_IMPORT], ['apply', BROKEN_APPLY]] as const) {
    test(`a plugin that throws at ${label} restores the snapshot`, async () => {
      const dir = makeTempDir(`self-change-broken-${label}-`);
      const dataDir = join(dir, 'data');
      const shell = makeShell(dir, new ScriptedProvider([
        { text: '', toolCalls: [{ toolCallId: 'p1', toolName: 'propose_self_change', input: proposalInput(content) }] },
        { text: '提案已记录。', toolCalls: [] },
        { text: '收到批准。', toolCalls: [] },
      ]));
      await shell.start();
      let id = '';
      try {
        await shell.submit('加一个坏插件');
        id = lastProposalId(shell);
        await shell.submit('批准');
        expect(shell.hygiene.get(id)?.status).toBe('approved');

        const applied = shell.applySelfChange(id);
        expect(applied.ok).toBe(true);
        const pending = shell.selfChange.records().find((entry) => entry.proposalId === id)!;
        expect(pending.status).toBe('pending');
        expect(existsSync(join(pending.targetDir, 'index.ts'))).toBe(true);
        expect(readPluginRegistry(dataDir)).toEqual([pending.spec]);
      } finally {
        await shell.stop();
      }

      const next = secondProcess(dir);
      await next.start();
      try {
        const record = next.selfChange.records().find((entry) => entry.proposalId === id);
        expect(record?.status).toBe('rolled_back');
        expect(record?.reason).toBeTruthy();
        expect(existsSync(join(record!.targetDir, 'index.ts'))).toBe(false);
        // The snapshot was "no plugins.json"; restoring it removes the file rather than leaving a
        // registry entry that names a plugin no longer on disk.
        expect(existsSync(join(dataDir, 'plugins.json'))).toBe(false);
        expect(readPluginRegistry(dataDir)).toEqual([]);
        expect(next.pluginResults.find((entry) => entry.spec === record?.spec)?.status).toBe('failed');
        // The companion is alive: its own tools and command face still answer.
        expect(next.host.tools.has('bash')).toBe(true);
        expect((await next.runCommand('plugins')).text).toContain('自写应用记录');

        const kinds = next.trace.read().map((entry) => entry.kind);
        expect(kinds).toContain('self_change_apply_failed');
        expect(kinds).toContain('self_change_apply_rolled_back');
        if (label === 'apply') expect(kinds).toContain('plugin_quarantined');
        const rolledBack = next.trace.read().find((entry) => entry.kind === 'self_change_apply_rolled_back');
        expect(rolledBack?.snapshot).toBe(record?.snapshotPath);
        expect(rolledBack?.reason).toBe(record?.reason);
      } finally {
        await next.stop();
      }
    }, 30_000);
  }
});

describe('there is no apply without the owner approval record', () => {
  test('a proposal still waiting for the owner is refused at the tool, with nothing written', async () => {
    const dir = makeTempDir('self-change-unapproved-');
    const dataDir = join(dir, 'data');
    const shell = makeShell(dir, new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'p1', toolName: 'propose_self_change', input: proposalInput(ECHO_PLUGIN) }] },
      { text: '提案已记录。', toolCalls: [] },
    ]));
    await shell.start();
    try {
      await shell.submit('加一个小插件');
      const id = lastProposalId(shell);
      expect(shell.hygiene.get(id)?.status).toBe('awaiting_owner');

      const refused = await shell.host.tools.invoke('apply_self_change', { toolCallId: 'a1', input: { proposal_id: id } }, { runId: 'run-1' });
      expect(refused.isError).toBe(true);
      expect(refused.output).toContain('self_change_apply_refused');
      expect(refused.output).toContain('not_approved');
      expect(existsSync(join(dataDir, 'plugins.json'))).toBe(false);
      expect(existsSync(join(dataDir, 'self-plugins'))).toBe(false);
      expect(shell.selfChange.records()).toEqual([]);
      const audit = shell.trace.read().find((entry) => entry.kind === 'self_change_apply_refused');
      expect(audit?.proposalId).toBe(id);
      expect(String(audit?.reason)).toContain('not_approved');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a toxic proposal never reaches the applier', async () => {
    const dir = makeTempDir('self-change-toxic-');
    const shell = makeShell(dir, new ScriptedProvider([
      {
        text: '',
        toolCalls: [{
          toolCallId: 'p1',
          toolName: 'propose_self_change',
          input: proposalInput(`const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';\nexport default {};\n`),
        }],
      },
      { text: '已丢弃。', toolCalls: [] },
    ]));
    await shell.start();
    try {
      await shell.submit('写个带密钥的插件');
      const id = lastProposalId(shell);
      expect(shell.hygiene.get(id)?.status).toBe('discarded');
      const refused = shell.applySelfChange(id);
      expect(refused.ok).toBe(false);
      expect(refused.text).toContain('self_change_apply_refused');
      expect(refused.text).toContain('not_approved: discarded');
      expect(existsSync(join(dir, 'data', 'self-plugins'))).toBe(false);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

test('the record keeps the preview of plugins.json it will restore', () => {
  const dir = makeTempDir('self-change-snapshot-');
  const dataDir = join(dir, 'data');
  const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), {
    plugins: [],
  });
  return shell.start().then(async () => {
    try {
      const proposal = {
        id: 'hygiene-direct-0', kind: 'plugin' as const, origin: 'self' as const, reason: '验证快照记录里保存了应用前的登记状态。',
        files: [{ path: 'index.ts', content: ECHO_PLUGIN }], diff: { added: 1, removed: 0, files: 1 },
        tests: { command: 'bun test', passed: true }, rollback: '删除', status: 'approved' as const,
        score: 90, findings: [], createdAt: 1, requiresOwnerApproval: true,
      };
      const outcome = shell.selfChange.apply(proposal);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        const saved = JSON.parse(readFileSync(outcome.record.snapshotPath, 'utf8'));
        expect(saved.snapshot.registry).toBeNull();
        expect(saved.snapshot.files).toEqual([{ path: 'index.ts', content: null }]);
      }
      expect(existsSync(join(dataDir, 'plugins.json'))).toBe(true);
    } finally {
      await shell.stop();
    }
  });
});

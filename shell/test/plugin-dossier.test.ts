import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultShellConfig } from '../src/config.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const VERSION_ONE = `export default {
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

const VERSION_TWO = VERSION_ONE.replace('hello from clock', 'hello from clock v2');

function pluginInput(name: string, purpose: string, source: string, limitations?: string[]) {
  return {
    name,
    purpose,
    source,
    permissions: { provide: [], inject: [], data: [] },
    ...(limitations ? { limitations } : {}),
  };
}

function laneItems(shell: ReturnType<typeof makeShell>, lane: string) {
  return shell.lastLaneAssembly?.lanes.find((entry) => entry.lane === lane)?.items ?? [];
}

function dossiers(shell: ReturnType<typeof makeShell>): Array<Record<string, unknown>> {
  return shell.trace.read().filter((record) => record.kind === 'plugin_dossier');
}

describe('a self-installed plugin carries a compiled artifact dossier', () => {
  test('install compiles it, mention and tool calls surface it, reinstall supersedes it, removal stops it', async () => {
    const dir = makeTempDir('plugin-dossier-');
    const dataDir = join(dir, 'data');
    const workspaceRoot = join(dir, 'ws');
    const firstConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const first = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { dataDir, plugins: firstConfig.plugins });
    await first.start();
    let sourcePath = '';
    let sourceSha256 = '';
    try {
      const proposed = first.pluginProposals.propose(
        pluginInput('hello-clock', '按整点问候主人', VERSION_ONE, ['只在当前进程有效']),
      );
      expect(proposed.accepted).toBe(true);
      sourcePath = proposed.proposal!.sourcePath;
      sourceSha256 = proposed.proposal!.sourceSha256;
      expect((await first.confirmProposal(proposed.proposal!.id)).ok).toBe(true);
    } finally {
      await first.stop();
    }

    const provider = new ScriptedProvider([
      (input) => {
        const newest = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
        const alreadyCalled = input.messages.some((message) => message.toolName === 'hello_clock');
        return newest.includes('试一下功能') && !alreadyCalled
          ? { text: '', toolCalls: [{ toolCallId: 'clock-1', toolName: 'hello_clock', input: {} }] }
          : { text: '好的', toolCalls: [] };
      },
    ]);
    const secondConfig = defaultShellConfig({ dataDir, workspaceRoot });
    expect(secondConfig.plugins).toEqual([sourcePath]);
    const second = makeShell(dir, provider, {
      dataDir,
      plugins: secondConfig.plugins,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await second.start();
    try {
      const compiled = dossiers(second);
      expect(compiled).toHaveLength(1);
      expect(compiled[0]).toMatchObject({
        name: 'hello-clock',
        purpose: '按整点问候主人',
        sourcePath,
        sourceSha256,
        version: 1,
        supersedes: null,
        limitations: ['只在当前进程有效'],
      });
      expect(compiled[0].tools).toEqual(['hello_clock']);
      expect(compiled[0].decision).toEqual({ text: '按整点问候主人', sourceType: 'llm_inference' });

      for (let turn = 1; turn <= 8; turn += 1) {
        await second.submit(`今天第 ${turn} 次闲聊，说说天气。`);
        expect(laneItems(second, 'working_set').some((item) => item.id.startsWith('plugin-dossier-'))).toBe(false);
      }

      await second.submit('你写的 hello-clock 插件当初为什么这么写？');
      const surfaced = laneItems(second, 'working_set').find((item) => item.id.startsWith('plugin-dossier-'));
      expect(surfaced).toBeDefined();
      expect(surfaced!.text).toContain('purpose: 按整点问候主人');
      expect(surfaced!.text).toContain('tools=[hello_clock]');
      expect(surfaced!.text).toContain('llm_inference');
      expect(surfaced!.text).toContain(`sha256=${sourceSha256} verified`);
      expect(laneItems(second, 'recall').some((item) => item.text.includes('<plugin-dossier'))).toBe(false);
      expect(provider.calls.at(-1)!.messages.some((message) => message.content.includes('<plugin-dossier name="hello-clock">'))).toBe(true);

      await second.submit('试一下功能');
      expect(laneItems(second, 'working_set').some((item) => item.id.startsWith('plugin-dossier-'))).toBe(true);

      second.trace.append('plugin_failed', { name: 'hello-clock', message: 'clock stalled' });
      await second.submit('hello-clock 出过什么问题？');
      expect(laneItems(second, 'working_set').find((item) => item.id.startsWith('plugin-dossier-'))!.text).toContain('incident:');

      writeFileSync(sourcePath, `${VERSION_ONE}\n// changed outside the dossier\n`, 'utf8');
      await second.submit('再说说 hello-clock 的源码');
      const changed = laneItems(second, 'working_set').find((item) => item.id.startsWith('plugin-dossier-'));
      expect(changed!.text).toContain('mismatch current=');
      expect(changed!.text).not.toContain('verified');

      expect((await second.runCommand('plugins', `remove ${sourcePath}`)).text).toContain('已摘除');
      expect(dossiers(second)).toHaveLength(1);
      await second.submit('hello-clock 现在怎么样了？');
      expect(laneItems(second, 'working_set').some((item) => item.id.startsWith('plugin-dossier-'))).toBe(false);

      const secondVersion = second.pluginProposals.propose(
        pluginInput('hello-clock', '第二版：按整点报时并记住问候次数', VERSION_TWO),
      );
      expect(secondVersion.accepted).toBe(true);
      expect((await second.confirmProposal(secondVersion.proposal!.id)).ok).toBe(true);
    } finally {
      await second.stop();
    }

    const thirdConfig = defaultShellConfig({ dataDir, workspaceRoot });
    const third = makeShell(dir, new ScriptedProvider([{ text: '好的', toolCalls: [] }]), {
      dataDir,
      plugins: thirdConfig.plugins,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await third.start();
    try {
      const history = dossiers(third);
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({ version: 2, supersedes: history[0].id, purpose: '第二版：按整点报时并记住问候次数' });

      await third.submit('hello-clock 第二版怎么样？');
      const surfaced = laneItems(third, 'working_set').find((item) => item.id.startsWith('plugin-dossier-'));
      expect(surfaced!.text).toContain('第二版：按整点报时并记住问候次数');
      expect(surfaced!.text).toContain('decision (llm_inference): 第二版：按整点报时并记住问候次数');
      expect(surfaced!.text).toContain('v2');
      expect(surfaced!.text).toContain(`supersedes ${String(history[0].id)}`);

      expect((await third.runCommand('plugins', `remove ${sourcePath}`)).text).toContain('已摘除');
      expect(dossiers(third)).toHaveLength(2);
      await third.submit('hello-clock 还在吗？');
      expect(laneItems(third, 'working_set').some((item) => item.id.startsWith('plugin-dossier-'))).toBe(false);
    } finally {
      await third.stop();
    }
  }, 60_000);
});

/**
 * #267: optional tool schemas are mounted per task with the loop's existing declaration.
 *
 * Measured trigger: a cold attach carried 16 tools at 77.5% of the request (2,780 of 3,588
 * tokens). These tests pin the three things a reader would otherwise have to trust: the default set
 * is the small one, a task cue mounts its group, and the change travels as `toolsAdded` /
 * `toolsRemoved` rather than silently.
 */
import { describe, expect, test } from 'bun:test';
import { selectToolNames } from '../src/plugins/tools-by-task.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const OPTIONAL = ['web_search', 'web_fetch', 'web_recall', 'propose_self_change', 'apply_self_change', 'propose_soul_edit'];
const names = (call: { tools: Array<{ name: string }> }) => call.tools.map((tool) => tool.name);

describe('tool schemas follow the task (#267)', () => {
  test('a plain turn mounts the core set, not web or self-change', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('tool-mount-plain-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('部署窗口还是周二吗？');
      const mounted = names(provider.calls[0]!);
      expect(mounted).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash', 'propose_command', 'ask_user', 'declare_task']));
      for (const optional of OPTIONAL) expect(mounted).not.toContain(optional);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a web cue mounts the web group and later leaves it', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('tool-mount-web-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('部署窗口还是周二吗？');
      const before = new Set(names(provider.calls[0]!));
      expect(before.has('web_search')).toBe(false);

      await shell.submit('帮我搜索一下最新的发布说明');
      expect(names(provider.calls[1]!)).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'web_recall']));
      const added = provider.calls[1]!.messages.find((message) => message.toolsAdded?.length)?.toolsAdded ?? [];
      expect(added).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'web_recall']));

      await shell.submit('继续');
      expect(names(provider.calls[2]!)).not.toContain('web_search');
      const removed = provider.calls[2]!.messages.find((message) => message.toolsRemoved?.length)?.toolsRemoved ?? [];
      expect(removed).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'web_recall']));
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the selector keeps unknown plugin tools and only gates the known groups', () => {
    const all = ['read', 'bash', 'custom_tool', 'web_search', 'propose_soul_edit'];
    expect(selectToolNames(all, '部署窗口是周二', new Set())).toEqual(['read', 'bash', 'custom_tool']);
    expect(selectToolNames(all, '搜索最新消息', new Set())).toEqual(['read', 'bash', 'custom_tool', 'web_search']);
    expect(selectToolNames(all, '安装一个插件', new Set())).toEqual(['read', 'bash', 'custom_tool', 'propose_soul_edit']);
    // A group already used in this run stays mounted even when the newest line has no cue.
    expect(selectToolNames(all, '继续', new Set(['web']))).toEqual(['read', 'bash', 'custom_tool', 'web_search']);
  });
});

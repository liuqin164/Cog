/**
 * #277's discriminators, at the shell boundary.
 *
 * The live run is still the owner's acceptance test. These pin the two facts that made the live run
 * fail: a plain "remember this" turn needs no tool at all, and after a restart a rephrased question
 * is answered from the recall lane the shell assembles (with an in-process drill-down key).
 */
import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

describe('ordinary remember and recall do not need a CLI (#277)', () => {
  test('a "remember two things" line is answered in one text turn, with no memory CLI in the loadout', async () => {
    const provider = new ScriptedProvider([{ text: '记住了：去市役所带护照和在留卡；咖啡只喝黑咖啡。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('memory-remember-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      const summary = await shell.submit('记住两件事：去市役所带护照和在留卡；咖啡只喝黑咖啡。');
      expect(summary!.turns).toBe(1);
      expect(summary!.toolCalls).toHaveLength(0);
      expect(shell.host.tools.list().map((tool) => tool.name)).not.toContain('cogmem');
      expect(provider.calls[0]!.systemPrompt).toContain('Conversation capture is automatic');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('after a restart, a rephrased question is answered from the recall lane', async () => {
    const dir = makeTempDir('memory-restart-');
    const first = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]), { dream: NO_DREAM });
    await first.start();
    await first.backend.rememberTurnWithResult({
      agentId: first.config.agentId,
      projectId: first.config.projectId,
      sessionId: first.config.sessionId,
      turnId: 'coffee-277',
      userText: '咖啡只喝黑咖啡，不加糖。',
      assistantText: '记下了：只喝黑咖啡。',
      ingestMode: 'immediate_compile',
    });
    await first.stop();

    const provider = new ScriptedProvider([{ text: '你只喝黑咖啡，不加糖。', toolCalls: [] }]);
    const second = makeShell(dir, provider, { dream: NO_DREAM });
    await second.start();
    try {
      await second.submit('我平时喝咖啡有什么讲究来着？');
      const text = asText(provider.calls[0]!.messages);
      expect(text).toContain('黑咖啡');
      expect(text).toContain('sourceLocator=read mem:');
      expect(text).not.toContain('cogmem memory show');
      expect(text).not.toContain('memory.sqlite');
    } finally {
      await second.stop();
    }
  }, 30_000);
});

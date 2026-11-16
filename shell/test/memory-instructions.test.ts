/**
 * #277: ordinary remembering and recall must not send the model into a CLI/sqlite dig.
 *
 * The shell already captures every turn and assembles the recall lane before the request. These
 * tests pin the two model-facing facts that were missing: the prompt says so, and a recall item's
 * drill-down is the in-process `read mem:` key rather than `cogmem memory show`.
 */
import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

describe('the model is told that capture and recall are already done (#277)', () => {
  test('the pinned prompt names automatic capture and forbids CLI/sqlite archaeology', async () => {
    const shell = makeShell(makeTempDir('memory-prompt-'), new ScriptedProvider([{ text: '好。', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      const prompt = shell.systemPromptSections().pinned;
      expect(prompt).toContain('Conversation capture is automatic');
      expect(prompt).toContain('Do not run a CLI, open a SQLite file, or search the filesystem');
      expect(prompt).toContain('mem:<eventId>');
      expect(prompt).toContain('The recall lane in this request is already assembled');
      expect(prompt).not.toContain('recall before you answer');
    } finally {
      await shell.stop();
    }
  });

  test('a recall item drills down with read mem:, not the operator CLI', async () => {
    const provider = new ScriptedProvider([{ text: '记下了。', toolCalls: [] }, { text: '是周二。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('memory-recall-key-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'seed-277',
        userText: '部署窗口是周二凌晨两点',
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      await shell.submit('部署窗口是什么时候');

      const text = asText(provider.calls.at(-1)!.messages);
      expect(text).toContain('<COGMEM_RECALL_CONTEXT');
      expect(text).toContain('sourceLocator=read mem:evt-');
      expect(text).not.toContain('cogmem memory show');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

/**
 * #251 B1: a recall item reaches the provider with a drill-down key, not only its text.
 *
 * The key is the ledger's own event id, the same `anchorEvent` a recall item already carries, so a
 * model can resolve it through `read mem:<eventId>` (#252) instead of guessing from the summary.
 */
import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

describe('recall drill-down keys (#251 B1)', () => {
  test('the provider receives an anchorEvent that resolves to the ledger row', async () => {
    const provider = new ScriptedProvider([{ text: '看到了。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('continuity-b1-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      const seed = '部署窗口是周二凌晨两点，周五绝对不能部署';
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: 'seeded-elsewhere',
        turnId: 'seed-b1',
        userText: seed,
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      await shell.submit('部署窗口是什么时候');

      expect(provider.calls.length).toBeGreaterThan(0);
      const text = asText(provider.calls[0]!.messages);
      expect(text).toContain('<COGMEM_RECALL_CONTEXT');
      // One block format: the shell no longer wraps the lane in a second tag.
      expect(text).not.toContain('<recall-context>');

      const keys = [...text.matchAll(/anchorEvent=(evt-[^\s;]+)/g)].map((match) => match[1]!);
      expect(keys.length).toBeGreaterThan(0);
      const events = keys
        .map((eventId) => shell.kernel.getEventContext(eventId, { before: 0, after: 0 })?.event)
        .filter((event): event is NonNullable<typeof event> => Boolean(event));
      expect(events.some((event) => String((event.payload as { text?: unknown }).text).includes(seed))).toBe(true);

      expect(text).toContain('sourceLocator=read mem:');
      expect(text).not.toContain('cogmem memory show');
      expect(text).toContain('whyMatched=');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

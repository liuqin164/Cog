/**
 * Context continuity across runs (#245 A1).
 *
 * A new run's request carries the recent verbatim turns of the session (the kernel's `tail` lane),
 * so a follow-up like "继续" can still see what the previous run was about.
 */
import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

describe('context continuity', () => {
  test('A1: a second run carries the recent turns of the first (tail lane)', async () => {
    const provider = new ScriptedProvider([{ text: '好的，我先看回滚逻辑。', toolCalls: [] }, { text: '继续。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('continuity-a1-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('帮我把部署脚本里的回滚逻辑重写一下');
      await shell.submit('继续');
      expect(asText(provider.calls[1].messages)).toContain('[tail]');
      expect(asText(provider.calls[1].messages)).toContain('回滚逻辑');
      expect(asText(provider.calls[1].messages)).toContain('我先看回滚逻辑');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A1: tailTurns bounds the verbatim tail and the cut is browsable', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('continuity-a1-bound-'), provider, { dream: NO_DREAM, tailTurns: 2 });
    await shell.start();
    try {
      await shell.submit('第一轮：回滚逻辑要看旧版本');
      await shell.submit('第二轮：部署窗口是周二');
      await shell.submit('第三轮：继续');
      const third = asText(provider.calls[2].messages);
      expect(third).toContain('第二轮：部署窗口是周二');
      expect(third).toContain('收到二。');
      expect(third).not.toContain('第一轮：回滚逻辑要看旧版本');
      expect(third).not.toContain('收到一。');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('A1: the tail lane is bounded by the F14 budget and collapses to a browse-only stub', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('continuity-a1-budget-'), provider, { dream: NO_DREAM, contextSweetSpot: 10 });
    await shell.start();
    try {
      await shell.submit('第一轮：回滚逻辑要看旧版本');
      await shell.submit('第二轮：部署窗口是周二');
      await shell.submit('第三轮：继续');
      const third = asText(provider.calls[2].messages);
      expect(third).toContain('[tail: browse-only, 4 item(s)]');
      expect(third).not.toContain('第二轮：部署窗口是周二');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

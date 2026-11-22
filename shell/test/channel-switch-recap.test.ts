import { describe, expect, test } from 'bun:test';
import type { ModelCompletionInput } from '../src/state/agent-loop.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };

function requestText(input: ModelCompletionInput): string {
  return input.messages.map((message) => message.content).join('\n');
}

function workingSet(shell: ReturnType<typeof makeShell>): string {
  return (shell.lastLaneAssembly?.lanes.find((lane) => lane.lane === 'working_set')?.items ?? [])
    .map((item) => item.text)
    .join('\n');
}

function channelTurns(shell: ReturnType<typeof makeShell>, channel: string): number {
  return shell.backend.sessionTurns({
    projectId: shell.config.projectId,
    agentId: shell.config.agentId,
    sessionId: shell.config.sessionId,
    limit: 200,
  }).turns.filter((turn) => turn.channel === channel).length;
}

describe('a channel switch carries the other channel into the working set (#421)', () => {
  test('the first turn on the new channel names the platform, task and result; later turns drop it', async () => {
    const provider = new ScriptedProvider([
      { text: 'A 收到一。', toolCalls: [] },
      { text: 'A 收到二。', toolCalls: [] },
      { text: 'A 收到三。', toolCalls: [] },
      (input) => {
        const text = requestText(input);
        return {
          text: text.includes('<channel-recap channel="web">') && text.includes('telegram') && text.includes('部署窗口是周二')
            ? '你在 Telegram 上问过部署窗口，答案是周二。'
            : '没有记录。',
          toolCalls: [],
        };
      },
      { text: 'B 收到。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('channel-recap-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('第一轮：部署窗口是什么时候？', 'telegram');
      await shell.submit('第二轮：记一下，部署窗口是周二。', 'telegram');
      await shell.submit('第三轮：好。', 'telegram');
      expect(workingSet(shell)).not.toContain('<channel-recap');
      const telegramBefore = channelTurns(shell, 'telegram');

      const answer = await shell.submit('部署窗口是哪天？', 'web');
      const recap = workingSet(shell);
      expect(recap).toContain('<channel-recap channel="web">');
      expect(recap).toContain('telegram');
      expect(recap).toContain('部署窗口是周二');
      expect(answer?.assistantText).toBe('你在 Telegram 上问过部署窗口，答案是周二。');
      expect(channelTurns(shell, 'telegram')).toBe(telegramBefore);

      await shell.submit('谢谢。', 'web');
      expect(workingSet(shell)).not.toContain('<channel-recap');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a cross-channel turn that ran a tool recaps the tool task and its result', async () => {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'tool-1', toolName: 'bash', input: { command: 'printf hello' } }] },
      { text: '已完成，输出 hello。', toolCalls: [] },
      (input) => {
        const text = requestText(input);
        return {
          text: text.includes('工具 bash') && text.includes('printf hello') && text.includes('已完成，输出 hello')
            ? '在 Telegram 上你让我用 bash 运行 printf hello，结果是 hello。'
            : '没有记录。',
          toolCalls: [],
        };
      },
    ]);
    const shell = makeShell(makeTempDir('channel-recap-tool-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('在某个渠道跑一下 printf hello。', 'telegram');
      const answer = await shell.submit('刚才让你在 Telegram 办的事怎么样了？', 'web');
      const recap = workingSet(shell);
      expect(recap).toContain('<channel-recap channel="web">');
      expect(recap).toContain('telegram');
      expect(recap).toContain('工具 bash');
      expect(recap).toContain('printf hello');
      expect(recap).toContain('已完成，输出 hello');
      expect(answer?.assistantText).toBe('在 Telegram 上你让我用 bash 运行 printf hello，结果是 hello。');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

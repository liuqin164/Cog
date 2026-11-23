import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };
const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);
const DAY = 86_400_000;

describe('back-reference recall in a real turn (#472)', () => {
  test('a yesterday reference brings the anchored fact into the request', async () => {
    const provider = new ScriptedProvider([{ text: '昨天聊的是 Orion。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('backref-shell-'), provider, { timeZone: 'Asia/Tokyo', dream: NO_DREAM }, { now: () => NOW });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: 'session-yesterday',
        turnId: 'yesterday:0',
        userText: '部署代号是 Orion，上线窗口周二凌晨两点。',
        assistantText: '记下了。',
        timestamp: NOW - DAY,
        ingestMode: 'immediate_compile',
      });
      await shell.submit('昨天聊的那个');
      expect(JSON.stringify(provider.calls[0]?.messages)).toContain('Orion');
      const row = shell.kernel.factStore.getDatabase()
        .query('SELECT payload FROM trace_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1')
        .get('recall.result') as { payload: string } | null;
      expect(JSON.parse(row!.payload)).toMatchObject({ rewrite: { source: 'deterministic_backref' } });
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a real turn memory search reaches this session before the tail', async () => {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'm1', toolName: 'memory', input: { action: 'search', query: 'ORION-EARLY' } }] },
      { text: '早前那一轮是 Orion。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('backref-search-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      const sessionId = shell.config.sessionId;
      for (let turnSeq = 1; turnSeq <= 10; turnSeq += 1) {
        const content = turnSeq === 1
          ? 'ORION-EARLY 部署窗口是周二凌晨两点。'
          : turnSeq === 10
            ? 'ORION-TAIL 最近这一轮的内容。'
            : `普通对话第 ${turnSeq} 轮。`;
        shell.kernel.recordRawEvent({
          projectId: shell.config.projectId,
          threadId: sessionId,
          sessionId,
          turnSeq,
          role: 'user',
          content,
          sourceId: `${shell.config.agentId}:${sessionId}`,
          metadata: { sourceAgent: shell.config.agentId },
        });
      }
      const summary = await shell.submit('还记得早期那个 Orion 吗？');
      const output = summary!.toolResults.find((result) => result.toolName === 'memory')?.output ?? '';
      expect(output).toContain('ORION-EARLY');
      expect(output).not.toContain('ORION-TAIL');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

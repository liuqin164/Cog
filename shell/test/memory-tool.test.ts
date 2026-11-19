import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const FACT = '部署窗口是周二凌晨两点，代号 Orion。';

function toolOutput(summary: { toolResults: Array<{ toolName: string; output: string; isError: boolean }> } | undefined): string {
  return summary?.toolResults.find((result) => result.toolName === 'memory')?.output ?? '';
}

describe('the memory tool (#323)', () => {
  test('search returns a lane-free fact with a mem: key', async () => {
    const shell = makeShell(makeTempDir('memory-tool-search-'), new ScriptedProvider([{ text: '好。', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: 'seeded-earlier',
        turnId: 'seed-323-search',
        userText: FACT,
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      const result = await shell.host.tools.invoke(
        'memory',
        { toolCallId: 'm1', input: { action: 'search', query: '部署窗口 周二 凌晨两点' } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain(FACT);
      expect(result.output).toMatch(/mem:evt-/);
    } finally {
      await shell.stop();
    }
  });

  test('read opens the ledger row behind a mem: key', async () => {
    const shell = makeShell(makeTempDir('memory-tool-read-'), new ScriptedProvider([{ text: '好。', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      const event = shell.kernel.recordRawEvent({
        projectId: shell.config.projectId,
        threadId: 'read-key',
        sessionId: 'seeded-earlier',
        role: 'user',
        content: FACT,
      });
      const result = await shell.host.tools.invoke(
        'memory',
        { toolCallId: 'm1', input: { action: 'read', eventId: `mem:${event.eventId}` } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toBe(FACT);
    } finally {
      await shell.stop();
    }
  });

  test('recent pages this session only and returns the newest n entries', async () => {
    const shell = makeShell(makeTempDir('memory-tool-recent-'), new ScriptedProvider([
      { text: '第一答。', toolCalls: [] },
      { text: '第二答。', toolCalls: [] },
    ]), { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('第一问。');
      await shell.submit('第二问。');
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: 'other-session',
        turnId: 'seed-323-recent',
        userText: '别人的会话不该出现。',
        assistantText: '好。',
      });
      const result = await shell.host.tools.invoke(
        'memory',
        { toolCallId: 'm1', input: { action: 'recent', n: 2 } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('第二问。');
      expect(result.output).toContain('第二答。');
      expect(result.output).not.toContain('第一问。');
      expect(result.output).not.toContain('别人的会话不该出现。');
      expect(result.output).toMatch(/mem:evt-/);
    } finally {
      await shell.stop();
    }
  });

  test('search keeps unpromoted tool observations out and labels promoted ones last', async () => {
    const shell = makeShell(makeTempDir('memory-tool-trust-'), new ScriptedProvider([{ text: '好。', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      shell.kernel.recordRawEvent({
        projectId: shell.config.projectId,
        threadId: 'trust',
        sessionId: 'seeded-earlier',
        role: 'user',
        content: '主人喜欢本地优先的部署方式。',
        sourceId: `${shell.config.agentId}:seeded-earlier`,
        metadata: { sourceAgent: shell.config.agentId },
      });
      shell.kernel.recordRawEvent({
        projectId: shell.config.projectId,
        threadId: 'trust',
        sessionId: 'seeded-earlier',
        role: 'tool',
        rawEventType: 'tool_result',
        content: 'TOOL-UNPROMOTED 本地优先部署说明。',
        sourceId: `${shell.config.agentId}:seeded-earlier`,
        metadata: { sourceAgent: shell.config.agentId, toolName: 'read' },
      });
      const unpromoted = await shell.host.tools.invoke(
        'memory',
        { toolCallId: 'm1', input: { action: 'search', query: '本地优先 部署' } },
        { runId: 'r' },
      );
      expect(unpromoted.output).not.toContain('TOOL-UNPROMOTED');

      shell.kernel.recordRawEvent({
        projectId: shell.config.projectId,
        threadId: 'trust',
        sessionId: 'seeded-earlier',
        role: 'tool',
        rawEventType: 'tool_result',
        content: '工具读到的部署说明：本地优先。',
        sourceId: `${shell.config.agentId}:seeded-earlier`,
        metadata: { sourceAgent: shell.config.agentId, toolName: 'read', toolObservationPromoted: true },
      });
      const promoted = await shell.host.tools.invoke(
        'memory',
        { toolCallId: 'm2', input: { action: 'search', query: '本地优先 部署 工具读到的部署说明' } },
        { runId: 'r' },
      );
      expect(promoted.output).toContain('[tool observation (untrusted)]');
      expect(promoted.output.indexOf('工具读到的部署说明')).toBeGreaterThan(promoted.output.indexOf('主人喜欢本地优先'));
    } finally {
      await shell.stop();
    }
  });

  test('end to end: an empty lane gets a rephrased question answered from search', async () => {
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [{ toolCallId: 'm1', toolName: 'memory', input: { action: 'search', query: '部署窗口 周二 凌晨两点' } }],
      },
      { text: '部署窗口是周二凌晨两点。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('memory-tool-e2e-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: 'seeded-earlier',
        turnId: 'seed-323-e2e',
        userText: FACT,
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      const summary = await shell.submit('上线前安排在什么时候？');
      expect(JSON.stringify(provider.calls[0]!.messages)).not.toContain(FACT);
      expect(summary!.toolResults.map((result) => result.toolName)).toContain('memory');
      expect(toolOutput(summary)).toContain(FACT);
      expect(toolOutput(summary)).toMatch(/mem:evt-/);
      expect(summary!.assistantText).toContain('周二凌晨两点');
      expect(provider.calls).toHaveLength(2);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

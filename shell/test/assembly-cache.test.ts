import { describe, expect, test } from 'bun:test';

import { ScriptedProvider, makeShell, makeTempDir, seedOpenAssignment } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');
const laneBlock = (text: string, lane: string): string => {
  const start = text.indexOf(`[${lane}]`);
  if (start < 0) return '';
  const rest = text.slice(start + lane.length + 2);
  if (lane === 'recall') {
    const close = rest.indexOf('</COGMEM_RECALL_CONTEXT>');
    return close < 0 ? rest : rest.slice(0, close);
  }
  const next = rest.search(/\n\[[a-z_]+\]/);
  return next < 0 ? rest : rest.slice(0, next);
};

function traceCount(shell: ReturnType<typeof makeShell>, eventType: string): number {
  try {
    return (shell.kernel.factStore.getDatabase()
      .query('SELECT COUNT(*) AS n FROM trace_events WHERE event_type = ?')
      .get(eventType) as { n: number }).n;
  } catch {
    return 0;
  }
}

async function seed(shell: ReturnType<typeof makeShell>): Promise<void> {
  await shell.backend.rememberTurnWithResult({
    agentId: shell.config.agentId,
    projectId: shell.config.projectId,
    sessionId: 'seeded-elsewhere',
    turnId: 'seed-cache',
    userText: '部署窗口是周二凌晨两点，周五绝对不能部署',
    assistantText: '记下了。',
    ingestMode: 'immediate_compile',
  });
}

describe('one turn assembles once (#351)', () => {
  test('a tool loop with no new ledger writes recalls once and every call carries the same block', async () => {
    const provider = new ScriptedProvider([
      { text: '先看一下。', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'echo one' } }] },
      { text: '再看一下。', toolCalls: [{ toolCallId: 'c2', toolName: 'bash', input: { command: 'echo two' } }] },
      { text: '继续看。', toolCalls: [{ toolCallId: 'c3', toolName: 'bash', input: { command: 'echo three' } }] },
      { text: '看完了。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('assembly-cache-stable-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await seed(shell);
      seedOpenAssignment(shell, '帮我看看部署窗口是什么时候');
      shell.machine.updateRuntime({ capturePaused: true });
      const db = shell.kernel.factStore.getDatabase();
      const query = db.query.bind(db);
      let laneReads = 0;
      db.query = ((sql: string) => {
        if (sql.includes("$.metadata.captureLane")) laneReads += 1;
        return query(sql);
      }) as typeof db.query;
      const before = traceCount(shell, 'recall.result');
      await shell.submit('帮我看看部署窗口是什么时候');
      expect(provider.calls).toHaveLength(4);
      const blocks = provider.calls.map((call) => laneBlock(asText(call.messages), 'recall'));
      expect(blocks[0]).toContain('周五绝对不能部署');
      for (const block of blocks) expect(block).toBe(blocks[0]);
      expect(traceCount(shell, 'recall.result') - before).toBe(1);
      expect(laneReads).toBe(3);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a new ledger write invalidates the cache at the next provider call', async () => {
    const provider = new ScriptedProvider([
      { text: '先看一下。', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'echo one' } }] },
      { text: '再看一下。', toolCalls: [{ toolCallId: 'c2', toolName: 'bash', input: { command: 'echo two' } }] },
      { text: '看完了。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('assembly-cache-invalidated-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await seed(shell);
      const before = traceCount(shell, 'recall.result');
      await shell.submit('帮我看看部署窗口是什么时候');
      expect(provider.calls).toHaveLength(3);
      expect(traceCount(shell, 'recall.result') - before).toBe(3);
      for (const call of provider.calls) expect(asText(call.messages)).toContain('周五绝对不能部署');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

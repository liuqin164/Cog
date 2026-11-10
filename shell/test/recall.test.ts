import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

describe('recall inside the loop', () => {
  test('the run context carries memory, and a steering message gets its own recall', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'let me check', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }] },
      { text: 'done', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'seed-recall',
        userText: 'zebraplan8811 是下周的计划代号',
        assistantText: '记下了：zebraplan8811。',
        ingestMode: 'immediate_compile',
      });
      shell.host.bus.on('tool_execution_end', () => shell.runtimeInstance?.steer('再查下 zebraplan8811 的细节'));
      await shell.submit('zebraplan8811 是什么');
      expect(provider.calls.length).toBe(2);
      const first = provider.calls[0].messages.map((message) => message.content).join('\n');
      expect(first).toContain('<recall-context>');
      expect(first).toContain('zebraplan8811');
      const second = provider.calls[1].messages.map((message) => message.content).join('\n');
      expect(second).toContain('<recall-context>');
      expect(second).toContain('再查下 zebraplan8811 的细节');
      expect(shell.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  });
});

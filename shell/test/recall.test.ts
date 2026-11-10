import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeTempDir } from './helpers.ts';

function makeShell(dir: string, provider: ScriptedProvider) {
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  return new CompanionShell({
    config: {
      workspaceRoot: workspace,
      dataDir: join(dir, 'data'),
      dbPath: join(dir, 'data', 'memory.sqlite'),
      timeZone: 'UTC',
      projectId: 'companion-test',
      agentId: 'cogmem-companion-test',
      sessionId: 'session-test',
      terminalEnabled: false,
      mcp: { enabled: false, port: 0, hostname: '127.0.0.1', path: '/mcp', profile: 'core' },
    },
    modelProvider: provider,
    tick: false,
  });
}

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

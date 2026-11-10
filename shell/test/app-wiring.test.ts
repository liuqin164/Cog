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
      pi: { adapterEnabled: false, plugins: [] },
    },
    modelProvider: provider,
    tick: false,
  });
}

describe('shell wiring', () => {
  test('transitions reach the plugin bus, the companion plugins are services, and WAKING stores the time block', async () => {
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'x', toolCalls: [] }]));
    const transitions: Array<{ from: string; to: string; trigger: string }> = [];
    shell.host.bus.on('companion_transition', (record: { from: string; to: string; trigger: string }) => {
      transitions.push(record);
    });
    await shell.start();
    try {
      expect(transitions.map((record) => `${record.from}->${record.to}:${record.trigger}`)).toEqual([
        'DORMANT->WAKING:boot',
        'WAKING->IDLE:context_injected',
      ]);
      for (const service of ['clock', 'model', 'cage', 'builtinTools', 'capture', 'recall', 'dream', 'emergence']) {
        expect(shell.host.hasService(service)).toBe(true);
      }
      expect(shell.machine.runtime.lastTimeContext).toContain('<time-context>');
      expect(shell.systemPrompt()).toContain('<time-context>');
    } finally {
      await shell.stop();
    }
  });
});

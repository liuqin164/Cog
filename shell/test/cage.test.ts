import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeTempDir } from './helpers.ts';

function makeShell(dir: string, provider: ScriptedProvider, budgets: { maxTurnsPerRun: number; maxTokensPerRun: number; toolWhitelist: string[] | null }) {
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
      budgets,
    },
    modelProvider: provider,
    tick: false,
  });
}

describe('the cage (budgets and whitelist at hook points)', () => {
  test('a tool outside the whitelist is blocked before execution and the run returns to IDLE', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'trying bash', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'echo should-not-run' } }] },
      { text: 'understood', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider, { maxTurnsPerRun: 5, maxTokensPerRun: 10_000, toolWhitelist: ['read'] });
    await shell.start();
    try {
      const summary = await shell.submit('run bash');
      expect(summary!.toolResults[0].isError).toBe(true);
      expect(summary!.toolResults[0].output).toContain('tool_not_in_whitelist');
      expect(shell.state).toBe('IDLE');
      expect(shell.trace.read().some((record) => record.reason && String(record.reason).includes('tool_not_in_whitelist'))).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('the turn budget forces the run out of RUNNING with budget_exceeded', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'looping', toolCalls: [{ toolCallId: 'c', toolName: 'read', input: { path: 'missing.txt' } }] }]);
    const shell = makeShell(dir, provider, { maxTurnsPerRun: 2, maxTokensPerRun: 10_000, toolWhitelist: ['read'] });
    await shell.start();
    try {
      const summary = await shell.submit('loop');
      expect(summary!.stopReason).toBe('budget_exceeded');
      expect(summary!.turns).toBe(2);
      expect(shell.state).toBe('IDLE');
      expect(shell.trace.read().some((record) => record.kind === 'cage_violation')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('the token budget forces the run out of RUNNING', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'expensive', toolCalls: [], usage: { input: 500_000, output: 1 } }]);
    const shell = makeShell(dir, provider, { maxTurnsPerRun: 5, maxTokensPerRun: 1_000, toolWhitelist: null });
    await shell.start();
    try {
      const summary = await shell.submit('spend');
      expect(summary!.stopReason).toBe('budget_exceeded');
      expect(summary!.error).toContain('token_budget_exceeded');
      expect(shell.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  });
});

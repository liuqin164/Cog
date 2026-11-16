import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/bus.ts';
import { AgentRuntime, type ToolInvoker } from '../src/state/agent-loop.ts';
import { RunCage } from '../src/plugins/cage.ts';
import { DEFAULT_MAX_IDLE_TURNS, defaultShellConfig } from '../src/config.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

function echoTools(): ToolInvoker {
  const definitions = [{ name: 'echo', description: 'echo', parameters: {}, source: 'test' }];
  return {
    list: () => definitions,
    invoke: async (name, call) => ({ toolCallId: call.toolCallId, toolName: name, output: `echo:${JSON.stringify(call.input)}`, isError: false }),
  };
}

function runtime(provider: ScriptedProvider, maxIdleTurns: number): AgentRuntime {
  return new AgentRuntime({
    bus: new EventBus(),
    tools: echoTools(),
    provider,
    budget: new RunCage({ maxTurnsPerRun: 32, maxTokensPerRun: 400_000, toolWhitelist: null }),
    systemPrompt: () => 'system',
    maxIdleTurns,
  });
}

describe('no-progress criterion', () => {
  test('budgets.json reads maxIdleTurns and refuses a non-positive one', () => {
    const dir = makeTempDir();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    expect(defaultShellConfig({ dataDir }).maxIdleTurns).toBe(DEFAULT_MAX_IDLE_TURNS);
    writeFileSync(join(dataDir, 'budgets.json'), JSON.stringify({ maxIdleTurns: 2 }));
    expect(defaultShellConfig({ dataDir }).maxIdleTurns).toBe(2);
    writeFileSync(join(dataDir, 'budgets.json'), JSON.stringify({ maxIdleTurns: 0 }));
    expect(() => defaultShellConfig({ dataDir })).toThrow(/maxIdleTurns must be a positive integer/u);
  });

  test('repeated tool calls with no text stop at the limit, far below the work budget', async () => {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: { same: true } }] },
    ]);
    const summary = await runtime(provider, 2).run({ runId: 'r', sessionId: 's', userText: 'ping' });
    expect(provider.calls).toHaveLength(3);
    expect(summary.turns).toBe(3);
    expect(summary.stopReason).toBe('run_error');
    expect(summary.error).toContain('no_progress');
    expect(summary.error).toContain('maxIdleTurns=2');
  });

  test('a long task with repeated calls but intermittent stage text is not killed', async () => {
    const call = { toolCallId: 'c1', toolName: 'echo', input: { same: true } };
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [call] },
      { text: '', toolCalls: [call] },
      { text: 'stage 1: read the sources', toolCalls: [call] },
      { text: '', toolCalls: [call] },
      { text: 'stage 2: build is green', toolCalls: [call] },
      { text: 'done', toolCalls: [] },
    ]);
    const summary = await runtime(provider, 2).run({ runId: 'r', sessionId: 's', userText: 'long task' });
    expect(summary.turns).toBe(6);
    expect(summary.stopReason).toBe('run_complete');
  });

  test('a normal one-turn answer is unchanged', async () => {
    const provider = new ScriptedProvider([{ text: 'hello', toolCalls: [] }]);
    const summary = await runtime(provider, 2).run({ runId: 'r', sessionId: 's', userText: 'hi' });
    expect(summary.turns).toBe(1);
    expect(summary.stopReason).toBe('run_complete');
  });

  test('the shell announces the stop on both faces and writes the handoff fields', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }] },
    ]);
    const shell = makeShell(dir, provider, { maxIdleTurns: 2 });
    const notices: string[] = [];
    const printed: string[] = [];
    shell.host.bus.on('companion_notice', (event: { text?: string }) => notices.push(String(event.text)));
    shell.host.bus.on('terminal_print', (event: { text?: string }) => printed.push(String(event.text)));
    await shell.start();
    try {
      const summary = await shell.submit('ping');
      expect(summary!.turns).toBe(3);
      expect(summary!.turns).toBeLessThan(32);
      expect(summary!.stopReason).toBe('run_error');
      expect(summary!.error).toContain('no_progress');
      expect(shell.state).toBe('IDLE');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('连续 2 回合无用户可见产出');
      expect(notices[0]).toContain('read');
      expect(printed).toEqual([`${notices[0]}\n`]);
      expect(shell.machine.runtime.openAssignment?.stoppedStep).toContain('read');
      expect(shell.machine.runtime.openAssignment?.nextStep).toContain('progress');
      expect(shell.trace.read().some((record) => record.kind === 'no_progress_stopped')).toBe(true);
    } finally {
      await shell.stop();
    }
  });
});

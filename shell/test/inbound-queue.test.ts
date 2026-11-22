import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

describe('messages that arrive while a run cannot take them', () => {
  test('a foreign-channel line waits for its own user run and keeps its channel', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'first', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'sleep 0.3; printf one' } }] },
      { text: 'first done', toolCalls: [] },
      { text: 'answered web', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      const first = shell.submit('first');
      await waitUntil(() => shell.state === 'RUNNING' && provider.calls.length === 1);
      await shell.submit('from web', 'web');
      const queued = shell.machine.runtime.inboundQueue?.filter((entry) => entry.status === 'queued') ?? [];
      expect(queued.map((entry) => [entry.status, entry.channel])).toEqual([['queued', 'web']]);
      expect(shell.runtimeInstance?.steeringMessages).toEqual([]);
      const summary = await first;
      expect(summary?.stopReason).toBe('run_complete');
      expect(provider.calls).toHaveLength(3);
      expect(provider.calls[2].messages.map((message) => message.content).join('\n')).toContain('from web');
      expect(shell.machine.runtime.inboundQueue).toBeUndefined();
      expect(shell.currentChannel).toBe('web');
      const trace = shell.trace.read();
      expect(trace.filter((record) => record.kind === 'inbound_queued').map((record) => record.channel)).toEqual(['terminal', 'web']);
      expect(trace.some((record) => record.kind === 'steering_injected')).toBe(false);
    } finally {
      await shell.stop();
    }
  });

  test('a queued line whose run throws stays behind marked failed', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'first', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'sleep 0.3; printf one' } }] },
      { text: 'first done', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      const runtime = (shell as unknown as { runtime: { run: (...args: unknown[]) => Promise<unknown> } }).runtime;
      const original = runtime.run.bind(runtime);
      const first = shell.submit('first');
      await waitUntil(() => provider.calls.length === 1);
      await shell.submit('keep this', 'web');
      runtime.run = async () => {
        throw new Error('provider unreachable');
      };
      const summary = await first;
      runtime.run = original;
      expect(summary?.stopReason).toBe('run_complete');
      const queue = shell.machine.runtime.inboundQueue ?? [];
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ text: 'keep this', channel: 'web', status: 'failed', error: 'provider unreachable' });
      expect(shell.state).toBe('IDLE');
      expect(shell.trace.read().some((record) => record.kind === 'inbound_failed')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('the queue keeps its text in the ledger and survives a restart', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    await shell.start();
    shell.machine.updateRuntime({
      inboundQueue: [{ id: 'inbound-1', text: 'keep me across a restart', channel: 'web', at: Date.now(), status: 'queued' }],
    });
    const raw = readFileSync(join(dir, 'data', 'checkpoint.json'), 'utf8');
    expect(raw).not.toContain('keep me across a restart');
    expect(raw).toContain('"textId"');
    await shell.stop();

    const again = makeShell(dir, provider);
    await again.start();
    try {
      expect(again.machine.runtime.inboundQueue?.[0]).toMatchObject({
        id: 'inbound-1',
        text: 'keep me across a restart',
        channel: 'web',
        status: 'queued',
      });
    } finally {
      await again.stop();
    }
  });
});

describe('waking and blank input', () => {
  test('wake only leaves DREAMING or DORMANT and never starts a run', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      await shell.wakeFromSleep();
      expect(shell.state).toBe('IDLE');
      await shell.machine.dispatch('dream_window_open', { reason: 'test' });
      expect(shell.state).toBe('DREAMING');
      await shell.wakeFromSleep();
      expect(shell.state).toBe('IDLE');
      expect(provider.calls).toHaveLength(0);
      await expect(shell.submit('   ')).rejects.toThrow('submit_empty_text');
      expect(provider.calls).toHaveLength(0);
      expect(shell.state).toBe('IDLE');
    } finally {
      await shell.stop();
    }
  });
});

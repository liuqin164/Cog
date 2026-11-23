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

  test('a line submitted while the drain is waking waits for its own result or error', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'first done', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      const runtime = (shell as unknown as { runtime: { run: (...args: unknown[]) => Promise<unknown> } }).runtime;
      const original = runtime.run.bind(runtime);
      let runs = 0;
      runtime.run = async (...args) => {
        runs += 1;
        if (runs === 2) throw new Error('second failed');
        return original(...args);
      };
      await shell.machine.dispatch('dream_window_open', { reason: 'test' });
      const dispatch = shell.machine.dispatch.bind(shell.machine);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let paused = false;
      shell.machine.dispatch = (async (trigger, context) => {
        if (trigger === 'context_injected' && !paused) {
          paused = true;
          await gate;
        }
        return dispatch(trigger, context);
      }) as typeof shell.machine.dispatch;
      const first = shell.submit('first');
      await waitUntil(() => paused);
      expect(shell.state).toBe('WAKING');
      const second = shell.submit('second');
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await expect(second).rejects.toThrow('second failed');
      expect(await first).toMatchObject({ stopReason: 'run_complete' });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].messages.map((message) => message.content).join('\n')).toContain('first');
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

  test('failed lines are counted by /status and capped at 20', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      const runtime = (shell as unknown as { runtime: { run: (...args: unknown[]) => Promise<unknown> } }).runtime;
      runtime.run = async () => {
        throw new Error('provider unreachable');
      };
      for (let index = 1; index <= 21; index += 1) {
        await expect(shell.submit(`fail-${index}`)).rejects.toThrow('provider unreachable');
      }
      const failed = shell.machine.runtime.inboundQueue?.filter((entry) => entry.status === 'failed') ?? [];
      expect(failed).toHaveLength(20);
      expect(failed[0]!.text).toBe('fail-2');
      expect(failed.at(-1)!.text).toBe('fail-21');
      expect(shell.currentStatus().failedInbound).toBe(20);
      const status = await shell.runCommand('status', '');
      expect(status.text).toContain('未送达 20 条');
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('retryable run_error keeps the original line as failed; a fatal one does not', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      () => {
        throw new Error('mg_gateway_error: 503 service unavailable');
      },
      () => {
        throw new Error('mg_gateway_error: 429 too many requests');
      },
      () => {
        throw new Error('model_timeout: whole turn exceeded');
      },
      () => {
        throw new Error('mg_gateway_error: 401 unauthorized');
      },
    ]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      for (const line of ['这句 503', '这句 429', '这句超时']) {
        const summary = await shell.submit(line);
        expect(summary?.stopReason).toBe('run_error');
      }
      const failed = shell.machine.runtime.inboundQueue?.filter((entry) => entry.status === 'failed') ?? [];
      expect(failed.map((entry) => entry.text)).toEqual(['这句 503', '这句 429', '这句超时']);
      expect(shell.currentStatus().failedInbound).toBe(3);

      const saved = JSON.parse(readFileSync(join(dir, 'data', 'checkpoint.json'), 'utf8')) as {
        runtime: { inboundQueue: Array<{ id: string; text?: string; textId?: string; status: string }> };
      };
      const stored = saved.runtime.inboundQueue.filter((entry) => entry.status === 'failed');
      expect(stored).toHaveLength(3);
      expect(stored.some((entry) => entry.text !== undefined)).toBe(false);
      expect(stored.every((entry) => typeof entry.textId === 'string')).toBe(true);
      expect(shell.stateLedger.read(stored[0]!.textId!)).toBe('这句 503');

      const fatal = await shell.submit('这句 401');
      expect(fatal?.stopReason).toBe('run_error');
      expect(shell.machine.runtime.inboundQueue?.filter((entry) => entry.status === 'failed')).toHaveLength(3);
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('/resend resends by inbound id exactly once', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      () => {
        throw new Error('mg_gateway_error: 503 provider down');
      },
      { text: '补上了', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      const summary = await shell.submit('这句要重发');
      expect(summary?.stopReason).toBe('run_error');
      const failed = shell.machine.runtime.inboundQueue?.filter((entry) => entry.status === 'failed') ?? [];
      expect(failed).toHaveLength(1);
      const id = failed[0]!.id;

      const resent = await shell.runCommand('resend');
      expect(resent.text).toContain('已重发');
      await waitUntil(() => provider.calls.length === 2);
      expect(provider.calls[1]!.messages.map((message) => message.content).join('\n')).toContain('这句要重发');

      const again = await shell.runCommand('resend', id);
      expect(again.text).toContain('没有可重发的未送达消息');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(provider.calls).toHaveLength(2);
      expect(shell.currentStatus().failedInbound).toBe(0);
    } finally {
      await shell.stop();
    }
  }, 60_000);
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

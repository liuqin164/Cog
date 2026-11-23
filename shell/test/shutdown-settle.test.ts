import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScriptedProvider, makeShell, makeTempDir, seedOpenAssignment, waitUntil } from './helpers.ts';

describe('shutdown settles in-flight work', () => {
  test('a stop leaves the rest of the inbound queue queued for the next process', async () => {
    const dir = makeTempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const provider = {
      name: 'blocked',
      model: 'blocked/test',
      async complete() {
        started = true;
        await gate;
        return { text: 'first done', toolCalls: [], stopReason: 'aborted' as const };
      },
    };
    const shell = makeShell(dir, provider);
    await shell.start();
    seedOpenAssignment(shell, 'first');
    const first = shell.submit('first');
    await waitUntil(() => started);
    await shell.submit('second', 'web');
    await shell.submit('third', 'web');
    expect(shell.machine.runtime.inboundQueue?.map((entry) => entry.status)).toEqual(['queued', 'queued']);
    const stopping = shell.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await stopping;
    await first;
    expect(shell.machine.runtime.inboundQueue?.map((entry) => [entry.text, entry.status])).toEqual([
      ['second', 'queued'],
      ['third', 'queued'],
    ]);
    expect(shell.machine.runtime.openAssignment).toMatchObject({ text: 'first', latestUserText: 'first' });
    expect(shell.trace.read().some((record) => record.kind === 'inbound_failed')).toBe(false);

    const again = makeShell(dir, new ScriptedProvider([
      { text: 'second done', toolCalls: [] },
      { text: 'third done', toolCalls: [] },
      { text: 'trigger done', toolCalls: [] },
    ]));
    await again.start();
    try {
      expect(again.machine.runtime.inboundQueue?.map((entry) => entry.text)).toEqual(['second', 'third']);
      const opened = again.trace.read().filter((record) => record.kind === 'assignment_opened').length;
      expect(await again.submit('trigger')).toMatchObject({ stopReason: 'run_complete' });
      expect(again.machine.runtime.inboundQueue).toBeUndefined();
      expect(again.trace.read().filter((record) => record.kind === 'assignment_opened')).toHaveLength(opened);
    } finally {
      await again.stop();
    }
  }, 20_000);

  test('a stop waits for the drain that is still waking', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'should not run', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
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
      const submitted = shell.submit('wake-bound');
      await waitUntil(() => paused);
      let closed = false;
      const close = shell.kernel.close.bind(shell.kernel);
      shell.kernel.close = () => { closed = true; close(); };
      const stopping = shell.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shell.state).toBe('WAKING');
      expect(closed).toBe(false);
      release();
      await stopping;
      expect(await submitted).toBeUndefined();
      expect(provider.calls).toHaveLength(0);
      expect(closed).toBe(true);
      expect(shell.state).toBe('DORMANT');
      expect(shell.machine.runtime.inboundQueue?.[0]).toMatchObject({ text: 'wake-bound', status: 'queued' });
    } finally {
      await shell.stop();
    }
  }, 15_000);

  test('a stop waits for an in-flight tick', async () => {
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]));
    await shell.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    let finished = false;
    let closed = false;
    (shell.residentTick as unknown as { tickOnce: (at: number) => Promise<void> }).tickOnce = async () => {
      started = true;
      await gate;
      finished = true;
    };
    const close = shell.kernel.close.bind(shell.kernel);
    shell.kernel.close = () => { closed = true; close(); };
    const ticking = shell.tick();
    await waitUntil(() => started);
    const stopping = shell.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    expect(finished).toBe(false);
    release();
    await stopping;
    await ticking;
    expect(finished).toBe(true);
    expect(closed).toBe(true);
  });

  test('a settle timeout refuses late checkpoint writes', async () => {
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]));
    await shell.start();
    await shell.machine.dispatch('message_received', { runId: 'run-late' });
    shell.runLoop.settleInFlight = async () => false;
    await shell.stop();
    expect(shell.state).toBe('DORMANT');
    const path = join(dir, 'data', 'checkpoint.json');
    const afterStop = readFileSync(path, 'utf8');
    expect(() => shell.machine.updateRuntime({ lastInteractionAt: 1 })).toThrow('checkpoint_write_failed');
    expect(readFileSync(path, 'utf8')).toBe(afterStop);

    const again = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]));
    await again.start();
    try {
      const afterRestart = readFileSync(path, 'utf8');
      expect(() => shell.machine.updateRuntime({ lastInteractionAt: 2 })).toThrow('state_machine_halted');
      expect(readFileSync(path, 'utf8')).toBe(afterRestart);
    } finally {
      await again.stop();
    }
  });
});

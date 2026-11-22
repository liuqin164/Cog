import { describe, expect, test } from 'bun:test';
import type { ModelCompletionInput, ModelProvider, ModelTurn } from '../src/state/agent-loop.ts';
import { makeShell, makeTempDir, waitUntil } from './helpers.ts';

class AbortProvider implements ModelProvider {
  readonly name = 'abort';
  readonly model = 'abort/test';
  started = false;

  complete(input: ModelCompletionInput): Promise<ModelTurn> {
    this.started = true;
    return new Promise((resolve) => {
      if (input.signal?.aborted) {
        resolve({ text: '', toolCalls: [], stopReason: 'aborted', error: 'aborted' });
        return;
      }
      input.signal?.addEventListener('abort', () => {
        resolve({ text: '', toolCalls: [], stopReason: 'aborted', error: 'aborted' });
      }, { once: true });
    });
  }
}

describe('shutdown waits for the run in flight (#438)', () => {
  test('stop leaves through the legal edge, writes the capture, and never logs an illegal transition', async () => {
    const dir = makeTempDir();
    const provider = new AbortProvider();
    const shell = makeShell(dir, provider);
    await shell.start();
    const run = shell.submit('wait for the shutdown');
    await waitUntil(() => provider.started);
    await shell.stop();
    const summary = await run;
    expect(summary?.stopReason).toBe('run_aborted');
    expect(shell.machine.state).toBe('DORMANT');
    const kinds = shell.trace.read().map((record) => record.kind);
    expect(kinds).not.toContain('illegal_transition');
    expect(kinds).not.toContain('run_settle_timeout');
    expect(kinds).toContain('capture_run');
  }, 30_000);
});

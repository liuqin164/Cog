import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

function outputCollector() {
  let text = '';
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        text += chunk.toString();
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => text,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for terminal output');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe('terminal channel round trip', () => {
  test('a line becomes a turn, the reply is printed, and the turn is captured', async () => {
    const dir = makeTempDir();
    const input = new PassThrough();
    const output = outputCollector();
    const provider = new ScriptedProvider([{ text: '你好，我在。', toolCalls: [] }]);
    const shell = makeShell(dir, provider, { terminalEnabled: true }, { terminalInput: input, terminalOutput: output.stream });
    await shell.start();
    try {
      expect(shell.state).toBe('IDLE');
      input.write('你好\n');
      await waitFor(() => output.text().includes('你好，我在。'));
      expect(shell.state).toBe('IDLE');

      input.write('/definitely-not-a-command\n');
      await waitFor(() => output.text().includes('unknown command'));

      const clock = shell.host.getService<{ localDate(at?: number): string }>('clock');
      const events = shell.kernel.getThreadEvents(`companion-day:${clock.localDate()}`, { projectId: shell.config.projectId, limit: 50 });
      expect(events.some((event) => JSON.stringify(event.payload).includes('你好'))).toBe(true);
    } finally {
      await shell.stop();
    }
  });
});

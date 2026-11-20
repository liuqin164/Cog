import { describe, expect, test } from 'bun:test';

import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };

async function health(shell: ReturnType<typeof makeShell>): Promise<any> {
  const response = await fetch(`${shell.httpUrl}/health`);
  return response.json();
}

describe('context assembly failures reach the health face (#350)', () => {
  test('a throwing lane still answers, increments the count, degrades after 3, and clears on success', async () => {
    const provider = new ScriptedProvider([{ text: '一。', toolCalls: [] }, { text: '二。', toolCalls: [] }, { text: '三。', toolCalls: [] }, { text: '四。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('assembly-health-'), provider, {
      dream: NO_DREAM,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    const recall = shell.backend.recall.bind(shell.backend);
    await shell.start();
    try {
      shell.backend.recall = (() => {
        throw new Error('lane exploded');
      }) as typeof shell.backend.recall;
      for (let index = 0; index < 3; index += 1) {
        await shell.submit(`第 ${index + 1} 句`);
        const payload = await health(shell);
        expect(payload.contextAssembly.failures).toBe(index + 1);
        expect(payload.contextAssembly.consecutive).toBe(index + 1);
        expect(payload.contextAssembly.lastFailure.message).toBe('lane exploded');
        expect(payload.status).toBe(index === 2 ? 'degraded' : 'ok');
      }
      expect(provider.calls).toHaveLength(3);
      expect(shell.trace.read().filter((record) => record.kind === 'plugin_log' && record.message === 'context_lanes_failed')).toHaveLength(3);
      const failedAt = (await health(shell)).contextAssembly.lastFailure.at;

      shell.backend.recall = recall;
      await shell.submit('恢复后的一句');
      const recovered = await health(shell);
      expect(provider.calls).toHaveLength(4);
      expect(recovered.contextAssembly).toMatchObject({
        failures: 3,
        consecutive: 0,
        lastFailure: { at: failedAt, message: 'lane exploded' },
      });
      expect(recovered.status).toBe('ok');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

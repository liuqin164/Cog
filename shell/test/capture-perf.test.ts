import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };

async function captureBytes(size: number): Promise<{ elapsed: number; text: string; events: Array<{ eventType: string; rawEventType?: string }> }> {
  const shell = makeShell(makeTempDir('capture-perf-'), new ScriptedProvider([
    { text: 'running', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: `head -c ${size} /dev/zero | tr '\\0' x` } }] },
    { text: 'done', toolCalls: [] },
  ]), { dream: NO_DREAM });
  await shell.start();
  try {
    const started = performance.now();
    await shell.submit('dump it');
    const elapsed = performance.now() - started;
    const clock = shell.host.getService<{ localDate(at?: number): string }>('clock');
    const events = shell.kernel.getThreadEvents(`companion-day:${clock.localDate()}`, { projectId: shell.config.projectId, limit: 100 });
    const text = (events.find((event) => event.rawEventType === 'tool_result')?.payload as { text?: string } | undefined)?.text ?? '';
    return { elapsed, text, events: events.map((event) => ({ eventType: event.eventType, rawEventType: event.rawEventType })) };
  } finally {
    await shell.stop();
  }
}

describe('a large tool result is captured without compiling it (#359)', () => {
  test('40 KB and 12 KB land raw, whole, and the capture stays in the one-second order', async () => {
    const big = await captureBytes(40_000);
    expect(big.text).toHaveLength(40_000);
    expect(big.elapsed).toBeLessThan(5_000);
    expect(big.events.every((event) => event.eventType === 'RAW_EVENT_RECORDED')).toBe(true);

    const small = await captureBytes(12_000);
    expect(small.text).toHaveLength(12_000);
    expect(small.elapsed).toBeLessThan(5_000);
    expect(small.events.every((event) => event.eventType === 'RAW_EVENT_RECORDED')).toBe(true);
  }, 30_000);

  test('a tool result past the cap is truncated, not stored whole (#325)', async () => {
    const large = await captureBytes(60_000);
    expect(large.text.length).toBeLessThan(60_000);
    expect(large.text).toMatch(/\[tool result truncated: \d+ chars omitted\]$/);
    expect(large.events.every((event) => event.eventType === 'RAW_EVENT_RECORDED')).toBe(true);
  }, 30_000);
});

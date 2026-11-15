/**
 * #226 soak discriminator — the criteria are frozen here, before any run:
 *
 *   warmup:        first 20 cycles discarded (JIT, lazy imports, first fills)
 *   sampling:     every 10 cycles after warmup, 10 samples (cycles 20, 30, … 110)
 *   sample:       Bun.gc(true), then process.memoryUsage().rss and .heapUsed
 *   judgement:    least-squares slope over the 10 samples
 *                 rss  < 256 KiB/cycle, and last sample − first sample < 32 MiB
 *                 heap < 64 KiB/cycle
 *   why these:    RSS in this harness swings ±30 MiB around a flat mean from forced-GC timing
 *                 (first run: 270 → 242 MiB, slope −349 KiB/cycle), so a 4 KiB/cycle line would be
 *                 below the measurement floor and could only flake. The per-turn structural leaks
 *                 (transcript, recall dedup, capture buffer) are asserted exactly in
 *                 memory-safety.test.ts; this test is the long-trend guard the ticket asks for.
 *   cycles:       120 total, mixed — a normal submit turn, a web fetch against a local
 *                 fixture (Readability/Turndown + cache write), and an idle self-wake
 *                 (`tick` past the scheduled wake intent; health/emergence also run).
 *
 * Run: TMPDIR="$PWD/.cogmem/tmp" bun test shell/test/soak-memory.test.ts
 * A failing slope is a finding, not a threshold to tune.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PluginHost } from '../src/plugins/host.ts';
import { webPlugin } from '../src/plugins/web.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const WARMUP_CYCLES = 20;
const SAMPLE_EVERY = 10;
const SAMPLE_COUNT = 10;
const TOTAL_CYCLES = WARMUP_CYCLES + SAMPLE_EVERY * SAMPLE_COUNT;
const MAX_RSS_SLOPE_BYTES_PER_CYCLE = 256 * 1024;
const MAX_RSS_END_TO_END_BYTES = 32 * 1024 * 1024;
const MAX_HEAP_SLOPE_BYTES_PER_CYCLE = 64 * 1024;

const ARTICLE_HTML = `<!doctype html><html><head><title>Soak Article</title></head><body>
  <article><h1>Soak Article</h1>
  <p>The body is long enough to clear the extraction floor and exercise the Markdown conversion path.</p>
  <p>A second paragraph keeps Readability from treating this as a failure page.</p>
  </article></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      if (new URL(request.url).pathname === '/article') {
        return new Response(ARTICLE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function slope(points: Array<{ x: number; y: number }>): number {
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

test('retained RSS stays flat across mixed resident cycles', async () => {
  const dir = makeTempDir('companion-soak-');
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const provider = new ScriptedProvider([
    (_input, call) => call % 2 === 0
      ? { text: 'checking', toolCalls: [{ toolCallId: `soak-${call}`, toolName: 'read', input: { path: 'no-such-soak-file.txt' } }] }
      : { text: 'done', toolCalls: [] },
  ]);
  const shell = makeShell(dir, provider, {
    idleWakeIntervalMs: 1_000,
    // Keep the dream window out of the soak's artificial 12:00 clock.
    dream: { windowStartHour: 23, windowEndHour: 23, runKernelNight: false, maxEpisodes: 5 },
    attach: { enabled: true, socketPath: join(dir, 'attach.sock') },
  }, { now: () => now });
  const web = new PluginHost();
  web.register(webPlugin({ dataDir: join(dir, 'web'), allowLoopback: true, now: () => now }));
  await shell.start();
  await web.start();
  const rssSamples: Array<{ x: number; y: number }> = [];
  const heapSamples: Array<{ x: number; y: number }> = [];
  try {
    for (let cycle = 0; cycle < TOTAL_CYCLES; cycle += 1) {
      now += 1_000;
      if (cycle % 4 === 0) {
        const fetched = await web.tools.invoke(
          'web_fetch',
          { toolCallId: `web-${cycle}`, input: { url: `${base}/article` } },
          { runId: `soak-web-${cycle}` },
        );
        expect(fetched.isError).toBe(false);
      } else {
        await shell.submit(`soak cycle ${cycle}: 这是第 ${cycle} 个普通回合，用来观察常驻内存是否随回合数上涨。`);
      }
      // Self-wake: the run scheduled an idle intent; one second later it is due.
      await shell.tick(now);
      if (cycle >= WARMUP_CYCLES && (cycle - WARMUP_CYCLES) % SAMPLE_EVERY === 0) {
        Bun.gc(true);
        const usage = process.memoryUsage();
        rssSamples.push({ x: cycle, y: usage.rss });
        heapSamples.push({ x: cycle, y: usage.heapUsed });
      }
    }
  } finally {
    await web.stop();
    await shell.stop();
  }

  const rssSlope = slope(rssSamples);
  const heapSlope = slope(heapSamples);
  const rssEndToEnd = rssSamples[rssSamples.length - 1]!.y - rssSamples[0]!.y;
  const summary = [
    `rss slope ${Math.round(rssSlope)} B/cycle (limit ${MAX_RSS_SLOPE_BYTES_PER_CYCLE})`,
    `rss end-to-end ${Math.round(rssEndToEnd)} B (limit ${MAX_RSS_END_TO_END_BYTES})`,
    `heap slope ${Math.round(heapSlope)} B/cycle (limit ${MAX_HEAP_SLOPE_BYTES_PER_CYCLE})`,
    `rss samples [${rssSamples.map((point) => Math.round(point.y / 1024)).join(', ')}] KiB`,
    `heap samples [${heapSamples.map((point) => Math.round(point.y / 1024)).join(', ')}] KiB`,
  ].join('; ');
  console.log(`[soak-memory] ${summary}`);
  expect(rssSamples.length).toBe(SAMPLE_COUNT);
  expect(rssSlope, summary).toBeLessThan(MAX_RSS_SLOPE_BYTES_PER_CYCLE);
  expect(rssEndToEnd, summary).toBeLessThan(MAX_RSS_END_TO_END_BYTES);
  expect(heapSlope, summary).toBeLessThan(MAX_HEAP_SLOPE_BYTES_PER_CYCLE);
}, 120_000);

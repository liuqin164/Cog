/**
 * #226 soak discriminator — the criteria are frozen here, before any run:
 *
 *   warmup:        first 20 cycles discarded (JIT, lazy imports, first fills)
 *   sampling:     every 10 cycles after warmup, 10 samples (cycles 20, 30, … 110)
 *   sample:       Bun.gc(true), then process.memoryUsage().rss and .heapUsed
 *   judgement:    rss end-to-end (last sample − first sample) < 96 MiB
 *                 heap slope < 64 KiB/cycle
 *                 The per-cycle RSS slope is logged for diagnosis, not asserted (#230).
 *   rss bound:    calibrated on the development box (Linux, Bun 1.3.14, 96 GB disk) over
 *                 seven full 120-cycle runs of this exact load: end-to-end was 9.7, 18.0,
 *                 18.7, 20.7, 30.9, 34.0 and 35.2 MiB. Individual samples swing
 *                 307–387 MiB around a flat ~355 MiB mean because forced-GC timing moves
 *                 the measurement, not retention; one run's own samples spanned 74 MiB,
 *                 so end-to-end — a difference of two noisy points — is only as stable as
 *                 that swing. The old 32 MiB line sat inside it and flaked once in seven
 *                 runs (33.96 MiB with a negative heap slope). 96 MiB is ~2.7× the
 *                 observed maximum and above the largest within-run span: a retained leak
 *                 still has to clear the GC noise floor to trip it.
 *   why the RSS slope is no longer a gate: #230 removed the old per-tick recall, whose SQLite
 *                 writes used to trigger WAL auto-checkpoint. The soak then retained WAL/mmap
 *                 pages, so the slope was measuring allocator/WAL noise rather than retained
 *                 memory. Susan's independent rerun on one binary: 8 runs, 4 pass / 4 fail
 *                 (275k / 358k B/cycle), while heap slope was always negative and rss
 *                 end-to-end always stayed inside 32 MiB. Bounding the WAL with
 *                 `wal_autocheckpoint=256` removed the root cause, but the remaining slope still
 *                 flips sign run to run. The two criteria kept below are the ones that actually
 *                 measure retention; tuning the slope further would chase the allocator.
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
 * A failing end-to-end or heap slope is a finding, not a threshold to tune. The RSS slope is
 * evidence, not a gate (#230).
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
const RSS_SLOPE_DIAGNOSTIC_BYTES_PER_CYCLE = 256 * 1024;
const MAX_RSS_END_TO_END_BYTES = 96 * 1024 * 1024;
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
    dream: { windowStartHour: 0, windowEndHour: 1, runKernelNight: false, maxEpisodes: 5 },
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
    `rss slope ${Math.round(rssSlope)} B/cycle (diagnostic; old gate ${RSS_SLOPE_DIAGNOSTIC_BYTES_PER_CYCLE})`,
    `rss end-to-end ${Math.round(rssEndToEnd)} B (limit ${MAX_RSS_END_TO_END_BYTES})`,
    `heap slope ${Math.round(heapSlope)} B/cycle (limit ${MAX_HEAP_SLOPE_BYTES_PER_CYCLE})`,
    `rss samples [${rssSamples.map((point) => Math.round(point.y / 1024)).join(', ')}] KiB`,
    `heap samples [${heapSamples.map((point) => Math.round(point.y / 1024)).join(', ')}] KiB`,
  ].join('; ');
  console.log(`[soak-memory] ${summary}`);
  expect(rssSamples.length).toBe(SAMPLE_COUNT);
  expect(rssEndToEnd, summary).toBeLessThan(MAX_RSS_END_TO_END_BYTES);
  expect(heapSlope, summary).toBeLessThan(MAX_HEAP_SLOPE_BYTES_PER_CYCLE);
}, 120_000);

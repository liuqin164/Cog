import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { createMemoryKernel } from '../src/factory.js';
import { MemoryObservatory } from '../src/observatory/MemoryObservatory.js';
import { SURFACING_OBSERVABILITY_WINDOW_MS } from '../src/observability/SurfacingObservability.js';
import { SURFACING_CHANNEL_POLICY, SURFACING_FEEDBACK_RULES } from '../src/surfacing/index.js';
import { makeTempDir } from './helpers/tmp.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const started = makeTempDir('cogmem-surfacing-observability-');

afterAll(() => {
  rmSync(started, { recursive: true, force: true });
});

function traceRecord(at: number, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { at, kind, ...extra };
}

describe('surfacing observability', () => {
  test('counts candidates, per-gate withholds, surfaced, held, and feedback inside one window', () => {
    const dbPath = join(started, 'memory.sqlite');
    const tracePath = join(started, 'shell-events.jsonl');
    const now = Date.UTC(2026, 10, 16, 12);
    const kernel = createMemoryKernel({ dbPath });
    try {
      for (const [outcome, projectId, at] of [
        ['ignored', 'p', now - 2 * DAY_MS],
        ['ignored', 'p', now - DAY_MS],
        ['engaged', 'p', now - 3 * 60 * 60_000],
        ['stopped', 'p', now - 60 * 60_000],
        ['ignored', 'p', now - SURFACING_OBSERVABILITY_WINDOW_MS - DAY_MS],
        ['ignored', 'other', now - DAY_MS],
      ] as const) {
        kernel.surfacingFeedback.record({ projectId, candidateId: `surfacing:commitment:${outcome}-${at}`, outcome, now: at });
      }
    } finally {
      kernel.close();
    }

    writeFileSync(tracePath, [
      traceRecord(now - 2_000, 'emergence_decision', {
        candidates: [{ id: 'surfacing:commitment:c1' }],
        withheld: [
          { id: 'k', steps: [{ rule: 'channel', outcome: 'withheld', detail: { hardWithhold: true } }] },
          { id: 'p', steps: [{ rule: 'channel', outcome: 'withheld', detail: { channel: 'proactive', policy: { proactive: false } } }] },
          { id: 'e', steps: [{ rule: 'channel', outcome: 'withheld', detail: { expired: true } }] },
          { id: 'm', steps: [{ rule: 'channel', outcome: 'withheld', detail: {} }] },
          { id: 'o', steps: [{ rule: 'occasion', outcome: 'bound', detail: { decision: 'withheld', reason: 'occasion_third_party' } }] },
        ],
        excluded: [{ id: 'x', source: 'profile', reason: 'no_due_instant' }],
      }),
      traceRecord(now - 1_500, 'emergence_consumed', { id: 'surfacing:commitment:c1' }),
      traceRecord(now - 1_000, 'emergence_consumed', { id: 'surfacing:commitment:c2' }),
      traceRecord(now - 1_000, 'emergence_accumulated', { id: 'surfacing:commitment:c2' }),
      traceRecord(now - SURFACING_OBSERVABILITY_WINDOW_MS - 2 * DAY_MS, 'emergence_decision', { candidates: [{ id: 'old' }] }),
    ].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');

    const db = new Database(dbPath, { readonly: true });
    try {
      const health = new MemoryObservatory({ db, tracePath }).health({ now, projectId: 'p' });
      const surfacing = health.surfacing;
      expect(surfacing.window).toEqual({ from: now - SURFACING_OBSERVABILITY_WINDOW_MS, to: now, windowMs: SURFACING_OBSERVABILITY_WINDOW_MS });
      expect(surfacing.counts).toEqual({
        decisions: 1,
        considered: 7,
        candidates: 1,
        withheld: 5,
        excluded: 1,
        surfaced: 1,
        held: 1,
        engaged: 1,
        ignored: 2,
        stopped: 1,
      });
      expect(surfacing.gates).toEqual([
        { gate: 'keychain', count: 1 },
        { gate: 'policy', count: 1 },
        { gate: 'expired', count: 1 },
        { gate: 'modulation', count: 1 },
        { gate: 'occasion_third_party', count: 1 },
        { gate: 'no_due_instant', count: 1 },
      ]);
      expect(surfacing.priors).toEqual({
        feedback: SURFACING_FEEDBACK_RULES,
        channelPolicy: SURFACING_CHANNEL_POLICY,
        gates: ['keychain', 'policy', 'expired', 'modulation', 'occasion_private_tier', 'occasion_third_party', 'no_due_instant'],
      });
      expect(surfacing.sources).toEqual({ trace: { path: tracePath, readable: true }, feedback: { readable: true } });

      const withoutTrace = new MemoryObservatory({ db }).health({ now, projectId: 'p' }).surfacing;
      expect(withoutTrace.sources.trace).toEqual({ path: null, readable: false });
      expect(withoutTrace.counts.considered).toBe(0);
      expect(withoutTrace.counts.ignored).toBe(2);
    } finally {
      db.close();
    }
  });
});

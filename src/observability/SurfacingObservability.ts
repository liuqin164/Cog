/**
 * The surfacing feedback gate, as counts (#239).
 *
 * The kernel's surfacing query returns candidates and withheld entries but persists neither. So this
 * face reads the two records that already exist: the owner's reactions in `memory_events`, and the
 * shell's `emergence_decision` / `emergence_consumed` / `emergence_run` rows in
 * `shell-events.jsonl` and its rotated `.1` generation. It writes nothing, adds no event and
 * leaves `SurfacingCandidates` / `SurfacingFeedback` untouched.
 *
 * `attempted` is consumed minus held for absence: the shell consumes a candidate before deciding
 * whether anyone is there, and the `emergence_accumulated` row is the one it put in the away queue
 * instead of speaking. A `run_error` after consumption is not a surfaced reply, so `surfaced`
 * counts only the run rows the shell marked successful. A gate count can exceed the withheld total
 * because one entry may fail both the channel and occasion gates; that overlap is the point of
 * counting by gate.
 */
import { readFileSync } from 'node:fs';

import type Database from 'bun:sqlite';

import {
  SURFACING_CHANNEL_POLICY,
  SURFACING_FEEDBACK_RULES,
  type SurfacingFeedbackOutcome,
} from '../surfacing/index.js';

export const SURFACING_OBSERVABILITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The gates the emergence trace names, plus the shell's own due-instant filter. */
export const SURFACING_OBSERVABILITY_GATES = [
  'keychain',
  'policy',
  'expired',
  'modulation',
  'occasion_private_tier',
  'occasion_third_party',
  'no_due_instant',
] as const;
export type SurfacingObservabilityGate = (typeof SURFACING_OBSERVABILITY_GATES)[number];

export interface SurfacingGateCount {
  gate: SurfacingObservabilityGate;
  count: number;
}

export interface SurfacingObservability {
  source: 'live';
  generatedAt: number;
  window: { from: number; to: number; windowMs: number };
  counts: {
    decisions: number;
    /** Every kernel result: returned candidates, first-class withheld entries, and shell-excluded ones. */
    considered: number;
    candidates: number;
    withheld: number;
    excluded: number;
    /** Consumed and not held for absence. */
    attempted: number;
    /** Attempted and ended in a successful run. */
    surfaced: number;
    /** Attempted but the run errored, aborted or hit budget. */
    runFailed: number;
    /** Consumed while the owner was away, so queued rather than spoken. */
    held: number;
    engaged: number;
    ignored: number;
    stopped: number;
  };
  gates: SurfacingGateCount[];
  priors: {
    feedback: typeof SURFACING_FEEDBACK_RULES;
    channelPolicy: typeof SURFACING_CHANNEL_POLICY;
    gates: readonly SurfacingObservabilityGate[];
  };
  sources: {
    trace: { path: string | null; readable: boolean };
    feedback: { readable: boolean };
  };
}

interface TraceStep {
  rule?: unknown;
  outcome?: unknown;
  detail?: Record<string, unknown>;
}

interface TraceEntry {
  kind?: unknown;
  at?: unknown;
  projectId?: unknown;
  candidates?: unknown;
  withheld?: unknown;
  excluded?: unknown;
  ok?: unknown;
}

function isOutcome(value: unknown): value is SurfacingFeedbackOutcome {
  return value === 'engaged' || value === 'ignored' || value === 'stopped';
}

function gatesOf(entry: Record<string, unknown>): SurfacingObservabilityGate[] {
  const gates: SurfacingObservabilityGate[] = [];
  const steps = Array.isArray(entry.steps) ? entry.steps as TraceStep[] : [];
  for (const step of steps) {
    const detail = step.detail ?? {};
    if (step.rule === 'channel' && step.outcome === 'withheld') {
      gates.push(detail.hardWithhold === true
        ? 'keychain'
        : detail.policy && typeof detail.policy === 'object' && (detail.policy as Record<string, unknown>)[String(detail.channel)] === false
          ? 'policy'
          : detail.expired === true
            ? 'expired'
            : 'modulation');
    }
    if (step.rule === 'occasion' && detail.decision === 'withheld') {
      if (detail.reason === 'occasion_third_party') gates.push('occasion_third_party');
      else gates.push('occasion_private_tier');
    }
  }
  return gates;
}

function readTrace(tracePath: string | undefined, projectId: string | undefined, from: number, to: number): {
  counts: Pick<SurfacingObservability['counts'], 'decisions' | 'considered' | 'candidates' | 'withheld' | 'excluded' | 'attempted' | 'surfaced' | 'held' | 'runFailed'>;
  gates: SurfacingGateCount[];
  readable: boolean;
} {
  const counts = {
    decisions: 0,
    considered: 0,
    candidates: 0,
    withheld: 0,
    excluded: 0,
    attempted: 0,
    surfaced: 0,
    held: 0,
    runFailed: 0,
  };
  const gates = new Map<SurfacingObservabilityGate, number>();
  if (!tracePath) return { counts, gates: [], readable: false };

  let readable = false;
  // The shell rotates one generation to `.1`, so a seven-day window can span two files.
  for (const path of [`${tracePath}.1`, tracePath]) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    readable = true;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry: TraceEntry;
      try {
        entry = JSON.parse(line) as TraceEntry;
      } catch {
        // The shell's trace is damage-tolerant; one torn line must not hide the rest.
        continue;
      }
      if (typeof entry.at !== 'number' || entry.at < from || entry.at > to) continue;
      if (projectId && entry.projectId !== projectId) continue;
      if (entry.kind === 'emergence_decision') {
        counts.decisions += 1;
        const candidates = Array.isArray(entry.candidates) ? entry.candidates.length : 0;
        const withheld = Array.isArray(entry.withheld) ? entry.withheld as Array<Record<string, unknown>> : [];
        const excluded = Array.isArray(entry.excluded) ? entry.excluded as Array<Record<string, unknown>> : [];
        counts.candidates += candidates;
        counts.withheld += withheld.length;
        counts.excluded += excluded.length;
        counts.considered += candidates + withheld.length + excluded.length;
        for (const item of withheld) {
          for (const gate of gatesOf(item)) gates.set(gate, (gates.get(gate) ?? 0) + 1);
        }
        for (const item of excluded) {
          if (item.reason === 'no_due_instant') gates.set('no_due_instant', (gates.get('no_due_instant') ?? 0) + 1);
        }
      } else if (entry.kind === 'emergence_consumed') {
        counts.attempted += 1;
      } else if (entry.kind === 'emergence_accumulated') {
        counts.held += 1;
      } else if (entry.kind === 'emergence_run') {
        if (entry.ok === true) counts.surfaced += 1;
        else counts.runFailed += 1;
      }
    }
  }

  return {
    counts: { ...counts, attempted: Math.max(0, counts.attempted - counts.held), runFailed: counts.runFailed },
    gates: SURFACING_OBSERVABILITY_GATES
      .map((gate) => ({ gate, count: gates.get(gate) ?? 0 }))
      .filter((entry) => entry.count > 0),
    readable: true,
  };
}

function readFeedback(db: Database, projectId: string | undefined, from: number, to: number): {
  counts: Pick<SurfacingObservability['counts'], 'engaged' | 'ignored' | 'stopped'>;
  readable: boolean;
} {
  const counts = { engaged: 0, ignored: 0, stopped: 0 };
  try {
    const rows = db
      .query(`
        SELECT json_extract(payload_json, '$.outcome') AS outcome, COUNT(*) AS c
        FROM memory_events
        WHERE event_type = 'SURFACING_FEEDBACK_RECORDED'
          AND occurred_at >= ? AND occurred_at <= ?
          ${projectId ? 'AND project_id = ?' : ''}
        GROUP BY outcome
      `)
      .all(...(projectId ? [from, to, projectId] : [from, to])) as Array<{ outcome?: string; c?: number }>;
    for (const row of rows) {
      if (isOutcome(row.outcome)) counts[row.outcome] = Number(row.c ?? 0);
    }
    return { counts, readable: true };
  } catch {
    return { counts, readable: false };
  }
}

export function readSurfacingObservability(
  db: Database,
  options: { now?: number; projectId?: string; windowMs?: number; tracePath?: string } = {},
): SurfacingObservability {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? SURFACING_OBSERVABILITY_WINDOW_MS;
  const from = now - windowMs;
  const projectId = options.projectId?.trim() || undefined;
  const trace = readTrace(options.tracePath, projectId, from, now);
  const feedback = readFeedback(db, projectId, from, now);
  return {
    source: 'live',
    generatedAt: now,
    window: { from, to: now, windowMs },
    counts: { ...trace.counts, ...feedback.counts },
    gates: trace.gates,
    priors: {
      feedback: SURFACING_FEEDBACK_RULES,
      channelPolicy: SURFACING_CHANNEL_POLICY,
      gates: SURFACING_OBSERVABILITY_GATES,
    },
    sources: {
      trace: { path: options.tracePath ?? null, readable: trace.readable },
      feedback: { readable: feedback.readable },
    },
  };
}

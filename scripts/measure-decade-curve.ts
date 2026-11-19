#!/usr/bin/env bun
/**
 * The ten-year curve (#238): what write-time compilation and recall cost as a ledger grows
 * from one year to ten.
 *
 *   TMPDIR="$PWD/.cogmem/tmp" bun scripts/measure-decade-curve.ts [--json]
 *
 * The write intensity is the one the year-scale corpus already used (§4.64): 10,020 turns a
 * year, about 27 turns a day, and two events per turn (that corpus recorded 20,343 events).
 * A decade is therefore 100,200 turns / 200,400 raw events. The corpus is deterministic, and
 * the experiment never touches the resident's data directory — it writes to its own
 * temporary directory.
 *
 * Two numbers are measured at each year boundary, on the same open kernel:
 *
 * The bulk ledger is seeded as raw events in one transaction per year; writing 100,200 turns
 * through the real path would take hours and would itself be the thing being measured. The
 * checkpoints then measure the two paths a user feels:
 *
 * - **compile**: the write-time compilation path (`rememberTurnWithResult`, the default
 *   `immediate_compile` mode) over a small fresh probe batch on top of the seeded ledger.
 *   This is what a user waits for when a turn is remembered, not a Dream or Atlas rebuild.
 * - **recall**: `KernelAgentMemoryBackend.recall` for one unique planted memory per year,
 *   queried by its own ticket number, over several rounds. The oldest target is nine to
 *   ten years old at the last checkpoint.
 *
 * The boundary is named rather than implied: no Dream or Atlas rebuild runs, so the recall
 * curve is the raw-ledger lane (the lane that answered 20/20 at year scale in §4.64), and
 * Atlas compile time is not measured.
 *
 * Only measurement: no kernel or recall behaviour is changed by this script. The JSON
 * output is the record; a year that has finished is written to `progress.json` so a killed
 * run resumes instead of starting over.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'bun:sqlite';

import { createMemoryKernel, KernelAgentMemoryBackend } from '../src/public.js';

export const DAY_MS = 86_400_000;
export const START = Date.UTC(2026, 0, 1);
/** §4.64: 10,020 turns in one year, about 27 turns a day. */
export const TURNS_PER_YEAR = 10_020;

const VERBS = ['重构', '迁移', '修复', '审计', '压测', '限流', '灰度', '回滚', '扩容', '降级'];
const OBJECTS = ['账单导出', '入职文案', '表结构', '鉴权链路', '消息队列', '冷启动', '灰度开关', '容量水位', '审计日志', '回溯索引'];
const PEOPLE = ['张伟', '李娜', '王强', '陈静'];

export interface DecadeCheckpoint {
  year: number;
  turns: number;
  events: number;
  episodes: number;
  atlasDocuments: number;
  dbBytes: number;
  compile: { samples: number; medianMs: number; p95Ms: number };
  recall: {
    queries: number;
    hits: number;
    p50Ms: number;
    p95Ms: number;
    byTarget: Array<{ year: number; ageDays: number; ms: number; hit: boolean }>;
  };
}

export interface DecadeResult {
  seed: number;
  turnsPerYear: number;
  years: number;
  dbPath: string;
  checkpoints: DecadeCheckpoint[];
}

export interface DecadeOptions {
  years?: number;
  turnsPerYear?: number;
  probeTurns?: number;
  recallRounds?: number;
  seed?: number;
  dir?: string;
  onProgress?: (line: string) => void;
}

interface Target {
  year: number;
  code: string;
  timestamp: number;
}

interface Progress {
  seed: number;
  turnsPerYear: number;
  years: number;
  nextYear: number;
  targets: Target[];
  checkpoints: DecadeCheckpoint[];
}

/** Nearest-rank quantile: the value at `ceil(p * n)` in sorted order. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function targetCode(year: number): string {
  return `DECADE-${String(year).padStart(2, '0')}-${(year * 7919) % 9000}`;
}

function targetText(year: number): string {
  return `有一件事：${VERBS[year % VERBS.length]} ${OBJECTS[year % OBJECTS.length]}，涉及单据号 ${targetCode(year)}，负责人 ${PEOPLE[year % PEOPLE.length]}。`;
}

function distractorText(year: number, index: number): string {
  return `第 ${year} 年第 ${index} 件事：${VERBS[index % VERBS.length]} ${OBJECTS[(index + 3) % OBJECTS.length]}，涉及单据号 D-${year}-${index}，负责人 ${PEOPLE[index % PEOPLE.length]}。`;
}

function count(db: Database, table: string): number {
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number } | undefined)?.c ?? 0);
  } catch {
    return 0;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Seed one year's raw ledger in one transaction. Two events per turn (user + assistant),
 * exactly the shape the year corpus recorded, so the decade's event count is comparable.
 */
function seedYear(db: Database, year: number, turnsPerYear: number): void {
  const inserted = Number((db.prepare(
    `SELECT COUNT(*) AS c FROM memory_events WHERE event_id LIKE ?`,
  ).get(`evt-decade-${year}-%`) as { c?: number } | undefined)?.c ?? 0);
  if (inserted > 0) return;
  const nextSeq = db.prepare(`SELECT COALESCE(MAX(global_seq), 0) AS value FROM memory_events`).get() as { value: number };
  let globalSeq = Number(nextSeq.value);
  const insertEvent = db.prepare(`
    INSERT INTO memory_events (
      event_id, global_seq, stream_id, stream_type, event_type, raw_event_type, event_version,
      project_id, project_scope, actor_id, source_id, content_hash, thread_id, session_id,
      local_date, local_date_source, thread_seq, turn_id, turn_seq, event_ordinal, role,
      prev_event_id, next_event_id, ordering_confidence, occurred_at, payload_json, payload_hash, created_at
    ) VALUES (?, ?, ?, 'thread', 'RAW_EVENT_RECORDED', 'message', 1, 'p', 'p', ?, ?, ?, ?, ?,
      ?, 'generated_project_timezone', ?, ?, ?, ?, ?, ?, ?, 'high', ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO memory_events_fts (
      event_id, text, project_id, workspace_id, thread_id, session_id, local_date, role, raw_event_type
    ) VALUES (?, ?, 'p', NULL, ?, ?, ?, ?, 'message')
  `);
  db.transaction(() => {
    for (let index = 0; index < turnsPerYear; index += 1) {
      const timestamp = START + (year - 1) * 365 * DAY_MS + Math.floor((index * 365 * DAY_MS) / turnsPerYear);
      const session = `y${year}-s${Math.floor(index / 10)}`;
      const turnId = `decade-${year}-${index}`;
      const userText = index === 0 ? targetText(year) : distractorText(year, index);
      const assistantText = index === 0 ? '记下了。' : `第 ${index} 项已记录。`;
      const userId = `evt-decade-${year}-${index}-u`;
      const assistantId = `evt-decade-${year}-${index}-a`;
      const userPayload = JSON.stringify({ text: userText, metadata: { sourceAgent: 'a' } });
      const assistantPayload = JSON.stringify({ text: assistantText, metadata: { sourceAgent: 'a' } });
      const localDate = new Date(timestamp).toISOString().slice(0, 10);
      for (const [eventId, role, ordinal, payload, at] of [
        [userId, 'user', 1, userPayload, timestamp],
        [assistantId, 'assistant', 2, assistantPayload, timestamp + 1],
      ] as const) {
        globalSeq += 1;
        insertEvent.run(
          eventId, globalSeq, `${turnId}-${role}`, role, `a:${session}`, sha256(payload),
          session, session, localDate, Math.floor(index / 10), turnId, index + 1, ordinal, role,
          ordinal === 2 ? userId : null, ordinal === 1 ? assistantId : null,
          at, payload, sha256(payload), Date.now(),
        );
        insertFts.run(eventId, role === 'user' ? userText : assistantText, session, session, localDate, role);
      }
    }
    const maxRowid = Number((db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS value FROM memory_events`).get() as { value: number }).value);
    const ftsRows = Number((db.prepare(`SELECT COUNT(*) AS value FROM memory_events_fts`).get() as { value: number }).value);
    const upsert = db.prepare(`INSERT INTO memory_event_fts_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    upsert.run('indexed_rowid', String(maxRowid));
    upsert.run('indexed_fts_rows', String(ftsRows));
  })();
}

/**
 * Build and measure the corpus. `dir` is always the experiment's own directory: the caller
 * may pass one, but nothing here falls back to the resident's data directory.
 */
export async function measureDecade(options: DecadeOptions = {}): Promise<DecadeResult> {
  const years = options.years ?? 10;
  const turnsPerYear = options.turnsPerYear ?? TURNS_PER_YEAR;
  const probeTurns = options.probeTurns ?? 20;
  const recallRounds = options.recallRounds ?? 3;
  const seed = options.seed ?? 20261116;
  const dir = options.dir ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'cogmem-decade-'));
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'memory.db');
  const progressPath = join(dir, 'progress.json');
  const progress = (): Progress | undefined => {
    if (!existsSync(progressPath)) return undefined;
    try {
      return JSON.parse(readFileSync(progressPath, 'utf8')) as Progress;
    } catch {
      return undefined;
    }
  };
  const save = (nextYear: number, targets: Target[], checkpoints: DecadeCheckpoint[]): void => {
    writeFileSync(progressPath, JSON.stringify({
      seed, turnsPerYear, years, nextYear, targets, checkpoints,
    } satisfies Progress, null, 2), 'utf8');
  };

  const previous = progress();
  const resume = previous
    && previous.seed === seed
    && previous.turnsPerYear === turnsPerYear
    && existsSync(dbPath);
  let nextYear = resume ? previous.nextYear : 1;
  const targets: Target[] = resume ? previous.targets : [];
  const checkpoints: DecadeCheckpoint[] = resume ? previous.checkpoints : [];
  if (!resume) save(1, targets, checkpoints);
  options.onProgress?.(`decade corpus ${dir}${resume ? ` (resuming at year ${nextYear})` : ''}`);

  const kernel = createMemoryKernel({ dbPath });
  const backend = new KernelAgentMemoryBackend(kernel, {
    binding: kernel.occasionScope.register({ channelId: 'decade-curve', occasion: 'private' }),
  });
  const db = kernel.factStore.getDatabase();
  try {
    for (let year = nextYear; year <= years; year += 1) {
      if (!targets.some((target) => target.year === year)) {
        targets.push({ year, code: targetCode(year), timestamp: START + (year - 1) * 365 * DAY_MS });
      }
      seedYear(db, year, turnsPerYear);

      const checkpointTime = START + year * 365 * DAY_MS - 1;
      const compileSamples: number[] = [];
      for (let probe = 0; probe < probeTurns; probe += 1) {
        const started = performance.now();
        const result = await backend.rememberTurnWithResult({
          agentId: 'a',
          projectId: 'p',
          sessionId: `probe-y${year}`,
          turnId: `probe-${year}-${probe}-${Date.now()}`,
          userText: distractorText(year, turnsPerYear + probe),
          assistantText: '探针已记录。',
          timestamp: checkpointTime,
        });
        const ms = performance.now() - started;
        if (!result.duplicate) compileSamples.push(ms);
      }

      const queries: Array<{ year: number; ms: number; hit: boolean }> = [];
      // Warm the recall statements and page cache on the first target; the measured rounds
      // then describe the ledger, not the first call in the process.
      const warm = targets.find((entry) => entry.year <= year);
      if (warm) {
        backend.recall({
          query: `单据号 ${warm.code} 那件事是谁负责的`,
          projectId: 'p',
          agentId: 'a',
          limit: 5,
          now: checkpointTime,
        });
      }
      for (let round = 0; round < recallRounds; round += 1) {
        for (const target of targets.filter((entry) => entry.year <= year)) {
          const started = performance.now();
          const recalled = backend.recall({
            query: `单据号 ${target.code} 那件事是谁负责的`,
            projectId: 'p',
            agentId: 'a',
            limit: 5,
            now: checkpointTime,
          });
          const ms = performance.now() - started;
          const hit = (recalled.items ?? []).some((item) => String((item as { text?: string }).text ?? '').includes(target.code));
          queries.push({ year: target.year, ms, hit });
        }
      }
      const byTarget = [...new Set(queries.map((query) => query.year))].map((targetYear) => {
        const rows = queries.filter((query) => query.year === targetYear);
        const target = targets.find((entry) => entry.year === targetYear)!;
        return {
          year: targetYear,
          ageDays: Math.round((checkpointTime - target.timestamp) / DAY_MS),
          ms: quantile(rows.map((row) => row.ms), 0.5),
          hit: rows.some((row) => row.hit),
        };
      });
      checkpoints.push({
        year,
        turns: year * turnsPerYear + year * probeTurns,
        events: count(db, 'memory_events'),
        episodes: count(db, 'memory_episodes'),
        atlasDocuments: count(db, 'memory_atlas_documents'),
        dbBytes: statSync(dbPath).size,
        compile: {
          samples: compileSamples.length,
          medianMs: quantile(compileSamples, 0.5),
          p95Ms: quantile(compileSamples, 0.95),
        },
        recall: {
          queries: queries.length,
          hits: queries.filter((query) => query.hit).length,
          p50Ms: quantile(queries.map((query) => query.ms), 0.5),
          p95Ms: quantile(queries.map((query) => query.ms), 0.95),
          byTarget,
        },
      });
      save(year + 1, targets, checkpoints);
      options.onProgress?.(
        `year ${year}: ${checkpoints[checkpoints.length - 1]!.events} events, `
        + `${checkpoints[checkpoints.length - 1]!.compile.medianMs.toFixed(1)} ms compile, `
        + `${checkpoints[checkpoints.length - 1]!.recall.p95Ms.toFixed(1)} ms recall p95`,
      );
    }
  } finally {
    kernel.close();
  }

  return { seed, turnsPerYear, years, dbPath, checkpoints };
}

function usage(): string {
  return 'Usage: bun scripts/measure-decade-curve.ts [--years 10] [--turns-per-year 10020] '
    + '[--probe-turns 20] [--recall-rounds 3] [--seed 20261116] [--dir <dir>] [--json]';
}

function intArg(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

function stringArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const options: DecadeOptions = {
    years: intArg(args, '--years', 10),
    turnsPerYear: intArg(args, '--turns-per-year', TURNS_PER_YEAR),
    probeTurns: intArg(args, '--probe-turns', 20),
    recallRounds: intArg(args, '--recall-rounds', 3),
    seed: intArg(args, '--seed', 20261116),
    dir: stringArg(args, '--dir'),
    onProgress: (line) => console.error(line),
  };
  const result = await measureDecade(options);
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('year  turns   events  dbMB   compile p50/p95 ms   recall p50/p95 ms   hits');
    for (const point of result.checkpoints) {
      console.log([
        String(point.year).padStart(4),
        String(point.turns).padStart(7),
        String(point.events).padStart(8),
        (point.dbBytes / 1024 / 1024).toFixed(1).padStart(6),
        `${point.compile.medianMs.toFixed(1)}/${point.compile.p95Ms.toFixed(1)}`.padStart(18),
        `${point.recall.p50Ms.toFixed(1)}/${point.recall.p95Ms.toFixed(1)}`.padStart(18),
        `${point.recall.hits}/${point.recall.queries}`.padStart(7),
      ].join(' '));
    }
    console.log(`db ${result.dbPath}`);
  }
}

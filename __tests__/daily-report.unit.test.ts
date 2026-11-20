import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDailyReport, renderDailyReport } from '../src/daily/DailyReport.js';
import { LATEST_SCHEMA_VERSION } from '../src/migrations/v3_7_4/FinalSchema.js';
import { makeTempDir } from './helpers/tmp.js';

const DATE = '2026-11-17';
const NOON = new Date(2026, 10, 17, 12).getTime();

function seed(dir: string): void {
  const db = new Database(join(dir, 'memory.sqlite'));
  db.exec(`
    CREATE TABLE memory_events (event_type TEXT, occurred_at INTEGER, project_id TEXT, payload_json TEXT);
    CREATE TABLE episode_dream_runs (run_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, candidate_ids_json TEXT NOT NULL, error TEXT);
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO _meta VALUES ('schema_version', '${LATEST_SCHEMA_VERSION}');
  `);
  const insertFeedback = db.prepare('INSERT INTO memory_events (event_type, occurred_at, project_id, payload_json) VALUES (?, ?, ?, ?)');
  insertFeedback.run('SURFACING_FEEDBACK_RECORDED', NOON, 'companion', JSON.stringify({ outcome: 'ignored' }));
  insertFeedback.run('SURFACING_FEEDBACK_RECORDED', NOON, 'companion', JSON.stringify({ outcome: 'engaged' }));
  db.prepare('INSERT INTO episode_dream_runs (run_id, created_at, status, candidate_ids_json, error) VALUES (?, ?, ?, ?, ?)')
    .run('dream-1', NOON, 'succeeded', JSON.stringify(['c1', 'c2']), null);
  db.close();

  writeFileSync(join(dir, 'install.json'), JSON.stringify({
    choices: { model: { provider: 'mg', model: 'model-a' } },
  }));
  const records = [
    { kind: 'emergence_decision', at: NOON, candidates: ['a', 'b'], withheld: [
      { steps: [{ rule: 'channel', outcome: 'withheld', detail: { policy: { proactive: false }, channel: 'proactive' } }] },
      { steps: [{ rule: 'channel', outcome: 'withheld', detail: { hardWithhold: true } }] },
      { steps: [{ rule: 'channel', outcome: 'withheld', detail: { expired: true } }] },
      { steps: [{ rule: 'channel', outcome: 'withheld', detail: {} }] },
      { steps: [{ rule: 'occasion', outcome: 'withheld', detail: { decision: 'withheld', reason: 'occasion_third_party' } }] },
      { steps: [{ rule: 'occasion', outcome: 'withheld', detail: { decision: 'withheld', reason: 'occasion_private_tier' } }] },
    ], excluded: [{ reason: 'no_due_instant' }] },
    { kind: 'emergence_consumed', at: NOON },
    { kind: 'emergence_consumed', at: NOON },
    { kind: 'emergence_accumulated', at: NOON },
    { kind: 'emergence_run', at: NOON, ok: true },
    { kind: 'emergence_run', at: NOON, ok: false },
    { kind: 'profile_corrected', at: NOON },
    { kind: 'procedure_corrected', at: NOON },
    { kind: 'procedure_correction_proposed', at: NOON },
    { kind: 'provider_usage', at: NOON, route: 'mg', model: 'model-a', input: 100, output: 20 },
    { kind: 'provider_usage', at: NOON, input: 50, output: 10 },
    { kind: 'dream_model_usage', at: NOON, inputTokens: 7, outputTokens: 3 },
    { kind: 'no_progress_stopped', at: NOON },
    { kind: 'cage_violation', at: NOON, violation: 'token_budget' },
    { kind: 'daily_budget_exceeded', at: NOON },
    { kind: 'provider_call_failed', at: NOON, next: 'fail' },
    { kind: 'provider_call_failed', at: NOON, next: 'retry' },
    { kind: 'plugin_log', at: NOON, plugin: 'session-context', level: 'error', message: 'context_lanes_failed', data: { message: 'lane exploded' } },
    { kind: 'memory_pressure', at: NOON, rssBytes: 200 * 1024 * 1024 },
    { kind: 'dream_model_degraded', at: NOON, reason: 'semantic_processor_unavailable' },
    { kind: 'dream_complete', at: NOON, eventCount: 3, localDate: DATE },
    { kind: 'before-window', at: NOON - 1 },
    { kind: 'after-window', at: NOON + 24 * 60 * 60 * 1000 },
  ];
  writeFileSync(join(dir, 'shell-events.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('daily report counts surfacing gates, feedback, corrections, tokens and the night Dream', () => {
  const dir = makeTempDir('cogmem-daily-');
  seed(dir);
  const report = buildDailyReport({ dataDir: dir, date: DATE, now: NOON });

  expect(report.surfacing).toMatchObject({
    decisions: 1,
    candidates: 2,
    withheld: 6,
    excluded: 1,
    attempted: 1,
    surfaced: 1,
    runFailed: 1,
    held: 1,
    ignored: 1,
    engaged: 1,
  });
  expect(report.surfacing.gates).toMatchObject({ F6: 3, F7: 1, F8: 1, F10: 1, shell: 1 });
  expect(report.surfacing.gates.byGate).toMatchObject({ policy: 1, keychain: 1, expired: 1, modulation: 1, occasion_third_party: 1, occasion_private_tier: 1, no_due_instant: 1 });
  expect(report.corrections).toEqual({ profile: 1, procedure: 1, applied: 2, proposed: 1 });
  expect(report.tokens).toMatchObject({ input: 150, output: 30, calls: 2, dreamInput: 7, dreamOutput: 3, dreamCalls: 1 });
  expect(report.tokens.buckets).toHaveLength(1);
  expect(report.tokens.buckets[0]).toMatchObject({ route: 'mg', model: 'model-a', input: 150, output: 30, calls: 2, legacy: true });
  expect(report.rss).toEqual({ bytes: 200 * 1024 * 1024, source: 'trace memory_pressure (max)' });
  expect(report.anomalies).toEqual({ noProgress: 1, budgetExhausted: 2, providerFailures: 1, providerRetries: 1, assemblyFailures: 1 });
  expect(report.dream).toMatchObject({ status: 'degraded', reason: 'semantic_processor_unavailable', candidates: 2, events: 3, runs: 1, localDate: DATE });

  const text = renderDailyReport(report);
  expect(text).toContain('# Cog 日报 — 2026-11-17');
  expect(text).toContain('F6 3 / F7 1 / F8 1 / F10 1 / shell 1');
  expect(text).toContain('RSS 峰值: 200.0 MiB');
  expect(text).toContain('装配失败 1');
  expect(text).toContain('降级 · 候选 2 · 事件 3');
  expect(text).toContain('零模型调用');
});

test('the daily CLI writes the report beside the data directory', async () => {
  const dir = makeTempDir('cogmem-daily-cli-');
  seed(dir);
  const entry = join(import.meta.dir, '..', 'src', 'bin', 'daily.ts');
  const proc = Bun.spawn({ cmd: ['bun', entry, '--data', dir, '--date', DATE], stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('# Cog 日报 — 2026-11-17');
  expect(stderr).toContain('daily: wrote');
  const out = join(dir, 'daily', `${DATE}.md`);
  expect(existsSync(out)).toBe(true);
  expect(readFileSync(out, 'utf8')).toContain('## 浮现与门控');
});

test('daily refuses a foreign or pre-4.0 ledger with the shared document', async () => {
  const dir = makeTempDir('cogmem-daily-refusal-');
  const foreign = join(dir, 'foreign.db');
  const old3x = join(dir, 'old3x.db');
  const create = (file: string, sql: string): void => {
    const db = new Database(file);
    db.exec(sql);
    db.close();
  };
  create(foreign, 'CREATE TABLE notes (id integer primary key, body text);');
  create(old3x, 'CREATE TABLE _schema_migrations (id integer primary key, version integer); INSERT INTO _schema_migrations VALUES (1, 31); CREATE TABLE _meta (key text primary key, value text); INSERT INTO _meta VALUES (\'schema_version\', \'31\');');

  const entry = join(import.meta.dir, '..', 'src', 'bin', 'daily.ts');
  for (const [file, reason] of [[foreign, 'unsupported_database_identity'], [old3x, 'no_upgrade_path']] as const) {
    const proc = Bun.spawn({ cmd: ['bun', entry, '--db', file, '--date', DATE, '--json'], stdout: 'pipe', stderr: 'pipe' });
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'refused', reason, command: 'daily' });
  }
});

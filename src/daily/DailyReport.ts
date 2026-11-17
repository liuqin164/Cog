/**
 * The daily self-use report (#297): what surfaced, what was gated, what it cost, and how the night's
 * Dream ended.
 *
 * It reads two existing records and writes nothing to either: `memory.sqlite` (the ledger, the
 * surfacing feedback rows and `episode_dream_runs`) and the shell trace (`shell-events.jsonl` plus
 * its `.1` rotation). It calls no model and imports no provider; a report is seconds of file and
 * SQLite reads.
 */
import Database from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readSurfacingObservability,
  SURFACING_OBSERVABILITY_GATES,
  type SurfacingObservabilityGate,
} from '../observability/SurfacingObservability.js';
import { assertSupportedDatabase } from '../migrations/v3_7_4/FinalSchema.js';

export const DAILY_TOKEN_LEGACY_NOTE = 'trace predates the route field; attributed to the installed route';

export interface DailyReportOptions {
  dataDir: string;
  dbPath?: string;
  tracePath?: string;
  date: string;
  projectId?: string;
  now?: number;
}

export interface DailyGates {
  F6: number;
  F7: number;
  F8: number;
  F10: number;
  shell: number;
  byGate: Record<SurfacingObservabilityGate, number>;
}

export interface DailyTokenBucket {
  route: string;
  model?: string;
  input: number;
  output: number;
  calls: number;
  legacy: boolean;
}

export interface DailyReport {
  date: string;
  generatedAt: number;
  dataDir: string;
  projectId?: string;
  window: { from: number; to: number; timeZone: string };
  surfacing: {
    decisions: number;
    candidates: number;
    withheld: number;
    excluded: number;
    attempted: number;
    surfaced: number;
    runFailed: number;
    held: number;
    ignored: number;
    engaged: number;
    stopped: number;
    gates: DailyGates;
  };
  corrections: { profile: number; procedure: number; applied: number; proposed: number };
  tokens: { input: number; output: number; calls: number; buckets: DailyTokenBucket[]; dreamInput: number; dreamOutput: number; dreamCalls: number };
  rss: { bytes?: number; source: string; pid?: number };
  anomalies: { noProgress: number; budgetExhausted: number; providerFailures: number; providerRetries: number };
  dream: { status: 'success' | 'degraded' | 'failed' | 'none'; reason?: string; candidates: number; events: number; runs: number; at?: number; localDate?: string };
  sources: { ledger: string; trace: string; traceReadable: boolean; feedbackReadable: boolean };
}

interface TraceEntry {
  at?: unknown;
  kind?: unknown;
  [key: string]: unknown;
}

interface DreamRow {
  created_at: number;
  status: string;
  candidate_ids_json: string;
  error?: string | null;
}

export function localDateString(at = Date.now()): string {
  return new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

function parseDay(date: string): { from: number; to: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const from = new Date(year, month - 1, day);
  if (from.getFullYear() !== year || from.getMonth() !== month - 1 || from.getDate() !== day) {
    throw new Error(`--date names a day that does not exist: "${date}"`);
  }
  const to = new Date(year, month - 1, day + 1);
  return { from: from.getTime(), to: to.getTime() };
}

function readGates(gates: Array<{ gate: SurfacingObservabilityGate; count: number }>): DailyGates {
  const byGate = Object.fromEntries(SURFACING_OBSERVABILITY_GATES.map((gate) => [gate, 0])) as Record<SurfacingObservabilityGate, number>;
  for (const entry of gates) byGate[entry.gate] = entry.count;
  return {
    byGate,
    F6: byGate.policy + byGate.keychain + byGate.expired,
    F7: byGate.modulation,
    F8: byGate.occasion_third_party,
    F10: byGate.occasion_private_tier,
    shell: byGate.no_due_instant,
  };
}

function readTrace(tracePath: string, from: number, to: number): { records: TraceEntry[]; readable: boolean } {
  let readable = false;
  const records: TraceEntry[] = [];
  // The shell rotates one generation to `.1`; a day can span both files.
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
        // The trace is damage-tolerant; one torn line must not hide the rest.
        continue;
      }
      if (typeof entry.at !== 'number' || entry.at < from || entry.at >= to) continue;
      records.push(entry);
    }
  }
  return { records, readable };
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readInstalledRoute(dataDir: string): { route?: string; model?: string } {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'install.json'), 'utf8')) as { choices?: { model?: { provider?: unknown; model?: unknown } } };
    const model = parsed.choices?.model;
    return {
      route: typeof model?.provider === 'string' ? model.provider : undefined,
      model: typeof model?.model === 'string' ? model.model : undefined,
    };
  } catch {
    return {};
  }
}

function readTokens(records: TraceEntry[], fallback: { route?: string; model?: string }): DailyReport['tokens'] {
  const buckets = new Map<string, DailyTokenBucket>();
  for (const entry of records) {
    if (entry.kind !== 'provider_usage') continue;
    const explicitRoute = typeof entry.route === 'string' ? entry.route : undefined;
    const route = explicitRoute ?? fallback.route ?? 'unrecorded';
    const model = (typeof entry.model === 'string' ? entry.model : undefined) ?? fallback.model;
    const key = `${route}\u0000${model ?? ''}`;
    const bucket = buckets.get(key) ?? { route, model, input: 0, output: 0, calls: 0, legacy: !explicitRoute };
    bucket.legacy = bucket.legacy || !explicitRoute;
    bucket.input += number(entry.input);
    bucket.output += number(entry.output);
    bucket.calls += 1;
    buckets.set(key, bucket);
  }
  const result: DailyReport['tokens'] = {
    input: 0, output: 0, calls: 0,
    buckets: [...buckets.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
    dreamInput: 0, dreamOutput: 0, dreamCalls: 0,
  };
  for (const bucket of result.buckets) {
    result.input += bucket.input;
    result.output += bucket.output;
    result.calls += bucket.calls;
  }
  for (const entry of records) {
    if (entry.kind !== 'dream_model_usage') continue;
    result.dreamInput += number(entry.inputTokens);
    result.dreamOutput += number(entry.outputTokens);
    result.dreamCalls += 1;
  }
  return result;
}

function readRss(
  dataDir: string,
  records: TraceEntry[],
  window: { from: number; to: number },
  now: number,
): DailyReport['rss'] {
  const pressure = Math.max(0, ...records.filter((entry) => entry.kind === 'memory_pressure').map((entry) => number(entry.rssBytes)));
  if (now < window.from || now >= window.to) {
    return pressure > 0
      ? { bytes: pressure, source: 'trace memory_pressure (max)' }
      : { source: 'no live process and no memory_pressure record for this day' };
  }
  let pid: number | undefined;
  try {
    const lock = JSON.parse(readFileSync(join(dataDir, 'runtime.lock'), 'utf8')) as { pid?: unknown };
    if (typeof lock.pid === 'number' && Number.isInteger(lock.pid) && lock.pid > 0) pid = lock.pid;
  } catch {
    // No lock: the resident is not running from this data directory.
  }
  if (pid && isCompanionProcess(pid)) {
    const cgroup = readCgroupPath(pid);
    if (cgroup) {
      const peak = readNumberFile(`/sys/fs/cgroup${cgroup}/memory.peak`);
      if (peak > 0) return { bytes: peak, source: 'cgroup v2 memory.peak', pid };
      const current = readNumberFile(`/sys/fs/cgroup${cgroup}/memory.current`);
      if (current > 0) return { bytes: current, source: 'cgroup v2 memory.current', pid };
    }
    const vmRss = readVmRss(pid);
    if (vmRss > 0) return { bytes: vmRss, source: '/proc/<pid>/status VmRSS', pid };
  }
  return pressure > 0
    ? { bytes: pressure, source: 'trace memory_pressure (max)' }
    : { source: 'no live process and no memory_pressure record for this day' };
}

function isCompanionProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\u0000', ' ');
    return /cogmem|companion|shell\/src\/cli\.ts/i.test(cmdline);
  } catch {
    return false;
  }
}

function readCgroupPath(pid: number): string | undefined {
  try {
    for (const line of readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')) {
      const match = /^0::(\/.*)$/.exec(line);
      if (match) return match[1];
    }
  } catch {
    // Not cgroup v2, or not Linux.
  }
  return undefined;
}

function readNumberFile(path: string): number {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function readVmRss(pid: number): number {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function readDream(db: Database, records: TraceEntry[], from: number, to: number): DailyReport['dream'] {
  let rows: DreamRow[] = [];
  try {
    rows = db.query(`SELECT created_at, status, candidate_ids_json, error FROM episode_dream_runs WHERE created_at >= ? AND created_at < ? ORDER BY created_at`).all(from, to) as DreamRow[];
    if (rows.length === 0) {
      rows = db.query(`SELECT created_at, status, candidate_ids_json, error FROM episode_dream_runs WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`).all(to - 36 * 60 * 60 * 1000, to) as DreamRow[];
    }
  } catch {
    // An older ledger without the episode Dream tables simply has no Dream line.
  }
  const failedTrace = records.some((entry) => entry.kind === 'dream_failed' || entry.kind === 'dream_kernel_night_failed');
  const degraded = records.find((entry) => entry.kind === 'dream_model_degraded');
  const completed = records.find((entry) => entry.kind === 'dream_complete');
  const candidates = rows.reduce((sum, row) => {
    try {
      const ids = JSON.parse(row.candidate_ids_json) as unknown;
      return sum + (Array.isArray(ids) ? ids.length : 0);
    } catch {
      return sum;
    }
  }, 0);
  const events = records
    .filter((entry) => entry.kind === 'dream_complete')
    .reduce((sum, entry) => sum + number(entry.eventCount), 0);
  const failed = failedTrace || rows.some((row) => row.status === 'failed');
  const partial = rows.some((row) => row.status === 'partial');
  const status: DailyReport['dream']['status'] = failed
    ? 'failed'
    : degraded || partial
      ? 'degraded'
      : rows.length > 0 || completed
        ? 'success'
        : 'none';
  const latest = rows.at(-1);
  const reason = typeof degraded?.reason === 'string'
    ? degraded.reason
    : latest?.error
      ?? (partial ? 'partial: some episodes failed' : undefined);
  return {
    status,
    reason,
    candidates,
    events,
    runs: rows.length,
    at: latest?.created_at ?? (typeof completed?.at === 'number' ? completed.at : undefined),
    localDate: typeof completed?.localDate === 'string' ? completed.localDate : latest ? localDateString(latest.created_at) : undefined,
  };
}

export function buildDailyReport(options: DailyReportOptions): DailyReport {
  const dbPath = options.dbPath ?? join(options.dataDir, 'memory.sqlite');
  const tracePath = options.tracePath ?? join(options.dataDir, 'shell-events.jsonl');
  if (!existsSync(dbPath)) throw new Error(`no ledger at ${dbPath}`);
  const window = parseDay(options.date);
  const { records, readable } = readTrace(tracePath, window.from, window.to);
  const db = new Database(dbPath, { readonly: true });
  try {
    // The report reads raw tables, so a foreign or pre-4.0 file would otherwise
    // produce a convincing all-zero report instead of the shared refusal.
    assertSupportedDatabase(db);
    const surfacing = readSurfacingObservability(db, {
      now: window.to,
      windowMs: window.to - window.from,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      tracePath,
    });
    const corrections = {
      profile: records.filter((entry) => entry.kind === 'profile_corrected').length,
      procedure: records.filter((entry) => entry.kind === 'procedure_corrected').length,
      proposed: records.filter((entry) => entry.kind === 'procedure_correction_proposed').length,
      applied: records.filter((entry) => entry.kind === 'profile_corrected' || entry.kind === 'procedure_corrected').length,
    };
    const anomalies = {
      noProgress: records.filter((entry) => entry.kind === 'no_progress_stopped').length,
      budgetExhausted: records.filter((entry) => entry.kind === 'cage_violation' && entry.violation === 'token_budget').length
        + records.filter((entry) => entry.kind === 'daily_budget_exceeded').length,
      providerFailures: records.filter((entry) => entry.kind === 'provider_call_failed' && entry.next === 'fail').length,
      providerRetries: records.filter((entry) => entry.kind === 'provider_call_failed' && entry.next === 'retry').length,
    };
    return {
      date: options.date,
      generatedAt: options.now ?? Date.now(),
      dataDir: options.dataDir,
      projectId: options.projectId,
      window: { ...window, timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone },
      surfacing: {
        decisions: surfacing.counts.decisions,
        candidates: surfacing.counts.candidates,
        withheld: surfacing.counts.withheld,
        excluded: surfacing.counts.excluded,
        attempted: surfacing.counts.attempted,
        surfaced: surfacing.counts.surfaced,
        runFailed: surfacing.counts.runFailed,
        held: surfacing.counts.held,
        ignored: surfacing.counts.ignored,
        engaged: surfacing.counts.engaged,
        stopped: surfacing.counts.stopped,
        gates: readGates(surfacing.gates),
      },
      corrections,
      tokens: readTokens(records, readInstalledRoute(options.dataDir)),
      rss: readRss(options.dataDir, records, window, options.now ?? Date.now()),
      anomalies,
      dream: readDream(db, records, window.from, window.to),
      sources: {
        ledger: dbPath,
        trace: tracePath,
        traceReadable: readable,
        feedbackReadable: surfacing.sources.feedback.readable,
      },
    };
  } finally {
    db.close();
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function stamp(ms: number): string {
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(ms));
}

export function renderDailyReport(report: DailyReport): string {
  const gates = report.surfacing.gates;
  const gateTotal = gates.F6 + gates.F7 + gates.F8 + gates.F10 + gates.shell;
  const blocked = report.surfacing.withheld + report.surfacing.excluded;
  const legacyCalls = report.tokens.buckets.reduce((sum, bucket) => sum + (bucket.legacy ? bucket.calls : 0), 0);
  const lines: string[] = [
    `# Cog 日报 — ${report.date}`,
    '',
    `- 数据目录: ${report.dataDir}`,
    `- 窗口: ${stamp(report.window.from)} → ${stamp(report.window.to)} (${report.window.timeZone})`,
    `- 项目: ${report.projectId ?? '全部（数据目录内）'}`,
    '',
    '## 浮现与门控',
    `- 决策 ${report.surfacing.decisions} 次 · 候选 ${report.surfacing.candidates} · withheld ${report.surfacing.withheld} · excluded ${report.surfacing.excluded} · 尝试 ${report.surfacing.attempted} · 实际展示 ${report.surfacing.surfaced} · run_failed ${report.surfacing.runFailed} · held ${report.surfacing.held}`,
    `- 被门控挡下 ${blocked}（门控记录 ${gateTotal} 次；同一候选可被多道闸门挡下）：F6 ${gates.F6} / F7 ${gates.F7} / F8 ${gates.F8} / F10 ${gates.F10} / shell ${gates.shell}`,
    `  - F6 渠道策略: policy ${gates.byGate.policy} · keychain ${gates.byGate.keychain} · expired ${gates.byGate.expired}`,
    `  - F7 调制: modulation ${gates.byGate.modulation}`,
    `  - F8 场合: occasion_third_party ${gates.byGate.occasion_third_party}`,
    `  - F10 生活层级: occasion_private_tier ${gates.byGate.occasion_private_tier}`,
    `  - shell 到期过滤: no_due_instant ${gates.byGate.no_due_instant}`,
    `- 用户反应: 冷落 (ignore) ${report.surfacing.ignored} · 参与 ${report.surfacing.engaged} · 叫停 ${report.surfacing.stopped}`,
    '',
    '## 手动纠正',
    `- /correct: ${report.corrections.applied}（画像 ${report.corrections.profile} · 做法 ${report.corrections.procedure}；未确认提议 ${report.corrections.proposed}）`,
    '',
    '## 模型用量',
    `- 合计: ${report.tokens.input} input / ${report.tokens.output} output（${report.tokens.calls} 次调用）`,
  ];
  if (report.tokens.buckets.length === 0) {
    lines.push('  - 无 provider_usage 记录');
  } else {
    for (const bucket of report.tokens.buckets) {
      const label = bucket.model ? `${bucket.route} · ${bucket.model}` : bucket.route;
      lines.push(`  - ${label}: ${bucket.input} input / ${bucket.output} output（${bucket.calls} 次）`);
    }
  }
  if (legacyCalls > 0) lines.push(`  - ${legacyCalls} 次调用（${DAILY_TOKEN_LEGACY_NOTE}）`);
  lines.push(
    `- dream: ${report.tokens.dreamInput} input / ${report.tokens.dreamOutput} output（${report.tokens.dreamCalls} 次）`,
    '',
    '## 资源与异常',
    `- RSS 峰值: ${report.rss.bytes === undefined ? 'n/a' : formatBytes(report.rss.bytes)}（${report.rss.source}${report.rss.pid ? `，pid ${report.rss.pid}` : ''}）`,
    `- 异常: 无进展被停 ${report.anomalies.noProgress} · 预算耗尽 ${report.anomalies.budgetExhausted} · provider 失败 ${report.anomalies.providerFailures}（重试 ${report.anomalies.providerRetries}）`,
    '',
    '## 昨夜 dream',
  );
  const dream = report.dream;
  const statusLabel = { success: '成功', degraded: '降级', failed: '失败', none: '未运行' }[dream.status];
  const reason = dream.reason ? `，原因 ${dream.reason}` : '';
  const when = dream.at ? `（${stamp(dream.at)}${dream.localDate ? ` · ${dream.localDate}` : ''}）` : '';
  lines.push(`- ${statusLabel} · 候选 ${dream.candidates} · 事件 ${dream.events} · ${dream.runs} 次运行${reason}${when}`);
  lines.push(
    '',
    '## 数据来源',
    `- 账本: ${report.sources.ledger}（memory_events / episode_dream_runs / surfacing feedback）${report.sources.feedbackReadable ? '' : '（反馈表不可读）'}`,
    `- 追踪: ${report.sources.trace}（+.1）${report.sources.traceReadable ? '' : '（不可读）'}`,
    '- 零模型调用：本报告只读账本与追踪，未导入或调用任何模型 provider。',
  );
  return lines.join('\n');
}

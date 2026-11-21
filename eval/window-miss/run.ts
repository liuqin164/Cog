#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createMemoryKernel, ModelRegistry } from '../../src/public.ts';
import type { MemoryEventRole } from '../../src/types/index.ts';
import {
  buildProbes,
  type Expectation,
  type Probe,
  type ProbeWindow,
  type Verdict,
} from './corpus.ts';

const DAY = 86_400_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:3425/v1';
const DEFAULT_MODEL = 'auto/deepseek-v4.1-flash';

interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface CandidateRecord {
  candidateId: string;
  candidateType: string;
  status: string;
  confidence: number;
  content: unknown;
  evidence: unknown;
}

interface FinalRow {
  kind: 'belief' | 'fact' | 'summary';
  text: string;
  status: string;
}

interface ArmResult {
  candidates: CandidateRecord[];
  rows: FinalRow[];
  usage: Usage;
  windowByEvent: Map<string, string>;
}

interface ExpectationResult {
  probeId: string;
  probeTitle: string;
  source: 'scorecard' | 'ledger';
  kind: 'duplicate' | 'conflict' | 'procedure';
  expectationId: string;
  label: string;
  windows: number;
  narrowCandidates: number;
  narrowRows: number;
  narrowPriorRefs: number;
  wideCandidates: number;
  wideRows: number;
  widePriorRefs: number;
  narrowCount: number;
  wideCount: number;
  narrowHit: boolean;
  wideHit: boolean;
  verdict: Verdict;
  visibleInOneWindow: boolean;
}

interface EvalResult {
  generatedAt: string;
  head: string;
  model: string;
  baseUrl: string;
  ledger: string;
  threshold: string;
  results: ExpectationResult[];
  totals: Record<'duplicate' | 'conflict' | 'procedure' | 'all', {
    expected: number;
    handled: number;
    windowMiss: number;
    modelMiss: number;
  }>;
  conclusion: 'A' | 'B';
  usage: Usage;
}

const repo = resolve(import.meta.dir, '../..');
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const baseUrl = (process.env.MG_BASE_URL ?? argument('base-url') ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
const model = argument('model') ?? process.env.MG_MODEL ?? DEFAULT_MODEL;
const apiKey = process.env.MG_API_KEY ?? 'magpie';
const ledger = resolve(process.env.WINDOW_MISS_LEDGER ?? `${process.env.HOME}/.cogmem/companion-archive-20261116/memory.sqlite`);
const reportOnly = process.argv.includes('--report-only');
const keep = process.argv.includes('--keep');
const only = argument('only');
const workRoot = join(repo, '.cogmem', 'window-miss');
mkdirSync(workRoot, { recursive: true });
const runRoot = mkdtempSync(join(workRoot, 'run-'));
process.env.TMPDIR = runRoot;
const dbPath = join(runRoot, 'memory.db');

const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
const config = ModelRegistry.defaultConfig();
config.memory = {
  ...config.memory,
  provider: 'openai_compatible',
  baseUrl,
  apiKey,
  modelName: model,
  timeoutMs: 300_000,
};
const registry = new ModelRegistry(config, {
  beforeGenerate: () => { usage.calls += 1; },
  onUsage: (_role, item) => {
    usage.inputTokens += item.inputTokens ?? 0;
    usage.outputTokens += item.outputTokens ?? 0;
  },
});

if (reportOnly) {
  const path = join(outDir, 'results.json');
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const result = JSON.parse(readFileSync(path, 'utf8')) as EvalResult;
  result.results = result.results.map((item) => ({
    ...item,
    verdict: decideVerdict(item.kind, item.narrowHit, item.wideHit, item.visibleInOneWindow),
  }));
  result.totals = aggregate(result.results);
  result.conclusion = result.totals.all.windowMiss >= 2 && result.totals.all.windowMiss / result.totals.all.expected >= 0.2 ? 'B' : 'A';
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, 'results.md'), renderMarkdown(result));
  process.exit(0);
}

if (!existsSync(ledger)) throw new Error(`missing ledger: ${ledger}`);
const probes = buildProbes(ledger).filter((probe) => !only || probe.id.includes(only));
if (probes.length === 0) throw new Error(`no probes match --only ${only}`);

const kernel = createMemoryKernel({ dbPath, modelRegistry: registry, projectTimeZone: 'Asia/Tokyo' });
const results: ExpectationResult[] = [];
for (const probe of probes) {
  const windowArm = await runArm(probe, 'window');
  const wideArm = await runArm(probe, 'wide');
  results.push(compare(probe, windowArm, wideArm));
  console.log(`${probe.id}: ${results.at(-1)!.verdict} (window ${results.at(-1)!.narrowCount}, wide ${results.at(-1)!.wideCount})`);
}

const totals = aggregate(results);
const conclusion = totals.all.windowMiss >= 2 && totals.all.windowMiss / totals.all.expected >= 0.2 ? 'B' : 'A';
const result: EvalResult = {
  generatedAt: new Date().toISOString(),
  head: gitHead(),
  model,
  baseUrl,
  ledger,
  threshold: 'B when window-caused misses >= 2 and >= 20% of evaluated items',
  results,
  totals,
  conclusion,
  usage,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(join(outDir, 'results.md'), renderMarkdown(result));
kernel.close();
if (!keep) rmSync(runRoot, { recursive: true, force: true });

console.log(`conclusion ${conclusion}: window misses ${totals.all.windowMiss}/${totals.all.expected}, model misses ${totals.all.modelMiss}/${totals.all.expected}`);
console.log(`usage ${usage.calls} calls, ${usage.inputTokens + usage.outputTokens} tokens`);

async function runArm(probe: Probe, arm: 'window' | 'wide'): Promise<ArmResult> {
  const projectId = `window-miss-${probe.id}-${arm}`.replace(/[^a-z0-9_-]/giu, '-').slice(0, 120);
  const before = snapshotUsage();
  const windowIds = new Map<string, string[]>();
  const eventWindows = new Map<string, string>();
  for (const window of probe.windows) {
    const ids: string[] = [];
    for (const event of ordered(window)) {
      const recorded = kernel.recordRawEvent({
        projectId,
        threadId: `${probe.id}-${window.id}`,
        sessionId: `${probe.id}-${window.id}`,
        role: event.role as MemoryEventRole,
        content: event.text,
        occurredAt: event.occurredAt,
        localDate: event.localDate,
      });
      ids.push(recorded.eventId);
      eventWindows.set(recorded.eventId, window.id);
    }
    windowIds.set(window.id, ids);
    if (arm === 'window') await curate(projectId, ids);
  }
  if (arm === 'wide') {
    await curate(projectId, [...windowIds.values()].flat());
  }
  kernel.promoteDreamCandidates({ projectId, limit: 2_000 });
  const candidates = kernel.listDreamCandidates({ projectId, limit: 2_000 }) as CandidateRecord[];
  const rows = finalRows(dbPath, projectId);
  return { candidates, rows, usage: deltaUsage(usage, before), windowByEvent: eventWindows };
}

async function curate(projectId: string, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const now = Date.now();
  await kernel.runDreamCurator({
    projectId,
    eventIds,
    mode: 'candidate',
    dreamMode: 'normal',
    limit: eventIds.length,
    maxCandidates: 500,
    now,
  });
}

function compare(probe: Probe, windowArm: ArmResult, wideArm: ArmResult): ExpectationResult {
  const expectation = probe.expectation;
  const narrowCandidates = matchingCandidates(windowArm.candidates, expectation, windowArm.windowByEvent);
  const wideCandidates = matchingCandidates(wideArm.candidates, expectation, wideArm.windowByEvent);
  const narrowRows = matchingRows(windowArm.rows, expectation);
  const wideRows = matchingRows(wideArm.rows, expectation);
  const narrowPriorRefs = priorRefs(narrowCandidates);
  const widePriorRefs = priorRefs(wideCandidates);
  const narrowCount = expectation.mode === 'dedupe'
    ? (narrowRows.length > 0 ? narrowRows.length : narrowCandidates.length)
    : narrowCandidates.length + narrowRows.length;
  const wideCount = expectation.mode === 'dedupe'
    ? (wideRows.length > 0 ? wideRows.length : wideCandidates.length)
    : wideCandidates.length + wideRows.length;
  const narrowHit = expectation.mode === 'dedupe'
    ? narrowCount === 1
    : narrowCount > 0;
  const wideHit = expectation.mode === 'dedupe'
    ? wideCount === 1
    : wideCount > 0;
  const visibleInOneWindow = probe.windows.some((window) => windowMatches(window, expectation));
  const verdict = decideVerdict(probe.kind, narrowHit, wideHit, visibleInOneWindow);
  return {
    probeId: probe.id,
    probeTitle: probe.title,
    source: probe.source,
    kind: probe.kind,
    expectationId: expectation.id,
    label: expectation.label,
    windows: probe.windows.length,
    narrowCandidates: narrowCandidates.length,
    narrowRows: narrowRows.length,
    narrowPriorRefs,
    wideCandidates: wideCandidates.length,
    wideRows: wideRows.length,
    widePriorRefs,
    narrowCount,
    wideCount,
    narrowHit,
    wideHit,
    verdict,
    visibleInOneWindow,
  };
}

function decideVerdict(kind: Probe['kind'], narrowHit: boolean, wideHit: boolean, visibleInOneWindow: boolean): Verdict {
  if (narrowHit) return 'handled';
  if (kind !== 'duplicate' && visibleInOneWindow) return 'model_miss';
  if (wideHit) return 'window_miss';
  return 'model_miss';
}

function matchingCandidates(candidates: CandidateRecord[], expectation: Expectation, windowByEvent: Map<string, string>): CandidateRecord[] {
  return candidates.filter((candidate) => {
    if (expectation.candidateTypes.length > 0 && !expectation.candidateTypes.includes(candidate.candidateType)) return false;
    if (!textMatches(JSON.stringify(candidate.content), expectation.termGroups)) return false;
    if (expectation.minEvidenceWindows) {
      const ids = evidenceIds(candidate);
      const windows = new Set(ids.map((id) => windowByEvent.get(id)).filter(Boolean));
      const covered = windows.size + (priorRefCount(candidate) > 0 ? 1 : 0);
      if (covered < expectation.minEvidenceWindows) return false;
    }
    return true;
  });
}

function matchingRows(rows: FinalRow[], expectation: Expectation): FinalRow[] {
  return rows.filter((row) => {
    if (expectation.mode === 'dedupe' && row.kind === 'summary') return false;
    return textMatches(row.text, expectation.termGroups);
  });
}

function windowMatches(window: ProbeWindow, expectation: Expectation): boolean {
  const text = window.events.map((event) => event.text).join('\n');
  return textMatches(text, expectation.termGroups);
}

function textMatches(text: string, groups: string[][]): boolean {
  const lowered = text.toLowerCase();
  return groups.every((group) => group.some((term) => lowered.includes(term.toLowerCase())));
}

function evidenceIds(candidate: CandidateRecord): string[] {
  if (!Array.isArray(candidate.evidence)) return [];
  return candidate.evidence
    .map((item) => item && typeof item === 'object' ? (item as { eventId?: unknown }).eventId : undefined)
    .filter((id): id is string => typeof id === 'string');
}

function priorRefCount(candidate: CandidateRecord): number {
  const content = candidate.content && typeof candidate.content === 'object'
    ? candidate.content as { priorContextRefs?: unknown }
    : {};
  return Array.isArray(content.priorContextRefs) ? content.priorContextRefs.length : 0;
}

function priorRefs(candidates: CandidateRecord[]): number {
  return candidates.reduce((sum, candidate) => sum + priorRefCount(candidate), 0);
}

function finalRows(path: string, projectId: string): FinalRow[] {
  const db = new Database(path, { readonly: true });
  try {
    const beliefs = db.query(`
      SELECT 'belief' AS kind,
             TRIM(COALESCE(subject,'') || ' ' || COALESCE(predicate,'') || ' ' || COALESCE(object_value,'') || ' ' || COALESCE(explanation,'')) AS text,
             status
      FROM beliefs
      WHERE project_id = ? AND status = 'active'
    `).all(projectId) as FinalRow[];
    const facts = db.query(`
      SELECT 'fact' AS kind,
             TRIM(COALESCE(f.subject,'') || ' ' || COALESCE(f.predicate_family,'') || ' ' || COALESCE(f.object_value,'') || ' ' || COALESCE(f.source_text,'')) AS text,
             f.status
      FROM facts f
      JOIN memory_events e ON e.event_id = f.neuron_id
      WHERE e.project_id = ? AND f.status IN ('provisional','verified')
    `).all(projectId) as FinalRow[];
    const summaries = db.query(`
      SELECT 'summary' AS kind, text, status
      FROM deep_write_summaries
      WHERE project_id = ? AND status IN ('provisional','verified')
    `).all(projectId) as FinalRow[];
    return [...beliefs, ...facts, ...summaries];
  } finally {
    db.close();
  }
}

function ordered(window: ProbeWindow): ProbeWindow['events'] {
  return [...window.events].sort((left, right) => left.occurredAt - right.occurredAt);
}

function aggregate(results: ExpectationResult[]): EvalResult['totals'] {
  const empty = () => ({ expected: 0, handled: 0, windowMiss: 0, modelMiss: 0 });
  const totals: EvalResult['totals'] = {
    duplicate: empty(),
    conflict: empty(),
    procedure: empty(),
    all: empty(),
  };
  for (const result of results) {
    for (const key of [result.kind, 'all'] as const) {
      totals[key].expected += 1;
      if (result.verdict === 'handled') totals[key].handled += 1;
      if (result.verdict === 'window_miss') totals[key].windowMiss += 1;
      if (result.verdict === 'model_miss') totals[key].modelMiss += 1;
    }
  }
  return totals;
}

function renderMarkdown(result: EvalResult): string {
  const lines: string[] = [
    '# Compile-window miss evaluation — #381',
    '',
    `- head: \`${result.head}\``,
    `- model: \`${result.model}\` at \`${result.baseUrl}\``,
    `- ledger: \`${result.ledger}\``,
    `- generated: ${result.generatedAt}`,
    `- decision rule: ${result.threshold}`,
    '',
    '## Attribution',
    '',
    '| probe | kind | window | narrow candidates | narrow rows | narrow prior refs | wide candidates | wide rows | wide prior refs | narrow count | wide count | verdict | visible in one window |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const item of result.results) {
    lines.push(`| ${item.probeId} | ${item.kind} | ${item.windows} | ${item.narrowCandidates} | ${item.narrowRows} | ${item.narrowPriorRefs} | ${item.wideCandidates} | ${item.wideRows} | ${item.widePriorRefs} | ${item.narrowCount} | ${item.wideCount} | ${item.verdict} | ${item.visibleInOneWindow ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Counts', '', '| kind | expected | handled | window miss | model miss |', '| --- | ---: | ---: | ---: | ---: |');
  for (const key of ['duplicate', 'conflict', 'procedure', 'all'] as const) {
    const value = result.totals[key];
    lines.push(`| ${key} | ${value.expected} | ${value.handled} | ${value.windowMiss} | ${value.modelMiss} |`);
  }
  lines.push(
    '',
    `Window-caused misses: **${result.totals.all.windowMiss}/${result.totals.all.expected}** (${percent(result.totals.all.windowMiss, result.totals.all.expected)}). Model misses with all material visible: **${result.totals.all.modelMiss}/${result.totals.all.expected}** (${percent(result.totals.all.modelMiss, result.totals.all.expected)}).`,
    '',
    '`narrow count` is the number of matching durable rows when governance produced any, otherwise matching candidates. For duplicates that is the number of surviving copies; more than one is a miss. For conflicts and procedures it is a hit count. `visible in one window` means every gold term group already occurs in a single window, so a model miss there is not a window miss.',
    '',
    '## Cost',
    '',
    `- calls: ${result.usage.calls}`,
    `- input tokens: ${result.usage.inputTokens}`,
    `- output tokens: ${result.usage.outputTokens}`,
    '',
    '## Conclusion',
    '',
  );
  if (result.conclusion === 'B') {
    lines.push(
      '**Conclusion B — window misses are significant.** The current fixed window loses cross-window conflict/supersession and duplicate copies; the wide arm detects them with the same model, prompt and governance. The one procedure probe is a model miss, not a window miss, and is reported separately.',
      '',
      '### Proposed implementation ticket (5.0, not implemented here)',
      '',
      '**Title:** Bounded read-only prior-context lookup for nightly curation',
      '',
      '**Scope:** at dream curation time only, resolve the entity/topic keys a candidate names (canonical claim key, entity, topic path) and fetch a bounded, deterministic prior slice from the project ledger and sealed frames. No tool loop, no free-form search, no writes, no new table. The slice is read-only context, not evidence: candidate evidence IDs must still come from the current window.',
      '',
      '**Interface:** an internal `readPriorContext({ projectId, keys, asOf, budget })` returning prior events/frames with `sourceRefs`, ordered oldest-to-newest after selection. `DreamCuratorWorker.run` accepts an optional injected provider and renders the slice as a marked `<COGMEM_PRIOR_CONTEXT>` block. Default budget: at most 8 prior frames or 20 events and 4,000 prompt tokens per episode; zero extra model calls.',
      '',
      '**Acceptance:** re-run `bun eval/window-miss/run.ts`; conflict window-caused misses fall from the measured count to 0; duplicate handling does not regress; procedure probes are reported separately. Prompt-token growth stays inside the cap, `bun run typecheck`, `bun test __tests__` and `leak:check` pass. Read-only means no new tables, migrations, or background processes.',
      '',
    );
  } else {
    lines.push(
      '**Conclusion A — window misses are negligible.** Measured window-caused misses stay under the decision rule. Recommend closing #381, keeping the current fixed window, and recording this result in #165.',
      '',
    );
  }
  lines.push(
    '## Limits',
    '',
    '- The window arm sends each episode to the real `runDreamCurator` candidate path; frames are not regenerated by this eval. The wide arm sends the same events in one curator call.',
    '- The scorecard probes are copied from `eval/dream-scorecard/`; the ledger probes replay the archived companion ledger at `~/.cogmem/companion-archive-20261116/memory.sqlite` read-only. No production process or live data directory is opened.',
    '- One sample per cell on one model snapshot. The model is stochastic; a one-item delta is not a trend.',
    '- The ledger is one companion session with five episodes; it is a mechanism check, not a population estimate.',
    '',
  );
  return lines.join('\n');
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function snapshotUsage(): Usage {
  return { ...usage };
}

function deltaUsage(total: Usage, before: Usage): Usage {
  return {
    calls: total.calls - before.calls,
    inputTokens: total.inputTokens - before.inputTokens,
    outputTokens: total.outputTokens - before.outputTokens,
  };
}

function percent(numerator: number, denominator: number): string {
  return denominator === 0 ? '0.0%' : `${(numerator / denominator * 100).toFixed(1)}%`;
}

function gitHead(): string {
  try {
    return Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repo }).stdout.toString().trim();
  } catch {
    return 'unknown';
  }
}

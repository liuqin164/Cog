#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createMemoryKernel, KernelAgentMemoryBackend, ModelRegistry } from '../../src/public.ts';
import {
  CLASSIFICATION_CORPUS,
  COMPILE_SCENARIOS,
  SCORED_ROLES,
  type ClassificationItem,
  type CompileScenario,
  type DreamRole,
} from './corpus.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 10, 2, 0, 0);
const DEFAULT_BASE_URL = 'http://127.0.0.1:3425/v1';
const DEFAULT_MODEL = 'auto/deepseek-v4.1-flash';

interface CandidateRecord {
  candidateType: string;
  status: string;
  confidence: number;
  content: unknown;
  evidence: unknown;
}

interface CalibrationSample {
  confidence: number;
  deterministic: boolean;
  promoted: boolean;
}

interface CalibrationBucket {
  bucket: string;
  candidates: number;
  promoted: number;
  survival: number | null;
}

interface CalibrationResult {
  model: CalibrationBucket[];
  deterministic: CalibrationBucket;
  modelCandidates: number;
  modelPromoted: number;
  deterministicCandidates: number;
  deterministicPromoted: number;
}

interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface ClassificationItemResult {
  id: string;
  role: DreamRole;
  predicted: DreamRole;
  source: string;
  correct: boolean;
  pair?: string;
  group?: string;
  candidates: string[];
  correctionDetected: boolean;
}

interface ClassMetric {
  role: DreamRole;
  precision: number | null;
  recall: number | null;
  support: number;
}

interface CompileScenarioResult {
  id: string;
  title: string;
  episodes: number;
  processed: number;
  failed: number;
  framesPassed: number;
  processorErrors: number;
  deterministicFallbackFrames: number;
  fallbackNeedEpisodes: number;
  goldHits: number;
  goldTotal: number;
  gold: Array<{ id: string; label: string; hit: boolean }>;
  candidates: number;
  queue: {
    candidate: number;
    needsConfirmation: number;
    promoted: number;
    rejected: number;
    superseded: number;
    shadow: number;
  };
  decisions: number;
  usage: Usage;
  temporalUpdates: TemporalUpdateResult[];
}

interface TemporalUpdateResult {
  id: string;
  query: string;
  oldValue: string;
  newValue: string;
  oldRetired: boolean;
  newPresent: boolean;
  hit: boolean;
  items: number;
}

interface ScorecardResult {
  generatedAt: string;
  head: string;
  model: string;
  baseUrl: string;
  classification: {
    items: number;
    scored: number;
    correct: number;
    accuracy: number;
    perClass: ClassMetric[];
    worst: Array<{ from: DreamRole; to: DreamRole; count: number }>;
    pairs: Array<{ pair: string; correct: number; total: number; accuracy: number }>;
    correction: { detected: number; total: number; newFactFalsePositives: number; newFactTotal: number };
    groups: Array<{ group: string; correct: number; total: number }>;
    results: ClassificationItemResult[];
    usage: Usage;
  };
  compile: {
    scenarios: CompileScenarioResult[];
    totals: {
      episodes: number;
      processed: number;
      failed: number;
      framesPassed: number;
      processorErrors: number;
      fallbackNeedEpisodes: number;
      deterministicFallbackFrames: number;
      goldHits: number;
      goldTotal: number;
      candidates: number;
      promoted: number;
      rejected: number;
      suppressed: number;
      temporalTotal: number;
      temporalOldRetired: number;
      temporalNewPresent: number;
      temporalHits: number;
    };
    usage: Usage;
  };
  calibration: CalibrationResult;
  usage: Usage;
}

const CALIBRATION_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '<0.60', min: -Infinity, max: 0.6 },
  { label: '0.60–<0.72', min: 0.6, max: 0.72 },
  { label: '0.72–<0.74', min: 0.72, max: 0.74 },
  { label: '0.74–<0.86', min: 0.74, max: 0.86 },
  { label: '0.86–<0.90', min: 0.86, max: 0.9 },
  { label: '0.90–<0.95', min: 0.9, max: 0.95 },
  { label: '>=0.95', min: 0.95, max: Infinity },
];

const repo = resolve(import.meta.dir, '../..');
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const baseUrl = (process.env.MG_BASE_URL ?? argument('base-url') ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
const model = argument('model') ?? process.env.MG_MODEL ?? DEFAULT_MODEL;
const apiKey = process.env.MG_API_KEY ?? 'magpie';
const reportOnly = process.argv.includes('--report-only');
const classOnly = process.argv.includes('--class-only');
const compileOnly = process.argv.includes('--compile-only');
const keep = process.argv.includes('--keep');
const workRoot = join(repo, '.cogmem', 'dream-scorecard');
mkdirSync(workRoot, { recursive: true });
const runRoot = mkdtempSync(join(workRoot, 'run-'));
process.env.TMPDIR = runRoot;

const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
const calibrationSamples: CalibrationSample[] = [];
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
  writeFileSync(join(outDir, 'results.md'), renderMarkdown(JSON.parse(readFileSync(path, 'utf8')) as ScorecardResult));
  process.exit(0);
}

await preflight();
const kernel = createMemoryKernel({ dbPath: join(runRoot, 'memory.db'), modelRegistry: registry, projectTimeZone: 'Asia/Tokyo' });
const backend = new KernelAgentMemoryBackend(kernel);

const classBefore = snapshotUsage();
const classification = classOnly || !compileOnly
  ? await runClassification()
  : emptyClassification(snapshotUsage());
const classUsage = deltaUsage(usage, classBefore);
classification.usage = classUsage;

const compileBefore = snapshotUsage();
const compile = compileOnly || !classOnly
  ? await runCompile()
  : emptyCompile();
compile.usage = deltaUsage(usage, compileBefore);

const result: ScorecardResult = {
  generatedAt: new Date().toISOString(),
  head: gitHead(),
  model,
  baseUrl,
  classification,
  compile,
  calibration: summarizeCalibration(calibrationSamples),
  usage,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(join(outDir, 'results.md'), renderMarkdown(result));
kernel.close();
if (!keep) rmSync(runRoot, { recursive: true, force: true });

console.log(`classification ${classification.correct}/${classification.scored} (${percent(classification.correct, classification.scored)})`);
console.log(`compile frames ${compile.totals.framesPassed}/${compile.totals.processed}, gold ${compile.totals.goldHits}/${compile.totals.goldTotal}`);
console.log(`temporal old retired ${compile.totals.temporalOldRetired}/${compile.totals.temporalTotal}, hits ${compile.totals.temporalHits}/${compile.totals.temporalTotal}`);
console.log(`usage ${usage.calls} calls, ${usage.inputTokens + usage.outputTokens} tokens`);

async function runClassification(): Promise<ScorecardResult['classification']> {
  const results: ClassificationItemResult[] = [];
  for (const [index, item] of CLASSIFICATION_CORPUS.entries()) {
    const projectId = `dream-scorecard-class-${item.id}`;
    const timestamp = T0 + index * HOUR;
    const turn = await backend.rememberTurnWithResult({
      agentId: 'owner',
      projectId,
      sessionId: `class-${item.id}`,
      userText: item.userText,
      assistantText: item.assistantText,
      ingestMode: 'raw_then_dream',
      timestamp,
    });
    const userEventId = turn.rawEventIds[0]!;
    await kernel.runDreamCurator({
      projectId,
      eventIds: turn.rawEventIds,
      mode: 'candidate',
      dreamMode: 'micro',
      limit: 20,
      now: timestamp + 1_000,
    });
    const candidates = kernel.listDreamCandidates({ projectId, limit: 200 })
      .filter((candidate) => evidenceIds(candidate).includes(userEventId)) as CandidateRecord[];
    const prediction = predictRole(candidates);
    const correctionDetected = candidates.some((candidate) => candidate.candidateType === 'correction');
    kernel.promoteDreamCandidates({ projectId, limit: 200 });
    recordCalibration(kernel.listDreamCandidates({ projectId, limit: 200 }) as CandidateRecord[]);
    results.push({
      id: item.id,
      role: item.role,
      predicted: correctionDetected && item.role === 'correction' ? 'correction' : prediction.role,
      source: correctionDetected && item.role === 'correction' ? 'correction' : prediction.source,
      correct: item.role === prediction.role || (item.role === 'correction' && correctionDetected),
      pair: item.pair,
      group: item.group,
      candidates: candidates.map((candidate) => candidate.candidateType),
      correctionDetected,
    });
  }
  return summarizeClassification(results);
}

async function runCompile(): Promise<ScorecardResult['compile']> {
  const scenarios: CompileScenarioResult[] = [];
  for (const scenario of COMPILE_SCENARIOS) {
    scenarios.push(await runCompileScenario(scenario));
  }
  const totals = scenarios.reduce((sum, scenario) => ({
    episodes: sum.episodes + scenario.episodes,
    processed: sum.processed + scenario.processed,
    failed: sum.failed + scenario.failed,
    framesPassed: sum.framesPassed + scenario.framesPassed,
    processorErrors: sum.processorErrors + scenario.processorErrors,
    fallbackNeedEpisodes: sum.fallbackNeedEpisodes + scenario.fallbackNeedEpisodes,
    deterministicFallbackFrames: sum.deterministicFallbackFrames + scenario.deterministicFallbackFrames,
    goldHits: sum.goldHits + scenario.goldHits,
    goldTotal: sum.goldTotal + scenario.goldTotal,
    candidates: sum.candidates + scenario.candidates,
    promoted: sum.promoted + scenario.queue.promoted,
    rejected: sum.rejected + scenario.queue.rejected,
    suppressed: sum.suppressed + scenario.queue.needsConfirmation + scenario.queue.superseded,
    temporalTotal: sum.temporalTotal + scenario.temporalUpdates.length,
    temporalOldRetired: sum.temporalOldRetired + scenario.temporalUpdates.filter((item) => item.oldRetired).length,
    temporalNewPresent: sum.temporalNewPresent + scenario.temporalUpdates.filter((item) => item.newPresent).length,
    temporalHits: sum.temporalHits + scenario.temporalUpdates.filter((item) => item.hit).length,
  }), {
    episodes: 0, processed: 0, failed: 0, framesPassed: 0, processorErrors: 0, fallbackNeedEpisodes: 0,
    deterministicFallbackFrames: 0, goldHits: 0, goldTotal: 0, candidates: 0,
    promoted: 0, rejected: 0, suppressed: 0, temporalTotal: 0, temporalOldRetired: 0, temporalNewPresent: 0, temporalHits: 0,
  });
  return { scenarios, totals, usage: { calls: 0, inputTokens: 0, outputTokens: 0 } };
}

async function runCompileScenario(scenario: CompileScenario): Promise<CompileScenarioResult> {
  const projectId = `dream-scorecard-compile-${scenario.id}`;
  const episodeIds: string[] = [];
  let lastTimestamp = T0;
  for (const [dayIndex, day] of scenario.days.entries()) {
    for (const [turnIndex, turn] of day.turns.entries()) {
      const timestamp = Date.parse(`${day.localDate}T02:00:00+09:00`) + turnIndex * HOUR;
      lastTimestamp = timestamp;
      const user = kernel.appendEpisodeMessage({
        projectId,
        sessionId: `${scenario.id}-day-${dayIndex}`,
        sourceAgent: 'owner',
        role: 'user',
        text: turn.userText,
        timestamp,
        localDate: day.localDate,
      });
      const assistant = kernel.appendEpisodeMessage({
        projectId,
        sessionId: `${scenario.id}-day-${dayIndex}`,
        sourceAgent: 'owner',
        role: 'assistant',
        text: turn.assistantText,
        timestamp: timestamp + 1_000,
        localDate: day.localDate,
      });
      for (const episodeId of [user.episodeId, assistant.episodeId]) {
        if (episodeId && !episodeIds.includes(episodeId)) episodeIds.push(episodeId);
      }
    }
  }
  const sealNow = lastTimestamp + DAY;
  for (const episodeId of episodeIds) {
    const episode = kernel.listEpisodes({ projectId, limit: 200 }).find((item) => item.episodeId === episodeId);
    if (episode && episode.status !== 'sealed') {
      kernel.sealEpisode(episodeId, { mode: 'manual', reason: 'dream scorecard seed', now: sealNow });
    }
  }
  const before = snapshotUsage();
  const tick = await kernel.runDreamTick({ projectId, maxEpisodes: 50, now: sealNow + 6 * HOUR });
  const frames = episodeIds
    .map((episodeId) => kernel.getMemoryFrame(episodeId, projectId, { includeStaged: true }))
    .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
  const framesPassed = frames.filter((frame) => frame.sourceAuthority === 'processor').length;
  const deterministicFallbackFrames = frames.filter((frame) => frame.sourceAuthority === 'deterministic_fallback').length;
  const fallbackNeedEpisodes = episodeIds.length - framesPassed;
  const candidates = kernel.listDreamCandidates({ projectId, limit: 1_000 });
  const governance = kernel.promoteDreamCandidates({ projectId, limit: 1_000 });
  recordCalibration(kernel.listDreamCandidates({ projectId, limit: 1_000 }) as CandidateRecord[]);
  const queue = kernel.getDreamCandidateQueue(projectId);
  const temporalUpdates = measureTemporalUpdates(scenario, projectId, sealNow + 7 * HOUR);
  const text = JSON.stringify({ frames, candidates }).toLowerCase();
  const gold = scenario.gold.map((point) => ({
    id: point.id,
    label: point.label,
    hit: point.groups.every((group) => group.some((term) => text.includes(term.toLowerCase()))),
  }));
  return {
    id: scenario.id,
    title: scenario.title,
    episodes: episodeIds.length,
    processed: tick.processedEpisodeCount,
    failed: tick.failedEpisodeCount,
    framesPassed,
    processorErrors: tick.semanticProcessorFailedCount,
    deterministicFallbackFrames,
    fallbackNeedEpisodes,
    goldHits: gold.filter((point) => point.hit).length,
    goldTotal: gold.length,
    gold,
    candidates: candidates.length,
    queue,
    decisions: governance.decisions.length,
    usage: deltaUsage(usage, before),
    temporalUpdates,
  };
}

function measureTemporalUpdates(scenario: CompileScenario, projectId: string, now: number): TemporalUpdateResult[] {
  return (scenario.temporalUpdates ?? []).map((update) => {
    const recalled = backend.recall({ agentId: 'owner', projectId, query: update.query, limit: 50, now });
    const text = recalled.items.map((item) => item.text).join('\n');
    const oldRetired = !text.includes(update.oldValue);
    const newPresent = text.includes(update.newValue);
    return {
      id: update.id,
      query: update.query,
      oldValue: update.oldValue,
      newValue: update.newValue,
      oldRetired,
      newPresent,
      hit: oldRetired && newPresent,
      items: recalled.items.length,
    };
  });
}

function recordCalibration(candidates: CandidateRecord[]): void {
  for (const candidate of candidates) {
    if (candidate.candidateType === 'diagnostic_conclusion') continue;
    calibrationSamples.push({
      confidence: candidate.confidence,
      deterministic: record(candidate.content).source !== 'llm_dream_curator_candidate',
      promoted: candidate.status === 'promoted',
    });
  }
}

function summarizeCalibration(samples: CalibrationSample[]): CalibrationResult {
  const model = CALIBRATION_BUCKETS.map((bucket) => {
    const items = samples.filter((sample) => !sample.deterministic && sample.confidence >= bucket.min && sample.confidence < bucket.max);
    return calibrationBucket(bucket.label, items);
  });
  const deterministic = calibrationBucket('deterministic (all)', samples.filter((sample) => sample.deterministic));
  return {
    model,
    deterministic,
    modelCandidates: model.reduce((sum, bucket) => sum + bucket.candidates, 0),
    modelPromoted: model.reduce((sum, bucket) => sum + bucket.promoted, 0),
    deterministicCandidates: deterministic.candidates,
    deterministicPromoted: deterministic.promoted,
  };
}

function calibrationBucket(label: string, samples: CalibrationSample[]): CalibrationBucket {
  const promoted = samples.filter((sample) => sample.promoted).length;
  return {
    bucket: label,
    candidates: samples.length,
    promoted,
    survival: samples.length === 0 ? null : promoted / samples.length,
  };
}

function summarizeClassification(results: ClassificationItemResult[]): ScorecardResult['classification'] {
  const scored = results.filter((item) => item.role !== 'correction' && !item.group);
  const correct = scored.filter((item) => item.correct).length;
  const perClass = SCORED_ROLES.map((role) => {
    const support = scored.filter((item) => item.role === role).length;
    const truePositive = scored.filter((item) => item.role === role && item.predicted === role).length;
    const falsePositive = scored.filter((item) => item.role !== role && item.predicted === role).length;
    const falseNegative = scored.filter((item) => item.role === role && item.predicted !== role).length;
    return {
      role,
      precision: truePositive + falsePositive === 0 ? null : truePositive / (truePositive + falsePositive),
      recall: truePositive + falseNegative === 0 ? null : truePositive / (truePositive + falseNegative),
      support,
    };
  });
  const counts = new Map<string, { from: DreamRole; to: DreamRole; count: number }>();
  for (const item of scored) {
    if (item.role === item.predicted) continue;
    const key = `${item.role}->${item.predicted}`;
    const current = counts.get(key) ?? { from: item.role, to: item.predicted, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const worst = [...counts.values()].sort((left, right) => right.count - left.count).slice(0, 3);
  const pairIds = [...new Set(results.map((item) => item.pair).filter((pair): pair is string => Boolean(pair)))];
  const pairs = pairIds.map((pair) => {
    const items = results.filter((item) => item.pair === pair);
    const pairCorrect = items.filter((item) => item.correct).length;
    return { pair, correct: pairCorrect, total: items.length, accuracy: items.length === 0 ? 0 : pairCorrect / items.length };
  });
  const correctionItems = results.filter((item) => item.role === 'correction');
  const newFactItems = results.filter((item) => item.pair === 'correction_vs_new_fact' && item.role !== 'correction');
  const groups = [...new Set(results.map((item) => item.group).filter((group): group is string => Boolean(group)))]
    .map((group) => {
      const items = results.filter((item) => item.group === group);
      return { group, correct: items.filter((item) => item.correct).length, total: items.length };
    });
  return {
    items: results.length,
    scored: scored.length,
    correct,
    accuracy: scored.length === 0 ? 0 : correct / scored.length,
    perClass,
    worst,
    pairs,
    correction: {
      detected: correctionItems.filter((item) => item.correctionDetected).length,
      total: correctionItems.length,
      newFactFalsePositives: newFactItems.filter((item) => item.correctionDetected).length,
      newFactTotal: newFactItems.length,
    },
    groups,
    results,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

function predictRole(candidates: CandidateRecord[]): { role: DreamRole; source: string } {
  const preference = candidates.find((candidate) => candidate.candidateType === 'preferences'
    && record(candidate.content).source === 'explicit_user_statement');
  if (preference) {
    const category = String(record(preference.content).category ?? '');
    if (category === 'project_constraint' || category === 'operating_preference' || category === 'operating_constraint') {
      return { role: 'rule', source: 'preferences.category' };
    }
    if (category === 'long_term_goal') return { role: 'commitment', source: 'preferences.category' };
    if (category === 'user_preference') return { role: 'soul', source: 'preferences.category' };
  }
  const types: Array<[string, DreamRole]> = [
    ['boundary', 'rule'],
    ['user_preference', 'soul'],
    ['long_term_goal', 'commitment'],
    ['temporal_fact_update', 'intention'],
    ['project_memory', 'experience'],
    ['topic_summary', 'ordinary'],
    ['summary', 'ordinary'],
  ];
  for (const [type, role] of types) {
    if (candidates.some((candidate) => candidate.candidateType === type)) return { role, source: type };
  }
  return { role: 'ordinary', source: 'default' };
}

function evidenceIds(candidate: { evidence: unknown }): string[] {
  if (!Array.isArray(candidate.evidence)) return [];
  return candidate.evidence
    .map((item) => record(item).eventId)
    .filter((eventId): eventId is string => typeof eventId === 'string');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function snapshotUsage(): Usage {
  return { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function deltaUsage(after: Usage, before: Usage): Usage {
  return {
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
  };
}

function emptyClassification(_before: Usage): ScorecardResult['classification'] {
  return summarizeClassification([]);
}

function emptyCompile(): ScorecardResult['compile'] {
  return {
    scenarios: [],
    totals: { episodes: 0, processed: 0, failed: 0, framesPassed: 0, processorErrors: 0, fallbackNeedEpisodes: 0, deterministicFallbackFrames: 0, goldHits: 0, goldTotal: 0, candidates: 0, promoted: 0, rejected: 0, suppressed: 0, temporalTotal: 0, temporalOldRetired: 0, temporalNewPresent: 0, temporalHits: 0 },
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

function gitHead(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function preflight(): Promise<void> {
  const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`memory model endpoint ${baseUrl} returned HTTP ${response.status}`);
}

function percent(hits: number, total: number): string {
  return total === 0 ? 'n/a' : `${((100 * hits) / total).toFixed(1)}%`;
}

function renderMarkdown(result: ScorecardResult): string {
  const lines: string[] = [
    '# Dream work scorecard — #378',
    '',
    `- head: \`${result.head}\``,
    `- model: \`${result.model}\` at \`${result.baseUrl}\``,
    `- generated: ${result.generatedAt}`,
    '',
    '## Classification',
    '',
    `Scored items: ${result.classification.correct}/${result.classification.scored} (${percent(result.classification.correct, result.classification.scored)}). Correction probes: ${result.classification.results.filter((item) => item.role === 'correction').length} (excluded from six-class accuracy).`,
    '',
    '| role | precision | recall | support |',
    '| --- | --- | --- | --- |',
    ...result.classification.perClass.map((metric) => `| ${metric.role} | ${formatRate(metric.precision)} | ${formatRate(metric.recall)} | ${metric.support} |`),
    '',
    'Worst three error categories:',
    '',
    ...(result.classification.worst.length === 0
      ? ['- none']
      : result.classification.worst.map((item) => `- ${item.from} → ${item.to}: ${item.count}`)),
    '',
    'Confusion pairs:',
    '',
    '| pair | correct | total | accuracy |',
    '| --- | --- | --- | --- |',
    ...result.classification.pairs.map((pair) => `| ${pair.pair} | ${pair.correct} | ${pair.total} | ${percent(pair.correct, pair.total)} |`),
    '',
    `Correction detection: ${result.classification.correction.detected}/${result.classification.correction.total}; new-fact false positives: ${result.classification.correction.newFactFalsePositives}/${result.classification.correction.newFactTotal}.`,
    `Group probes: ${result.classification.groups.map((group) => `${group.group} ${group.correct}/${group.total}`).join('; ') || 'none'}.`,
    '',
    '## Compile',
    '',
    '| scenario | episodes | frame pass | processor errors | fallback need | gold points | candidates | promoted | rejected | suppressed |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...result.compile.scenarios.map((scenario) => `| ${scenario.id} | ${scenario.episodes} | ${scenario.framesPassed}/${scenario.episodes} | ${scenario.processorErrors} | ${scenario.fallbackNeedEpisodes}/${scenario.episodes} | ${scenario.goldHits}/${scenario.goldTotal} | ${scenario.candidates} | ${scenario.queue.promoted} | ${scenario.queue.rejected} | ${scenario.queue.needsConfirmation + scenario.queue.superseded} |`),
    '',
    `Totals: episodes ${result.compile.totals.episodes}, processed ${result.compile.totals.processed}, failed ${result.compile.totals.failed}, frame pass ${result.compile.totals.framesPassed}/${result.compile.totals.episodes} (${percent(result.compile.totals.framesPassed, result.compile.totals.episodes)}), processor errors ${result.compile.totals.processorErrors}, fallback need ${result.compile.totals.fallbackNeedEpisodes}/${result.compile.totals.episodes} (${percent(result.compile.totals.fallbackNeedEpisodes, result.compile.totals.episodes)}), gold ${result.compile.totals.goldHits}/${result.compile.totals.goldTotal} (${percent(result.compile.totals.goldHits, result.compile.totals.goldTotal)}).`,
    '',
    '## Chinese temporal updates',
    '',
    '| case | query | old value | new value | old retired | new present | hit | recall items |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...result.compile.scenarios.flatMap((scenario) => scenario.temporalUpdates.map((item) => `| ${item.id} | ${item.query} | ${item.oldValue} | ${item.newValue} | ${item.oldRetired ? 'yes' : 'no'} | ${item.newPresent ? 'yes' : 'no'} | ${item.hit ? 'yes' : 'no'} | ${item.items} |`)),
    '',
    `Old value retired: ${result.compile.totals.temporalOldRetired}/${result.compile.totals.temporalTotal}; new value present: ${result.compile.totals.temporalNewPresent}/${result.compile.totals.temporalTotal}; hit (old retired and new present): ${result.compile.totals.temporalHits}/${result.compile.totals.temporalTotal}.`,
    '',
    '## Confidence calibration',
    '',
    '| bucket | candidates | promoted | survival |',
    '| --- | --- | --- | --- |',
    ...result.calibration.model.map((bucket) => `| ${bucket.bucket} | ${bucket.candidates} | ${bucket.promoted} | ${percent(bucket.promoted, bucket.candidates)} |`),
    `| ${result.calibration.deterministic.bucket} | ${result.calibration.deterministic.candidates} | ${result.calibration.deterministic.promoted} | ${percent(result.calibration.deterministic.promoted, result.calibration.deterministic.candidates)} |`,
    '',
    `Model candidates: ${result.calibration.modelPromoted}/${result.calibration.modelCandidates} promoted (${percent(result.calibration.modelPromoted, result.calibration.modelCandidates)}). Deterministic candidates: ${result.calibration.deterministicPromoted}/${result.calibration.deterministicCandidates} promoted (${percent(result.calibration.deterministicPromoted, result.calibration.deterministicCandidates)}).`,
    '',
    '## Cost',
    '',
    '| phase | calls | input tokens | output tokens |',
    '| --- | --- | --- | --- |',
    `| classification | ${result.classification.usage.calls} | ${result.classification.usage.inputTokens} | ${result.classification.usage.outputTokens} |`,
    `| compile | ${result.compile.usage.calls} | ${result.compile.usage.inputTokens} | ${result.compile.usage.outputTokens} |`,
    `| total | ${result.usage.calls} | ${result.usage.inputTokens} | ${result.usage.outputTokens} |`,
    '',
    'Fallback need is the share of episodes with no processor frame; the nightly path fails those episodes rather than invoking `deterministicFrameFallback`, so this is the closest measurable proxy. Suppressed = `needs_confirmation` + `superseded` after CPU governance.',
    '',
  ];
  return lines.join('\n');
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

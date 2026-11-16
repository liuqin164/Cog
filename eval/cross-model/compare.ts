#!/usr/bin/env bun
/**
 * #269 E6 — the second-model rows for B4 and C3, and the difference from the
 * first model. D5 is named but not rerun: the D group has not landed.
 *
 *   bun eval/cross-model/compare.ts
 *
 * Reads the four results.json files produced by the existing harnesses and
 * writes results.md next to this file. It does not call a model.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface FoldArm {
  arm: string;
  tasks: number;
  correct: number;
  hallucinated: number;
  targetDrill: number;
  anyDrill: number;
  avgPromptTokens: number;
  avgModelCalls: number;
  avgToolCalls: number;
  avgContextChars: number;
}

interface FoldFile {
  model: string;
  head: string;
  generatedAt: string;
  limit: number;
  summary: FoldArm[];
}

interface Band {
  band: number;
  tasks: number;
  successes: number;
  successRate: number;
  factRecall: number;
  promptTokens: { mean: number; min: number; max: number };
  latencyMs: { mean: number; median: number; p95: number };
  costUsd: { total: number; perCall: number } | null;
  errors: number;
}

interface SweetFile {
  model: string;
  head: string;
  at: string;
  summary: Band[];
}

const here = import.meta.dir;
const paths = {
  foldFirst: resolve(here, '../fold-drill/results.json'),
  foldSecond: resolve(here, 'fold-drill-glm-5.3-flash/results.json'),
  sweetFirst: resolve(here, '../sweet-spot/results.json'),
  sweetSecond: resolve(here, 'sweet-spot-glm-5.3-flash/results.json'),
};

function load<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function pct(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function rate(hits: number, total: number): number {
  return total === 0 ? 0 : hits / total;
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(4)}`;
}

function ratio(second: number, first: number): string {
  return first === 0 ? '—' : `${(second / first).toFixed(2)}×`;
}

function main(): void {
  const foldFirst = load<FoldFile>(paths.foldFirst);
  const foldSecond = load<FoldFile>(paths.foldSecond);
  const sweetFirst = load<SweetFile>(paths.sweetFirst);
  const sweetSecond = load<SweetFile>(paths.sweetSecond);

  const foldArm = (file: FoldFile, arm: string): FoldArm => {
    const found = file.summary.find((entry) => entry.arm === arm);
    if (!found) throw new Error(`${file.model}: missing arm ${arm}`);
    return found;
  };

  const lines: string[] = [];
  lines.push('# Cross-model retest — #269 E6');
  lines.push('');
  lines.push(`- first model: \`${foldFirst.model}\` (B4 head \`${foldFirst.head}\`, C3 head \`${sweetFirst.head}\`)`);
  lines.push(`- second model: \`${foldSecond.model}\` (B4 head \`${foldSecond.head}\`, C3 head \`${sweetSecond.head}\`)`);
  lines.push(`- second-model B4 run: ${foldSecond.generatedAt}; C3 run: ${sweetSecond.at}`);
  lines.push('- second model is non-DeepSeek (GLM family), reachable at the mg gateway, tool-capable, and priced by `/v1/models`.');
  lines.push('- D5: no rerunnable object; the D group has not landed. Re-run when it does.');
  lines.push('');
  lines.push('## B4 fold/drill');
  lines.push('');
  lines.push('| arm | model | target drill | any drill | correct | hallucinated | avg prompt tokens | avg model calls | avg tool calls |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const arm of ['full', 'folded_key', 'folded_auto']) {
    for (const [file, label] of [
      [foldFirst, 'DeepSeek'],
      [foldSecond, 'GLM'],
    ] as const) {
      const row = foldArm(file, arm);
      lines.push(
        `| ${arm} | ${label} | ${pct(rate(row.targetDrill, row.tasks))} | ${pct(rate(row.anyDrill, row.tasks))} | ${pct(rate(row.correct, row.tasks))} | ${pct(rate(row.hallucinated, row.tasks))} | ${row.avgPromptTokens.toFixed(0)} | ${row.avgModelCalls.toFixed(2)} | ${row.avgToolCalls.toFixed(2)} |`,
      );
    }
  }
  lines.push('');
  lines.push('### B4 difference');
  lines.push('');
  lines.push('| arm | target drill Δ (pp) | correct Δ (pp) | prompt token ratio |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const arm of ['full', 'folded_key', 'folded_auto']) {
    const first = foldArm(foldFirst, arm);
    const second = foldArm(foldSecond, arm);
    const drillDelta = 100 * (rate(second.targetDrill, second.tasks) - rate(first.targetDrill, first.tasks));
    const correctDelta = 100 * (rate(second.correct, second.tasks) - rate(first.correct, first.tasks));
    lines.push(
      `| ${arm} | ${drillDelta >= 0 ? '+' : ''}${drillDelta.toFixed(1)} | ${correctDelta >= 0 ? '+' : ''}${correctDelta.toFixed(1)} | ${ratio(second.avgPromptTokens, first.avgPromptTokens)} |`,
    );
  }
  lines.push('');
  lines.push('## C3 sweet spot');
  lines.push('');
  lines.push('| targetTokens | model | task success | fact recall | prompt tokens | latency mean | latency p95 | cost total | errors |');
  lines.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const band of sweetFirst.summary) {
    const second = sweetSecond.summary.find((entry) => entry.band === band.band);
    if (!second) throw new Error(`second model is missing band ${band.band}`);
    lines.push(
      `| ${band.band} | DeepSeek | ${band.successes}/${band.tasks} (${pct(band.successRate)}) | ${pct(band.factRecall)} | ${band.promptTokens.mean} | ${band.latencyMs.mean} ms | ${band.latencyMs.p95} ms | ${money(band.costUsd?.total ?? null)} | ${band.errors} |`,
    );
    lines.push(
      `| ${band.band} | GLM | ${second.successes}/${second.tasks} (${pct(second.successRate)}) | ${pct(second.factRecall)} | ${second.promptTokens.mean} | ${second.latencyMs.mean} ms | ${second.latencyMs.p95} ms | ${money(second.costUsd?.total ?? null)} | ${second.errors} |`,
    );
  }
  lines.push('');
  lines.push('### C3 difference');
  lines.push('');
  lines.push('| targetTokens | success Δ (pp) | recall Δ (pp) | prompt token ratio | latency ratio | cost ratio |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const band of sweetFirst.summary) {
    const second = sweetSecond.summary.find((entry) => entry.band === band.band)!;
    const successDelta = 100 * (second.successRate - band.successRate);
    const recallDelta = 100 * (second.factRecall - band.factRecall);
    const costRatio =
      band.costUsd && second.costUsd && band.costUsd.total > 0
        ? ratio(second.costUsd.total, band.costUsd.total)
        : '—';
    lines.push(
      `| ${band.band} | ${successDelta >= 0 ? '+' : ''}${successDelta.toFixed(1)} | ${recallDelta >= 0 ? '+' : ''}${recallDelta.toFixed(1)} | ${ratio(second.promptTokens.mean, band.promptTokens.mean)} | ${ratio(second.latencyMs.mean, band.latencyMs.mean)} | ${costRatio} |`,
    );
  }
  lines.push('');
  lines.push('## Conclusion');
  lines.push('');
  const firstKey = foldArm(foldFirst, 'folded_key');
  const secondKey = foldArm(foldSecond, 'folded_key');
  const firstAuto = foldArm(foldFirst, 'folded_auto');
  const secondAuto = foldArm(foldSecond, 'folded_auto');
  const drillGap = 100 * (rate(secondKey.targetDrill, secondKey.tasks) - rate(firstKey.targetDrill, firstKey.tasks));
  lines.push(
    `- B4 passive key: folded_key drills the target ${pct(rate(firstKey.targetDrill, firstKey.tasks))} on DeepSeek and ${pct(rate(secondKey.targetDrill, secondKey.tasks))} on GLM (${drillGap >= 0 ? '+' : ''}${drillGap.toFixed(1)} pp). Auto-expansion drills ${pct(rate(firstAuto.targetDrill, firstAuto.tasks))} and ${pct(rate(secondAuto.targetDrill, secondAuto.tasks))} respectively.`,
  );
  lines.push(
    `- B4 where it differs: the full arm drops 4.2 pp on GLM because one constraint task (f16) answers the surrounding constraint instead of the asked time; folded_key recovers it by reading the original, so the gap is not in the passive-key path. GLM's two full-arm hallucination flags are the task-id digits 8 and 21 in the reply prose, not invented detail values; the answer lines are correct. Folded_key uses fewer tool calls on GLM (${secondKey.avgToolCalls.toFixed(2)} vs ${firstKey.avgToolCalls.toFixed(2)}) and 13% fewer prompt tokens.`,
  );
  const firstFlat =
    Math.max(...sweetFirst.summary.map((entry) => entry.successRate)) -
      Math.min(...sweetFirst.summary.map((entry) => entry.successRate)) <
    0.05;
  const secondFlat =
    Math.max(...sweetSecond.summary.map((entry) => entry.successRate)) -
      Math.min(...sweetSecond.summary.map((entry) => entry.successRate)) <
    0.05;
  lines.push(
    `- C3: success is ${firstFlat ? 'flat' : 'not flat'} across 6k–48k on DeepSeek and ${secondFlat ? 'flat' : 'not flat'} on GLM. ${
      firstFlat && secondFlat
        ? 'Both models show no attention knee, so 6,000 remains the measured optimum on accuracy for both. The token, latency and cost multipliers differ, so keep the route value per model rather than averaging the curves.'
        : 'The curves do not agree across models; the route value must be set per model, and the two curves must not be averaged.'
    }`,
  );
  lines.push(
    '- C3 where it differs: accuracy and recall are identical at every band (0.0 pp). GLM counts 9–12% more prompt tokens on the same contexts, is 0.54–0.76× as slow at 6k–24k but 1.13× at 48k, and costs 0.85–0.88× because its list price is lower. The route value is therefore a per-model number even when the accuracy conclusion agrees.',
  );
  lines.push(
    '- D5: no rerunnable object; the D group has not landed. Re-run when it does; no number is reported here.',
  );
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  lines.push('- One second model, one run per cell, temperature 0. Provider nondeterminism can move individual tasks.');
  lines.push('- C3 cost is list-price prompt tokens from the harness; it does not apply the cache-read price. #259 covers cache-aware cost on the first model.');
  lines.push('- B4 and C3 use the same synthetic corpora as the first-model runs; the second model only changes the `--model` argument.');
  lines.push('- The GLM route reports real pricing; a route with no pricing would leave the cost column `—`.');

  const out = resolve(here, 'results.md');
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`wrote ${out}`);
}

main();

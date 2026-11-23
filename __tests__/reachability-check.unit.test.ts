import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { evaluateReachability, usesIn } from '../scripts/reachability-check.ts';
import { makeTempDir } from './helpers/tmp.js';

const ROOT = process.cwd();
const API_ONLY = [
  'src/strategy/ContextPolicyScorer.ts',
  'src/strategy/StrategyDiversitySelector.ts',
  'src/strategy/StrategyRolloutEvaluator.ts',
];

test('the unused strategy modules are api-only and must stay registered', () => {
  const baseline = evaluateReachability();
  expect(baseline.unregistered).toEqual([]);
  expect(baseline.stale).toEqual([]);
  for (const file of API_ONLY) expect(baseline.apiOnly).toContain(file);

  const withoutOne = baseline.apiOnly.filter((file) => file !== API_ONLY[0]);
  const result = evaluateReachability({ apiOnly: withoutOne });
  expect(result.unregistered).toEqual([API_ONLY[0]!]);
});

test('comments and import type do not create product reachability', () => {
  const dir = makeTempDir('cogmem-reachability-');
  const file = join(dir, 'fixture.ts');
  writeFileSync(file, [
    "// import { Commented } from './Commented.js';",
    "import type { Typed } from './Typed.js';",
    "import { Real } from './Real.js';",
    '',
  ].join('\n'));

  const uses = usesIn(file);
  expect(uses.some((use) => use.module === './Commented.js')).toBe(false);
  expect(uses.filter((use) => use.module === './Typed.js').every((use) => use.typeOnly)).toBe(true);
  expect(uses.some((use) => use.module === './Real.js' && !use.typeOnly)).toBe(true);

  const result = evaluateReachability();
  const topicTypes = join(ROOT, 'src/topic/TopicTypes.ts');
  expect(result.product.has(topicTypes)).toBe(false);
  expect(result.typeOnly).toContain(relative(ROOT, topicTypes));
});

test('product imports still reach the modules the kernel actually uses', () => {
  const result = evaluateReachability();
  for (const file of [
    'src/strategy/ContextOutcomeStore.ts',
    'src/strategy/MemoryUseJudge.ts',
    'src/strategy/StrategyCortex.ts',
  ]) {
    expect(result.product.has(join(ROOT, file))).toBe(true);
  }
});

test('the binary entry set is explicit rather than every file under src/bin', () => {
  const result = evaluateReachability();
  expect(result.entries).toEqual([
    'src/bin/backup.ts',
    'src/bin/cog.ts',
    'src/bin/cogmem.ts',
    'src/bin/daily.ts',
    'src/bin/doctor.ts',
    'src/bin/dream.ts',
    'src/bin/episode.ts',
    'src/bin/import.ts',
    'src/bin/install.ts',
    'src/bin/memory.ts',
    'src/bin/normalize-transcript.ts',
    'src/bin/observatory.ts',
    'src/bin/prospective.ts',
    'src/bin/repair.ts',
    'src/bin/snapshot.ts',
    'src/bin/version-check-refresh.ts',
    'shell/bin/install',
    'shell/src/cog.ts',
    'shell/src/cli.ts',
    'shell/src/embedding/remote-worker.ts',
    'shell/src/embedding/worker.ts',
    'shell/src/install/doctor-cli.ts',
    'shell/src/plugins/web.ts',
    'shell/src/upgrade/supervisor.ts',
  ]);
  expect(result.entries).not.toContain('src/bin/CliArgs.ts');
  expect(result.product.has(join(ROOT, 'src/bin/CliArgs.ts'))).toBe(true);
});

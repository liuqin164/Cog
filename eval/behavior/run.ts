import { SCENARIOS } from './scenarios/index.js';
import { runScenarios } from './runner.js';
import type { ScenarioResult } from './types.js';

interface Options {
  modulePath?: string;
  filter?: string;
  repeat: number;
  json: boolean;
}

function parse(argv: string[]): Options {
  const options: Options = { repeat: 1, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') options.json = true;
    else if (arg === '--module') options.modulePath = argv[++index];
    else if (arg === '--filter') options.filter = argv[++index];
    else if (arg === '--repeat') options.repeat = Number(argv[++index] ?? '1');
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: bun eval/behavior/run.ts [--module PATH] [--filter ID_OR_CATEGORY] [--repeat N] [--json]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.repeat) || options.repeat <= 0) throw new Error('--repeat must be a positive integer');
  return options;
}

function printResult(result: ScenarioResult): void {
  const marker = result.passed ? 'PASS' : 'FAIL';
  console.log(`${marker} ${result.id} (${result.durationMs.toFixed(0)} ms) — ${result.title}`);
  if (!result.passed) console.log(`  ${result.failure}`);
}

const options = parse(process.argv.slice(2));
const results = await runScenarios(SCENARIOS, options);
const failed = results.filter((result) => !result.passed);
const categories = Object.fromEntries(
  [...new Set(results.map((result) => result.category))].map((category) => [
    category,
    results.filter((result) => result.category === category).length,
  ]),
);

if (options.json) {
  console.log(JSON.stringify({
    contractVersion: 1,
    mode: options.modulePath ? 'installed' : 'fixture',
    module: options.modulePath ?? 'src/public.ts',
    repeat: options.repeat,
    categories,
    summary: { pass: results.length - failed.length, fail: failed.length, scenarios: results.length },
    results,
  }, null, 2));
} else {
  console.log(`behavior-eval v1 · ${options.modulePath ? 'installed' : 'fixture'} · repeat ${options.repeat}`);
  console.log(`categories: ${Object.entries(categories).map(([name, count]) => `${name}=${count}`).join(' ')}`);
  for (const result of results) printResult(result);
  console.log(`summary: ${results.length - failed.length} pass / ${failed.length} fail / ${results.length} scenarios`);
}

if (failed.length > 0) process.exit(1);

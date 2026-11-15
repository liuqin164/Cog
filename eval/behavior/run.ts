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
    else if (arg === '--module' || arg === '--filter') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--module') options.modulePath = value;
      else options.filter = value;
    } else if (arg === '--repeat') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--repeat requires a value');
      options.repeat = Number(value);
    }
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
if (results.length === 0) {
  console.error(`no scenarios matched ${options.filter ? `"${options.filter}"` : 'the selection'}`);
  process.exit(1);
}
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

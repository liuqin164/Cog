import { DEFAULT_MODULE, ScenarioFailure, loadKernelApi, withKernel } from './harness.js';
import type { KernelApi, ScenarioResult } from './types.js';
import type { CompanionScenario } from './types.js';

export interface RunOptions {
  modulePath?: string;
  filter?: string;
  repeat?: number;
}

export async function runScenarios(
  scenarios: readonly CompanionScenario[],
  options: RunOptions = {},
): Promise<ScenarioResult[]> {
  const api: KernelApi = await loadKernelApi(options.modulePath ?? DEFAULT_MODULE);
  const selected = options.filter
    ? scenarios.filter((scenario) => scenario.id.includes(options.filter!) || scenario.category.includes(options.filter!))
    : [...scenarios];
  const repeat = options.repeat ?? 1;
  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    const started = performance.now();
    let failure: string | undefined;
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      try {
        await withKernel(scenario.id, api, (context) => scenario.run(context));
      } catch (error) {
        failure = error instanceof ScenarioFailure ? error.message : `${(error as Error).stack ?? error}`;
        break;
      }
    }
    results.push({
      id: scenario.id,
      category: scenario.category,
      title: scenario.title,
      passed: failure === undefined,
      durationMs: performance.now() - started,
      failure,
    });
  }
  return results;
}

/** The four frozen behaviour-eval categories (#167, F13). */
export const SCENARIO_CATEGORIES = ['record', 'surface', 'withhold', 'correct'] as const;
export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number];

/** The fields a scenario carries. Frozen by `docs/behavior-eval.md`. */
export const SCENARIO_FIELDS = ['id', 'category', 'title', 'criteria', 'pinned', 'run'] as const;

export interface KernelApi {
  createMemoryKernel(options: { dbPath: string; projectTimeZone?: string }): any;
  KernelAgentMemoryBackend: new (kernel: any, options?: Record<string, unknown>) => any;
}

/**
 * One scripted scene. `criteria` is the pass standard, written before the run; `pinned` names the
 * inputs the scene fixes so no model or wall clock decides the result.
 */
export interface CompanionScenario {
  id: string;
  category: ScenarioCategory;
  title: string;
  criteria: string[];
  pinned: string[];
  run(context: ScenarioContext): Promise<void>;
}

export interface ScenarioContext {
  /** The live kernel. Re-read after `reopen()`; the old instance is closed. */
  readonly kernel: any;
  /** The loaded kernel module, so a scenario can construct the public backend face. */
  readonly api: KernelApi;
  /** Close and recreate the kernel on the same database, as a restart would. */
  reopen(): any;
}

export interface ScenarioResult {
  id: string;
  category: ScenarioCategory;
  title: string;
  passed: boolean;
  durationMs: number;
  failure?: string;
}

export const BEHAVIOR_EVAL_CONTRACT_VERSION = 1;

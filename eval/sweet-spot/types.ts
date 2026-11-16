export interface Fact {
  entity: string;
  attribute: string;
  code: string;
}

export interface Task {
  id: string;
  index: number;
  entity: string;
  facts: Fact[];
  question: string;
}

export interface BuiltContext {
  text: string;
  entries: number;
  targetLines: string[];
  contextChars: number;
  /** The shell assembler's own estimate: `ceil(chars / 4)`. */
  contextTokens: number;
}

export interface ModelPricing {
  promptPerToken: number;
  completionPerToken: number;
}

export interface RunResult {
  taskId: string;
  band: number;
  contextChars: number;
  contextTokens: number;
  entries: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  estimatedUsage: boolean;
  latencyMs: number;
  attempts: number;
  costUsd: number | null;
  content: string;
  codes: string[];
  found: number;
  success: boolean;
  error?: string;
}

export interface BandSummary {
  band: number;
  tasks: number;
  successes: number;
  successRate: number;
  factRecall: number;
  contextChars: number;
  contextTokens: number;
  promptTokens: { mean: number; min: number; max: number };
  latencyMs: { mean: number; median: number; p95: number };
  costUsd: { total: number; perCall: number } | null;
  errors: number;
}

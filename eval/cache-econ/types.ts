export type Arm = 'no_fold' | 'per_turn' | 'boundary';
export type DetailType = 'number' | 'name' | 'constraint' | 'step';

/** One user/assistant exchange in the replayed ledger. */
export interface Pair {
  id: string;
  key: string;
  user: string;
  assistant: string;
  /** Exact prefix of `user`; the value is in the omitted suffix for detail pairs. */
  stubQuote: string;
}

export interface Session {
  id: string;
  type: DetailType;
  baseTaskId: string;
  pairs: Pair[];
  targetKey: string;
  question: string;
  expected: string;
  checks: string[][];
  number?: number;
}

export interface Pricing {
  promptPerToken: number;
  completionPerToken: number;
  cacheReadPerToken: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHit: number | null;
  cacheMiss: number | null;
  cacheReported: boolean;
}

export interface CallRecord {
  sessionId: string;
  arm: Arm;
  turn: number;
  kind: 'replay' | 'final';
  contextChars: number;
  usage: Usage;
  costUsd: number | null;
  latencyMs: number;
  modelCalls: number;
  toolCalls: number;
  content: string;
  rawUsage: unknown;
}

export interface TurnRecord {
  sessionId: string;
  arm: Arm;
  turn: number;
  kind: 'replay' | 'final';
  contextChars: number;
  promptTokens: number;
  completionTokens: number;
  cacheHit: number;
  cacheMiss: number;
  cacheReported: boolean;
  costUsd: number | null;
  latencyMs: number;
  modelCalls: number;
  toolCalls: number;
  calls: CallRecord[];
  final: string;
}

export interface SessionResult {
  sessionId: string;
  type: DetailType;
  arm: Arm;
  correct: boolean;
  hallucinated: boolean;
  answerLine: string;
  reason: string;
  turns: TurnRecord[];
}

export interface ArmSummary {
  arm: Arm;
  sessions: number;
  correct: number;
  hallucinated: number;
  turns: number;
  promptTokens: number;
  cacheHit: number;
  cacheMiss: number;
  completionTokens: number;
  cacheHitRate: number;
  avgContextChars: number;
  avgContextTokens: number;
  costUsd: number | null;
  costPerSession: number | null;
  costPerTurn: number | null;
}

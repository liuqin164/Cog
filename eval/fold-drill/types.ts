export type Arm = 'full' | 'folded_key' | 'folded_auto';
export type DetailType = 'number' | 'name' | 'constraint' | 'step';
export type Speaker = 'owner' | 'assistant';

export interface Turn {
  id: string;
  speaker: Speaker;
  text: string;
}

/**
 * One folded ledger line. `stubQuote` is an exact prefix of the turn at
 * `turnId`; the answer value is in the omitted suffix, so the stub can point at
 * the detail without carrying it.
 */
export interface FoldedDetail {
  key: string;
  turnId: string;
  stubQuote: string;
  entityTerms: string[];
}

export interface FoldTask {
  id: string;
  type: DetailType;
  turns: Turn[];
  details: FoldedDetail[];
  targetKey: string;
  question: string;
  expected: string;
  /** Token groups; every group must hit one of its variants. */
  checks: string[][];
  /** Numeric answer, when the expected value is a number. */
  number?: number;
  /** #294: how many giant tool outputs this task plants. */
  blocks?: number;
  /** #294: the size label this task belongs to. */
  scale?: string;
}

export interface RawTask {
  id: string;
  type: DetailType;
  setting: string;
  target: { text: string; stub: string; entity: string[] };
  distractors: [
    { text: string; stub: string; entity: string[] },
    { text: string; stub: string; entity: string[] },
  ];
  question: string;
  expected: string;
  checks: string[][];
  number?: number;
}

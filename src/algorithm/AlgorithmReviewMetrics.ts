import type { FactRecord } from '../store/FactStore.js';

export interface AlgorithmReviewMetricsSnapshot {
  backendMode: 'noop' | 'phase1_rule' | 'model_backed_phase2';
  reviewVersion?: string;
  facts: FactRecord[];
  baselineFacts?: FactRecord[];
}

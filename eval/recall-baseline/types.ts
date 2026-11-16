export type Arm = 'rule_only' | 'fts_trigram' | 'embedding';
export type Kind = 'memory' | 'procedure';

export interface WorkerDoc {
  id: string;
  text: string;
}

export interface WorkerInput {
  model: string;
  cacheDir: string;
  queryPrefix: string;
  docs: Record<Kind, WorkerDoc[]>;
  queries: Record<Kind, WorkerDoc[]>;
}

export interface WorkerOutput {
  ok: boolean;
  model: string;
  dimensions?: number;
  loadMs?: number;
  indexMs?: number;
  queryMs?: number;
  rssBeforeModelBytes?: number;
  rssAfterModelBytes?: number;
  rssAfterIndexBytes?: number;
  rssAfterQueriesBytes?: number;
  peakRssBytes?: number;
  rankings?: Record<Kind, Record<string, Array<{ id: string; score: number }>>>;
  error?: string;
}

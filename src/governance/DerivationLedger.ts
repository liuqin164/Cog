import type Database from 'bun:sqlite';

export type DerivationClassification = 'lineage' | 'rebuildable' | 'audit_only';

export const DERIVATION_TABLE_SQL = `CREATE TABLE memory_derivations (
  derived_kind TEXT NOT NULL,
  derived_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (derived_kind, derived_id, source_event_id)
)`;

export const DERIVATION_INDEX_SQLS = [
  `CREATE INDEX idx_memory_derivations_source ON memory_derivations(source_event_id)`,
  `CREATE INDEX idx_memory_derivations_derived ON memory_derivations(derived_kind, derived_id)`,
] as const;

export const LINEAGE_TABLES = [
  'beliefs','compiled_events','deep_write_summaries',
  'facts','memory_bindings','memory_clusters','memory_frames',
  'memory_timeline_entries','prospective_memories','session_deep_cards',
] as const;

const REBUILDABLE_TABLES = [
  'belief_evidence','belief_graph_conflicts','belief_graph_evidence','belief_graph_nodes',
  'deep_write_candidates','deep_write_summaries_fts','entities','entity_alias_conflicts',
  'entity_aliases','entity_attributes','entity_instances','entity_mentions','entity_relations',
  'episode_cross_refs','interaction_units','memory_action_frame_evidence','memory_action_frames',
  'memory_atlas_alias_ambiguities','memory_atlas_alias_supports','memory_atlas_aliases','memory_atlas_documents',
  'memory_atlas_fts','memory_atlas_supports','memory_edge_supports','memory_edges','memory_entities',
  'memory_entity_scope_identity','memory_episode_events','memory_episodes','memory_event_cjk_terms',
  'memory_event_embeddings','memory_events_fts','memory_frame_nodes','memory_frame_relations',
  'memory_topics','topic_aliases','topic_nodes','topic_relations',
] as const;

const AUDIT_ONLY_TABLES = [
  '_meta','_schema_migrations','belief_graph_versions','compiler_confidence_runs',
  'context_activation_receipts','context_strategy_outcomes','deep_write_candidate_reviews','deep_write_runs',
  'dream_ledger_state','entity_merge_candidates','entity_resolution_log','episode_boundary_decisions',
  'episode_closure_receipts','episode_dream_jobs','episode_dream_runs','episode_event_dispositions',
  'episode_ingest_keys','episode_repair_audit','event_sequence_counters','governance_audit_log',
  'import_source_anchors','ingestion_processed_records','ingestion_source_cursors','memory_atlas_access',
  'memory_atlas_activation','memory_atlas_projection_state','memory_derivations','memory_event_fts_state',
  'memory_events','memory_frame_reviews','memory_governance_audit','memory_governance_operations',
  'memory_governance_plans','pending_bindings','pending_entity_resolution','pipeline_nonfatal_events',
  'pipeline_runs','pipeline_step_timings','prospective_memory_transitions','topic_operations',
] as const;

export const DERIVATION_CLASSIFICATION: Readonly<Record<string, DerivationClassification>> = Object.freeze(
  Object.fromEntries([
    ...LINEAGE_TABLES.map((table) => [table, 'lineage'] as const),
    ...REBUILDABLE_TABLES.map((table) => [table, 'rebuildable'] as const),
    ...AUDIT_ONLY_TABLES.map((table) => [table, 'audit_only'] as const),
  ]) as Record<string, DerivationClassification>,
);

export interface DerivationSource {
  kind: string;
  derivedId: string;
  sourceEventIds: readonly string[];
  projectId?: string | null;
  createdAt?: number;
}

const SCHEMA_SQL = [DERIVATION_TABLE_SQL, ...DERIVATION_INDEX_SQLS]
  .map((sql) => sql.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ').replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS '))
  .join(';\n');

const ensured = new WeakSet<object>();

export function ensureDerivationSchema(db: Database): void {
  if (ensured.has(db)) return;
  db.exec(SCHEMA_SQL);
  ensured.add(db);
}

export function registerDerivation(db: Database, source: DerivationSource): void {
  if (DERIVATION_CLASSIFICATION[source.kind] !== 'lineage') throw new Error(`derivation_kind_unregistered:${source.kind}`);
  const eventIds = [...new Set(source.sourceEventIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (eventIds.length === 0) return;
  ensureDerivationSchema(db);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO memory_derivations (derived_kind, derived_id, source_event_id, project_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const createdAt = source.createdAt ?? Date.now();
  for (const eventId of eventIds) {
    const projectId = source.projectId === undefined ? projectIdForEvent(db, eventId) : source.projectId;
    insert.run(source.kind, source.derivedId, eventId, projectId ?? null, createdAt);
  }
}

function projectIdForEvent(db: Database, eventId: string): string | null {
  try {
    const row = db.prepare(`SELECT project_id FROM memory_events WHERE event_id=?`).get(eventId) as { project_id?: string | null } | null;
    return row?.project_id ?? null;
  } catch {
    return null;
  }
}

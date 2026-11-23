import type Database from 'bun:sqlite';

import { LINEAGE_TABLES } from './DerivationLedger.js';
import { PRIVACY_SCHEMA_CLASSIFICATION } from './PrivacyDeletionRegistry.js';

export interface DerivedEraseContext {
  db: Database;
  eventIdsSource: string;
  episodeIdsSource?: string;
  scope?: string;
  wholeProject?: boolean;
}

const EVENT = `_erase_event_ids`;
const EPISODE = `_erase_episode_ids`;
const FRAME = `_erase_frame_ids`;
const ENTITY = `_erase_entity_ids`;
const BELIEF = `_erase_belief_ids`;
const RUN = `_erase_dw_run_ids`;
const UNIT = `_erase_unit_ids`;

function jsonHit(column: string): string {
  return `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) WHERE value IN (SELECT id FROM ${EVENT}))`;
}

const RULES: ReadonlyArray<readonly [string, string]> = [
  ['session_deep_cards', `DELETE FROM session_deep_cards
    WHERE ${jsonHit('source_refs_json')}`],
  ['memory_action_frame_evidence', `DELETE FROM memory_action_frame_evidence
    WHERE event_id IN (SELECT id FROM ${EVENT})
       OR action_id IN (SELECT action_id FROM memory_action_frames WHERE episode_id IN (SELECT id FROM ${EPISODE}))`],
  ['memory_action_frames', `DELETE FROM memory_action_frames WHERE episode_id IN (SELECT id FROM ${EPISODE})`],
  ['memory_frame_reviews', `DELETE FROM memory_frame_reviews WHERE frame_id IN (SELECT id FROM ${FRAME})`],
  ['memory_frame_relations', `DELETE FROM memory_frame_relations
    WHERE frame_id IN (SELECT id FROM ${FRAME}) OR ${jsonHit('evidence_event_ids_json')}`],
  ['memory_frame_nodes', `DELETE FROM memory_frame_nodes
    WHERE frame_id IN (SELECT id FROM ${FRAME}) OR ${jsonHit('evidence_event_ids_json')}`],
  ['memory_atlas_alias_supports', `DELETE FROM memory_atlas_alias_supports
    WHERE source_frame_id IN (SELECT id FROM ${FRAME}) OR ${jsonHit('evidence_event_ids_json')}`],
  ['memory_atlas_aliases', `DELETE FROM memory_atlas_aliases
    WHERE source_frame_id IN (SELECT id FROM ${FRAME}) OR ${jsonHit('evidence_event_ids_json')}`],
  ['memory_atlas_alias_ambiguities', `DELETE FROM memory_atlas_alias_ambiguities
    WHERE source_frame_id IN (SELECT id FROM ${FRAME})`],
  ['memory_atlas_supports', `DELETE FROM memory_atlas_supports
    WHERE source_frame_id IN (SELECT id FROM ${FRAME})
       OR source_id IN (SELECT id FROM ${EVENT})
       OR source_episode_id IN (SELECT id FROM ${EPISODE})
       OR ${jsonHit('evidence_event_ids_json')}`],
  ['memory_edge_supports', `DELETE FROM memory_edge_supports
    WHERE ${jsonHit('evidence_event_ids_json')}
       OR support_source_id IN (SELECT id FROM ${FRAME})
       OR support_source_id IN (SELECT id FROM ${ENTITY})
       OR edge_id IN (SELECT edge_id FROM memory_edges WHERE ${jsonHit('evidence_event_ids_json')})`],
  ['memory_edges', `DELETE FROM memory_edges
    WHERE ${jsonHit('evidence_event_ids_json')}
       OR source_id IN (SELECT id FROM ${EVENT})
       OR source_id IN (SELECT id FROM ${FRAME})
       OR target_id IN (SELECT id FROM ${FRAME})
       OR source_id IN (SELECT id FROM ${ENTITY})
       OR target_id IN (SELECT id FROM ${ENTITY})
       OR NOT EXISTS (SELECT 1 FROM memory_edge_supports s WHERE s.edge_id = memory_edges.edge_id)`],
  ['memory_frames', `DELETE FROM memory_frames WHERE frame_id IN (SELECT id FROM ${FRAME})`],
  ['memory_clusters', `DELETE FROM memory_clusters WHERE ${jsonHit('evidence_event_ids_json')}`],
  ['memory_bindings', `DELETE FROM memory_bindings WHERE event_id IN (SELECT id FROM ${EVENT})`],
  ['topic_aliases', `DELETE FROM topic_aliases
    WHERE ${jsonHit('evidence_event_ids_json')}
       OR topic_id NOT IN (SELECT topic_id FROM topic_nodes)`],
  ['topic_relations', `DELETE FROM topic_relations WHERE ${jsonHit('evidence_event_ids_json')}`],
  ['topic_operations', `DELETE FROM topic_operations WHERE ${jsonHit('evidence_event_ids_json')}`],
  ['topic_nodes', `DELETE FROM topic_nodes WHERE ${jsonHit('evidence_event_ids_json')}`],
  ['memory_entities', `DELETE FROM memory_entities WHERE entity_id IN (SELECT id FROM ${ENTITY})`],
  ['entities', `DELETE FROM entities WHERE entity_id IN (SELECT id FROM ${ENTITY}) OR created_from IN (SELECT id FROM ${EVENT})`],
  ['entity_instances', `DELETE FROM entity_instances
    WHERE instance_id IN (SELECT id FROM ${ENTITY}) OR canonical_entity_id IN (SELECT id FROM ${ENTITY}) OR created_from IN (SELECT id FROM ${EVENT})`],
  ['memory_entity_scope_identity', `DELETE FROM memory_entity_scope_identity
    WHERE root_entity_id IN (SELECT id FROM ${ENTITY}) OR scoped_entity_id IN (SELECT id FROM ${ENTITY})`],
  ['entity_alias_conflicts', `DELETE FROM entity_alias_conflicts
    WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(entity_ids_json) THEN entity_ids_json ELSE '[]' END) WHERE value IN (SELECT id FROM ${ENTITY}))`],
  ['entity_aliases', `DELETE FROM entity_aliases WHERE entity_id IN (SELECT id FROM ${ENTITY})`],
  ['entity_attributes', `DELETE FROM entity_attributes
    WHERE source_neuron_id IN (SELECT id FROM ${EVENT}) OR entity_id IN (SELECT id FROM ${ENTITY})`],
  ['entity_relations', `DELETE FROM entity_relations
    WHERE source_neuron_id IN (SELECT id FROM ${EVENT})
       OR source_entity_id IN (SELECT id FROM ${ENTITY})
       OR target_entity_id IN (SELECT id FROM ${ENTITY})`],
  ['entity_mentions', `DELETE FROM entity_mentions WHERE neuron_id IN (SELECT id FROM ${EVENT})`],
  ['pending_entity_resolution', `DELETE FROM pending_entity_resolution
    WHERE context_neuron_id IN (SELECT id FROM ${EVENT}) OR resolved_entity_id IN (SELECT id FROM ${ENTITY})`],
  ['compiled_events', `DELETE FROM compiled_events WHERE neuron_id IN (SELECT id FROM ${EVENT})`],
  ['facts', `DELETE FROM facts WHERE neuron_id IN (SELECT id FROM ${EVENT})`],
  ['beliefs', `DELETE FROM beliefs
    WHERE source_event_id IN (SELECT id FROM ${EVENT})
       OR source_neuron_id IN (SELECT id FROM ${EVENT})
       OR id IN (SELECT id FROM ${BELIEF})`],
  ['belief_evidence', `DELETE FROM belief_evidence
    WHERE belief_id IN (SELECT id FROM ${BELIEF})
       OR event_id IN (SELECT id FROM ${EVENT})
       OR neuron_id IN (SELECT id FROM ${EVENT})`],
  ['belief_graph_evidence', `DELETE FROM belief_graph_evidence
    WHERE event_id IN (SELECT id FROM ${EVENT}) OR belief_id IN (SELECT id FROM ${BELIEF})`],
  ['belief_graph_versions', `DELETE FROM belief_graph_versions
    WHERE belief_id IN (SELECT id FROM ${BELIEF}) OR evidence_event_id IN (SELECT id FROM ${EVENT})`],
  ['belief_graph_conflicts', `DELETE FROM belief_graph_conflicts
    WHERE prior_belief_id IN (SELECT id FROM ${BELIEF})
       OR proposed_belief_id IN (SELECT id FROM ${BELIEF})
       OR ${jsonHit('evidence_event_ids_json')}`],
  ['belief_graph_nodes', `DELETE FROM belief_graph_nodes WHERE belief_id IN (SELECT id FROM ${BELIEF})`],
  ['memory_timeline_entries', `DELETE FROM memory_timeline_entries
    WHERE ${jsonHit('evidence_event_ids_json')}
       OR belief_id IN (SELECT id FROM ${BELIEF})
       OR entity_id IN (SELECT id FROM ${ENTITY})`],
  ['prospective_memory_transitions', `DELETE FROM prospective_memory_transitions
    WHERE evidence_event_id IN (SELECT id FROM ${EVENT})
       OR candidate_id IN (SELECT candidate_id FROM prospective_memories WHERE ${jsonHit('evidence_event_ids_json')})`],
  ['prospective_memories', `DELETE FROM prospective_memories
    WHERE ${jsonHit('evidence_event_ids_json')} OR confirmation_evidence_event_id IN (SELECT id FROM ${EVENT})`],
  ['deep_write_candidate_reviews', `DELETE FROM deep_write_candidate_reviews
    WHERE candidate_id IN (SELECT candidate_id FROM deep_write_candidates WHERE run_id IN (SELECT id FROM ${RUN}))
       OR confirmation_event_id IN (SELECT id FROM ${EVENT})`],
  ['deep_write_candidates', `DELETE FROM deep_write_candidates
    WHERE run_id IN (SELECT id FROM ${RUN}) OR ${jsonHit('evidence_json')}`],
  ['deep_write_summaries', `DELETE FROM deep_write_summaries
    WHERE ${jsonHit('source_neuron_ids_json')} OR deep_write_run_id IN (SELECT id FROM ${RUN})`],
  ['deep_write_runs', `DELETE FROM deep_write_runs
    WHERE run_id IN (SELECT id FROM ${RUN}) OR ${jsonHit('source_neuron_ids_json')}`],
  ['episode_closure_receipts', `DELETE FROM episode_closure_receipts
    WHERE episode_id IN (SELECT id FROM ${EPISODE}) OR ${jsonHit('source_event_ids_json')}`],
  ['episode_dream_jobs', `DELETE FROM episode_dream_jobs WHERE episode_id IN (SELECT id FROM ${EPISODE})`],
  ['episode_dream_attempts', `DELETE FROM episode_dream_attempts WHERE episode_id IN (SELECT id FROM ${EPISODE})`],
  ['episode_dream_runs', `DELETE FROM episode_dream_runs
    WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(episode_ids_json) THEN episode_ids_json ELSE '[]' END) WHERE value IN (SELECT id FROM ${EPISODE}))`],
  ['episode_boundary_decisions', `DELETE FROM episode_boundary_decisions WHERE primary_event_id IN (SELECT id FROM ${EVENT})`],
  ['episode_ingest_keys', `DELETE FROM episode_ingest_keys WHERE event_id IN (SELECT id FROM ${EVENT})`],
  ['episode_event_dispositions', `DELETE FROM episode_event_dispositions WHERE event_id IN (SELECT id FROM ${EVENT})`],
  ['episode_cross_refs', `DELETE FROM episode_cross_refs
    WHERE event_id IN (SELECT id FROM ${EVENT}) OR episode_id IN (SELECT id FROM ${EPISODE})`],
  ['pending_bindings', `DELETE FROM pending_bindings WHERE unit_id IN (SELECT id FROM ${UNIT})`],
  ['interaction_units', `DELETE FROM interaction_units WHERE unit_id IN (SELECT id FROM ${UNIT})`],
  ['memory_episode_events', `DELETE FROM memory_episode_events
    WHERE event_id IN (SELECT id FROM ${EVENT}) OR episode_id IN (SELECT id FROM ${EPISODE})`],
  ['memory_episodes', `DELETE FROM memory_episodes WHERE episode_id IN (SELECT id FROM ${EPISODE})`],
  ['memory_derivations', `DELETE FROM memory_derivations WHERE source_event_id IN (SELECT id FROM ${EVENT})`],
  ['memory_events_fts', `DELETE FROM memory_events_fts WHERE event_id IN (SELECT id FROM ${EVENT})`],
  ['memory_event_cjk_terms', `DELETE FROM memory_event_cjk_terms WHERE event_id IN (SELECT id FROM ${EVENT})`],
  ['memory_event_embeddings', `DELETE FROM memory_event_embeddings WHERE event_id IN (SELECT id FROM ${EVENT})`],
];

const SCOPE_RULES: ReadonlyArray<readonly [string, string]> = [
  ['session_deep_cards', `DELETE FROM session_deep_cards WHERE COALESCE(project_id,'')=?`],
  ['context_activation_receipts', `DELETE FROM context_activation_receipts WHERE COALESCE(project_id,'')=?`],
  ['context_strategy_outcomes', `DELETE FROM context_strategy_outcomes WHERE COALESCE(project_id,'')=?`],
  ['memory_action_frames', `DELETE FROM memory_action_frames WHERE COALESCE(project_id,'')=?`],
  ['episode_boundary_decisions', `DELETE FROM episode_boundary_decisions WHERE COALESCE(project_id,'')=?`],
  ['episode_closure_receipts', `DELETE FROM episode_closure_receipts WHERE COALESCE(project_id,'')=?`],
  ['episode_dream_jobs', `DELETE FROM episode_dream_jobs WHERE COALESCE(project_id,'')=?`],
  ['episode_dream_runs', `DELETE FROM episode_dream_runs WHERE COALESCE(project_id,'')=?`],
  ['episode_repair_audit', `DELETE FROM episode_repair_audit WHERE COALESCE(project_id,'')=?`],
  ['deep_write_summaries', `DELETE FROM deep_write_summaries WHERE COALESCE(project_id,'')=?`],
  ['deep_write_runs', `DELETE FROM deep_write_runs WHERE COALESCE(project_id,'')=?`],
  ['memory_atlas_access', `DELETE FROM memory_atlas_access WHERE COALESCE(project_id,'')=?`],
  ['memory_atlas_activation', `DELETE FROM memory_atlas_activation WHERE COALESCE(project_id,'')=?`],
  ['memory_atlas_projection_state', `DELETE FROM memory_atlas_projection_state WHERE COALESCE(project_id,'')=?`],
];

const KEEP = new Set([
  '_meta', '_schema_migrations', 'dream_ledger_state',
  'event_sequence_counters', 'memory_event_fts_state', 'governance_audit_log', 'soul_versions',
  'pipeline_runs', 'pipeline_step_timings', 'pipeline_nonfatal_events',
  'ingestion_source_cursors', 'ingestion_processed_records', 'import_source_anchors',
  'memory_atlas_documents', 'memory_frames', 'memory_events',
  'memory_topics',
  'project_branches', 'topology_membership', 'cognitive_nodes', 'trace_events',
  'memory_event_cjk_terms', 'memory_event_embeddings', 'memory_events_fts',
]);

const SCOPE_HANDLED = new Set([
  'entity_alias_conflicts', 'entity_instances', 'entity_merge_candidates', 'entity_resolution_log',
  'memory_entity_scope_identity', 'memory_governance_audit',
  'memory_governance_operations', 'memory_governance_plans',
  'user_session_scopes', 'user_sessions',
  'user_session_runtime', 'web_session_tokens', 'meta_proposals', 'meta_observations',
  'agent_approval_queue', 'agent_task_records', 'background_jobs', 'sandbox_snapshots',
  'graph_signals', 'plasticity_graph_edge_audit', 'plasticity_graph_edges',
  'plasticity_proposal_review_decisions', 'plasticity_proposals', 'reasoning_chains',
  'reasoning_steps', 'compiler_confidence_runs',
]);

export function assertDerivedErasureCovered(tables: readonly string[]): void {
  const declared = new Set<string>([
    ...RULES.map(([table]) => table),
    ...SCOPE_RULES.map(([table]) => table),
    ...KEEP,
    ...SCOPE_HANDLED,
  ]);
  const unknown = tables.filter((table) => {
    if (declared.has(table)) return false;
    if (/^(?:memory_events_fts|memory_atlas_fts|deep_write_summaries_fts)(?:_|$)/u.test(table)) return false;
    const classification = PRIVACY_SCHEMA_CLASSIFICATION[table];
    return classification !== 'operational_non_personal' && classification !== 'immutable_audit';
  });
  if (unknown.length > 0) throw new Error(`derived_erasure_unclassified:${unknown.sort().join(',')}`);
}

export function eraseDerivedOf(context: DerivedEraseContext): Record<string, number> {
  const db = context.db;
  const scope = context.scope ?? '';
  const wholeProject = context.wholeProject === true;
  const counts: Record<string, number> = {};
  const episodeIsView = Boolean(context.episodeIdsSource);
  const hasTable = (table: string): boolean =>
    Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table));
  const run = (table: string, sql: string, params: Array<string | number> = []): void => {
    if (!hasTable(table)) return;
    try {
      counts[table] = (counts[table] ?? 0) + Number(db.prepare(sql).run(...params).changes ?? 0);
    } catch (error) {
      if (error instanceof Error && /no such (?:table|column):/i.test(error.message)) return;
      throw error;
    }
  };

  db.exec(`
    DROP VIEW IF EXISTS ${EVENT};
    ${episodeIsView ? `DROP VIEW IF EXISTS ${EPISODE};` : `DROP TABLE IF EXISTS ${EPISODE};`}
    DROP TABLE IF EXISTS ${FRAME};
    DROP TABLE IF EXISTS ${ENTITY};
    DROP TABLE IF EXISTS ${BELIEF};
    DROP TABLE IF EXISTS ${RUN};
    DROP TABLE IF EXISTS ${UNIT};
    CREATE TEMP VIEW ${EVENT} AS SELECT id FROM ${context.eventIdsSource};
  `);
  if (context.episodeIdsSource) {
    db.exec(`CREATE TEMP VIEW ${EPISODE} AS SELECT id FROM ${context.episodeIdsSource};`);
  } else {
    db.exec(`CREATE TEMP TABLE ${EPISODE} (id TEXT PRIMARY KEY);`);
    db.prepare(`INSERT OR IGNORE INTO ${EPISODE} (id) SELECT episode_id FROM memory_episodes WHERE COALESCE(project_id,'')=?`).run(scope);
  }
  db.exec(`
    CREATE TEMP TABLE ${FRAME} (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE ${ENTITY} (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE ${BELIEF} (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE ${RUN} (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE ${UNIT} (id TEXT PRIMARY KEY);
  `);

  if (hasTable('memory_frames')) {
    db.prepare(`INSERT OR IGNORE INTO ${FRAME} (id)
      SELECT frame_id FROM memory_frames
      WHERE episode_id IN (SELECT id FROM ${EPISODE})
         OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(evidence_event_ids_json) THEN evidence_event_ids_json ELSE '[]' END) WHERE value IN (SELECT id FROM ${EVENT}))`).run();
    if (wholeProject) {
      db.prepare(`INSERT OR IGNORE INTO ${FRAME} (id) SELECT frame_id FROM memory_frames WHERE COALESCE(project_id,'')=?`).run(scope);
    }
  }
  if (hasTable('memory_bindings')) {
    db.prepare(`INSERT OR IGNORE INTO ${ENTITY} (id)
      SELECT entity_id FROM memory_bindings WHERE event_id IN (SELECT id FROM ${EVENT}) AND entity_id IS NOT NULL`).run();
  }
  if (hasTable('entity_mentions')) {
    db.prepare(`INSERT OR IGNORE INTO ${ENTITY} (id)
      SELECT entity_id FROM entity_mentions WHERE neuron_id IN (SELECT id FROM ${EVENT})`).run();
  }
  if (hasTable('entity_attributes')) {
    db.prepare(`INSERT OR IGNORE INTO ${ENTITY} (id)
      SELECT entity_id FROM entity_attributes WHERE source_neuron_id IN (SELECT id FROM ${EVENT})`).run();
  }
  if (hasTable('entity_relations')) {
    db.prepare(`INSERT OR IGNORE INTO ${ENTITY} (id)
      SELECT source_entity_id FROM entity_relations WHERE source_neuron_id IN (SELECT id FROM ${EVENT})
      UNION SELECT target_entity_id FROM entity_relations WHERE source_neuron_id IN (SELECT id FROM ${EVENT})`).run();
  }
  if (hasTable('entity_instances')) {
    db.prepare(`INSERT OR IGNORE INTO ${ENTITY} (id)
      SELECT instance_id FROM entity_instances WHERE created_from IN (SELECT id FROM ${EVENT})
      UNION SELECT canonical_entity_id FROM entity_instances WHERE created_from IN (SELECT id FROM ${EVENT})`).run();
  }
  if (hasTable('entity_mentions') && hasTable('memory_bindings')) {
    db.prepare(`DELETE FROM ${ENTITY}
      WHERE EXISTS (SELECT 1 FROM entity_mentions m WHERE m.entity_id=${ENTITY}.id AND (m.neuron_id IS NULL OR m.neuron_id NOT IN (SELECT id FROM ${EVENT})))
         OR EXISTS (SELECT 1 FROM memory_bindings b WHERE b.entity_id=${ENTITY}.id AND b.event_id NOT IN (SELECT id FROM ${EVENT}))`).run();
  }
  if (hasTable('belief_graph_evidence')) {
    db.prepare(`INSERT OR IGNORE INTO ${BELIEF} (id)
      SELECT belief_id FROM belief_graph_evidence WHERE event_id IN (SELECT id FROM ${EVENT})`).run();
  }
  if (hasTable('beliefs')) {
    db.prepare(`INSERT OR IGNORE INTO ${BELIEF} (id)
      SELECT id FROM beliefs WHERE source_event_id IN (SELECT id FROM ${EVENT}) OR source_neuron_id IN (SELECT id FROM ${EVENT})`).run();
  }
  if (hasTable('deep_write_runs')) {
    db.prepare(`INSERT OR IGNORE INTO ${RUN} (id)
      SELECT run_id FROM deep_write_runs
      WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(source_neuron_ids_json) THEN source_neuron_ids_json ELSE '[]' END) WHERE value IN (SELECT id FROM ${EVENT}))
         OR source_episode_id IN (SELECT id FROM ${EPISODE})`).run();
  }
  if (hasTable('deep_write_candidates')) {
    db.prepare(`INSERT OR IGNORE INTO ${RUN} (id)
      SELECT run_id FROM deep_write_candidates
      WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '[]' END) WHERE value IN (SELECT id FROM ${EVENT}))`).run();
  }
  if (hasTable('interaction_units')) {
    db.prepare(`INSERT OR IGNORE INTO ${UNIT} (id)
      SELECT unit_id FROM interaction_units
      WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(message_neuron_ids_json) THEN message_neuron_ids_json ELSE '[]' END) WHERE value IN (SELECT id FROM ${EVENT}))`).run();
  }

  if (hasTable('memory_derivations')) {
    for (const kind of LINEAGE_TABLES) {
      const primaryKey = (db.prepare(`PRAGMA table_info("${kind}")`).all() as Array<{ name: string; pk: number }>)
        .find((column) => column.pk === 1)?.name;
      if (!primaryKey) continue;
      run(kind, `DELETE FROM ${kind}
        WHERE "${primaryKey}" IN (
          SELECT derived_id FROM memory_derivations
          WHERE derived_kind=? AND source_event_id IN (SELECT id FROM ${EVENT})
        )`, [kind]);
    }
  }
  for (const [table, sql] of RULES) run(table, sql);
  if (wholeProject) {
    for (const [table, sql] of SCOPE_RULES) run(table, sql, [scope]);
    run('memory_topics', `DELETE FROM memory_topics WHERE COALESCE(project_id,'')=?`, [scope]);
  } else if (hasTable('memory_topics') && hasTable('memory_bindings') && hasTable('memory_clusters')) {
    run('memory_topics', `DELETE FROM memory_topics
      WHERE COALESCE(project_id,'')=?
        AND NOT EXISTS (SELECT 1 FROM memory_bindings b WHERE b.topic_path=memory_topics.topic_path AND COALESCE(b.project_id,'')=?)
        AND NOT EXISTS (SELECT 1 FROM memory_clusters c WHERE c.topic_path=memory_topics.topic_path AND COALESCE(c.project_id,'')=?)`,
    [scope, scope, scope]);
  }

  db.exec(`
    DROP VIEW IF EXISTS ${EVENT};
    ${episodeIsView ? `DROP VIEW IF EXISTS ${EPISODE};` : `DROP TABLE IF EXISTS ${EPISODE};`}
    DROP TABLE IF EXISTS ${FRAME};
    DROP TABLE IF EXISTS ${ENTITY};
    DROP TABLE IF EXISTS ${BELIEF};
    DROP TABLE IF EXISTS ${RUN};
    DROP TABLE IF EXISTS ${UNIT};
  `);
  return counts;
}

export function gcInvalidatedAtlasRows(db: Database, scope: string): void {
  for (const [table, column] of [
    ['memory_atlas_supports', 'status'],
    ['memory_atlas_alias_supports', 'status'],
    ['memory_atlas_aliases', 'status'],
    ['memory_edge_supports', 'support_status'],
  ] as const) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE COALESCE(project_id,'')=? AND ${column}='invalidated'`).run(scope);
    } catch (error) {
      if (error instanceof Error && /no such (?:table|column):/i.test(error.message)) continue;
      throw error;
    }
  }
}

import { createHash } from 'node:crypto';
import type Database from 'bun:sqlite';
import {
  memoryEdgeId,
  memoryEntityId,
} from '../../binding/MemoryBindingIdentity.js';
import { mergeMemoryEdge } from '../../binding/MemoryEdgeMerge.js';
import {
  FINAL_AUXILIARY_OBJECTS,
  FINAL_TABLES,
  type FinalSchemaObject,
} from './FinalSchemaDefinition.js';
import { tableExists } from '../../utils/Values.js';

/**
 * Install the 4.0 final schema in a database that has none.
 *
 * Moved here from `0032_multidimensional_memory_graph_3_7_4.ts`, which was the
 * migration that also carried the 3.x upgrade path. This is only the part a new
 * database needs; the upgrade helpers that lived beside it are gone, and the
 * schema it produces is verified object-for-object against the old installer's
 * output (the pinned digest lives in `__tests__/schema-migration.unit.test.ts`).
 *
 * The postcondition check at the end is not decoration: it is what notices a
 * projection or auxiliary object that failed to install, and it runs on every
 * creation.
 */
export function installFinalSchema(db: Database): void {
  db.exec('PRAGMA defer_foreign_keys=ON; PRAGMA legacy_alter_table=ON');
  const preservedAuxiliaryObjects = detachAuxiliaryObjects(db);
  resetFreshBootstrap(db);
  installMissingFinalTables(db);
  dropRebuildableProjections(db);
  installMissingFinalTables(db);
  initializeProjectionState(db);
  installFinalAuxiliaryObjects(db);
  restoreAuxiliaryObjects(db, preservedAuxiliaryObjects);
  db.exec('DROP TABLE IF EXISTS _cogmem_bootstrap_state; PRAGMA legacy_alter_table=OFF');
  const issue = multidimensionalMemoryGraph374Issue(db);
  if (issue) throw new Error(`multidimensional_memory_graph_3_7_4_postcondition_failed:${issue}`);
}

const REBUILDABLE_PROJECTIONS = [
  'memory_atlas_fts',
  'memory_atlas_access',
  'memory_atlas_activation',
  'memory_atlas_documents',
  'memory_atlas_projection_state',
  'memory_action_frame_evidence',
  'memory_action_frames',
] as const;

export function multidimensionalMemoryGraph374Issue(db: Database): string | undefined {
  for (const object of FINAL_TABLES) {
    const actual = schemaSql(db, 'table', object.name);
    if (!actual) return `table_missing:${object.name}`;
    if (normalizeTableSql(actual) !== normalizeTableSql(object.sql)) return `table_definition:${object.name}`;
  }
  for (const object of FINAL_AUXILIARY_OBJECTS) {
    const actual = schemaSql(db, object.type, object.name);
    if (!actual) return `${object.type}_missing:${object.name}`;
    if (normalizeSql(actual) !== normalizeSql(object.sql)) return `${object.type}_definition:${object.name}`;
  }
  if (tableExists(db, 'memory_events') && db.prepare(`
    SELECT 1 FROM memory_events WHERE project_scope<>COALESCE(project_id,'') LIMIT 1
  `).get()) return 'memory_event_scope';
  if (tableExists(db, 'entity_aliases') && db.prepare(`
    SELECT 1 FROM entity_aliases a
    WHERE NOT EXISTS (
      SELECT 1 FROM entity_instances i
      WHERE i.instance_id=a.entity_id
        AND (
          json_extract(i.metadata_json,'$.projectId')=a.project_id
          OR EXISTS (
            SELECT 1 FROM entity_mentions m
            WHERE m.entity_id=a.entity_id AND COALESCE(m.project_id,'')=a.project_id
          )
        )
    ) LIMIT 1
  `).get()) return 'entity_alias_scope';
  if (tableExists(db, 'memory_action_frames') && db.prepare(`
    SELECT 1 FROM memory_action_frames a
    WHERE a.target_entity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM memory_entities e
      WHERE e.entity_id=a.target_entity_id
        AND COALESCE(e.project_id,'')=a.project_id
    ) LIMIT 1
  `).get()) return 'memory_action_target';
  if (tableExists(db, 'memory_edges')) {
    const seen = new Set<string>();
    for (const row of db.prepare(`
      SELECT edge_id,COALESCE(project_id,'') AS project_id,source_type,source_id,
        relation_type,target_type,target_id,source_authority
      FROM memory_edges
    `).all() as Array<{
      edge_id: string;
      project_id: string;
      source_type: string;
      source_id: string;
      relation_type: string;
      target_type: string;
      target_id: string;
      source_authority: string;
    }>) {
      const expected = memoryEdgeId({
        projectId: row.project_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        relationType: row.relation_type,
        targetType: row.target_type,
        targetId: row.target_id,
      });
      if (row.edge_id !== expected || seen.has(expected)) return 'memory_edge_identity';
      if (!memoryEndpointMatchesScope(db, row.source_type, row.source_id, row.project_id, row.source_authority)
        || !memoryEndpointMatchesScope(db, row.target_type, row.target_id, row.project_id, row.source_authority)) {
        return 'memory_edge_endpoint_scope';
      }
      seen.add(expected);
    }
    if (!tableExists(db, 'memory_edge_supports') || db.prepare(`
      SELECT 1 FROM memory_edges e
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_edge_supports s
        WHERE s.edge_id=e.edge_id AND s.support_status='active'
      ) LIMIT 1
    `).get()) return 'memory_edge_support_projection';
    if (db.prepare(`
      SELECT 1 FROM memory_edge_supports s
      WHERE s.support_status='active' AND NOT EXISTS (
        SELECT 1 FROM memory_edges e WHERE e.edge_id=s.edge_id
      ) LIMIT 1
    `).get()) return 'memory_edge_support_orphan';
    for (const support of db.prepare(`SELECT * FROM memory_edge_supports`).all() as Array<Record<string, unknown>>) {
      const scope = String(support.project_id ?? '');
      const expected = memoryEdgeId({
        projectId: scope,
        sourceType: String(support.source_type),
        sourceId: String(support.source_id),
        relationType: String(support.relation_type),
        targetType: String(support.target_type),
        targetId: String(support.target_id),
      });
      if (String(support.edge_id) !== expected) return 'memory_edge_support_identity';
      const evidence = parseEvidenceIds(support.evidence_event_ids_json);
      if (!evidence || evidence.some((eventId) => !recordMatchesScope(db, 'memory_events', 'event_id', eventId, scope))) {
        return 'memory_edge_support_evidence';
      }
    }
  }
  if (tableExists(db, 'memory_entity_scope_identity') && db.prepare(`
    SELECT 1 FROM memory_entity_scope_identity m
    LEFT JOIN memory_entities e ON e.entity_id=m.scoped_entity_id
    WHERE e.entity_id IS NULL OR COALESCE(e.project_id,'')<>m.project_id OR e.entity_type<>m.entity_type
    LIMIT 1
  `).get()) return 'memory_entity_scope_identity';
  if (tableExists(db, 'memory_bindings')) {
    for (const row of db.prepare(`SELECT * FROM memory_bindings`).all() as MemoryBindingMigrationRow[]) {
      if (memoryBindingReferenceIssue(db, row)) return 'memory_binding_reference_scope';
    }
  }
  if (tableExists(db, 'pending_entity_resolution')) {
    for (const row of db.prepare(`
      SELECT pending_id,project_scope,resolved_entity_id,status
      FROM pending_entity_resolution WHERE status='resolved'
    `).all() as Array<{ pending_id: string; project_scope: string; resolved_entity_id: string | null; status: string }>) {
      if (!row.resolved_entity_id || !entityVisibleInScope(db, row.resolved_entity_id, row.project_scope)) {
        return 'pending_entity_resolved_scope';
      }
    }
  }
  return undefined;
}

function installMissingFinalTables(db: Database): void {
  for (const object of FINAL_TABLES) {
    if (tableExists(db, object.name)) continue;
    db.exec(withIfNotExists(object.sql));
  }
}

type MemoryBindingMigrationRow = Record<string, unknown> & {
  binding_id: string;
  project_id?: string | null;
  event_id: string;
  topic_path: string;
  entity_id?: string | null;
  cluster_id?: string | null;
  related_event_ids_json?: string | null;
};

function memoryBindingReferenceIssue(db: Database, row: MemoryBindingMigrationRow): string | undefined {
  const scope = String(row.project_id ?? '');
  if (!recordMatchesScope(db, 'memory_events', 'event_id', String(row.event_id), scope)) return 'memory_binding_event_scope_mismatch';
  if (!recordMatchesScope(db, 'memory_topics', 'topic_path', String(row.topic_path), scope)) return 'memory_binding_topic_scope_mismatch';
  if (row.entity_id != null && !recordMatchesScope(db, 'memory_entities', 'entity_id', String(row.entity_id), scope)) return 'memory_binding_entity_scope_mismatch';
  if (row.cluster_id != null) {
    const cluster = db.prepare(`
      SELECT topic_path FROM memory_clusters
      WHERE cluster_id=? AND COALESCE(project_id,'')=?
    `).get(String(row.cluster_id), scope) as { topic_path: string } | null;
    if (!cluster) return 'memory_binding_cluster_scope_mismatch';
    if (cluster.topic_path !== String(row.topic_path)) return 'memory_binding_cluster_topic_mismatch';
  }
  const related = parseEvidenceIds(row.related_event_ids_json);
  if (!related) return 'memory_binding_related_events_malformed';
  if (related.some((eventId) => !recordMatchesScope(db, 'memory_events', 'event_id', eventId, scope))) return 'memory_binding_related_event_scope_mismatch';
  return undefined;
}

function memoryEndpointMatchesScope(
  db: Database,
  type: string,
  id: string,
  scope: string,
  authority: string,
): boolean {
  if (authority === 'atlas_curator' || authority === 'memory_frame_projector') {
    return tableExists(db, 'memory_atlas_documents') && Boolean(db.prepare(`
      SELECT 1 FROM memory_atlas_documents
      WHERE project_id=? AND node_id=? AND status NOT IN ('rejected','archived','needs_confirmation')
    `).get(scope, atlasNodeId(type, id, scope)));
  }
  if (!['raw_evidence', 'governed_projection', 'model_candidate'].includes(authority)) return false;
  if (type === 'event' || type === 'raw_event') return recordMatchesScope(db, 'memory_events', 'event_id', id, scope);
  if (type === 'episode') return recordMatchesScope(db, 'memory_episodes', 'episode_id', id, scope);
  if (type === 'entity') return recordMatchesScope(db, 'memory_entities', 'entity_id', id, scope);
  if (type === 'topic') return recordMatchesScope(db, 'memory_topics', 'topic_path', id, scope);
  if (type === 'cluster') return recordMatchesScope(db, 'memory_clusters', 'cluster_id', id, scope);
  return false;
}

const PROJECT_SCOPED_ATLAS_NODE_TYPES = new Set([
  'topic', 'time', 'issue', 'session', 'thread', 'memoryKind', 'actionKind',
]);

function atlasNodeId(type: string, id: string, scope: string): string {
  if (type === 'entity' && id.startsWith('facet:')) return `entity:${scope}:${id}`;
  return PROJECT_SCOPED_ATLAS_NODE_TYPES.has(type)
    ? `${type}:${scope}:${id}`
    : `${type}:${id}`;
}

function recordMatchesScope(
  db: Database,
  table: string,
  idColumn: string,
  id: string,
  scope: string,
): boolean {
  if (!tableExists(db, table)) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM ${quoteIdentifier(table)}
    WHERE ${quoteIdentifier(idColumn)}=? AND COALESCE(project_id,'')=?
  `).get(id, scope));
}

function parseEvidenceIds(value: unknown): string[] | null {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? [...new Set(parsed.filter(Boolean))]
      : null;
  } catch {
    return null;
  }
}

function scopeForProjectRecord(
  db: Database,
  table: string,
  idColumn: string,
  id: string,
): string[] | null {
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`
    SELECT COALESCE(project_id,'') AS scope FROM ${quoteIdentifier(table)}
    WHERE ${quoteIdentifier(idColumn)}=?
  `).get(id) as { scope: string } | null;
  return row ? [row.scope] : null;
}

function dropRebuildableProjections(db: Database): void {
  if (tableExists(db, 'memory_edge_supports')) db.exec(`
    DELETE FROM memory_edge_supports
    WHERE source_authority IN ('atlas_curator','memory_frame_projector')
  `);
  if (tableExists(db, 'memory_edges')) db.exec(`
    DELETE FROM memory_edges
    WHERE source_authority IN ('atlas_curator','memory_frame_projector')
  `);
  for (const table of REBUILDABLE_PROJECTIONS) db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
}

function initializeProjectionState(db: Database): void {
  const now = Date.now();
  if (tableExists(db, 'memory_atlas_projection_state')) {
    db.exec(`
      INSERT OR REPLACE INTO memory_atlas_projection_state(
        project_id,projection_name,status,metadata_json,projection_version
      )
      SELECT DISTINCT COALESCE(project_id,''),'memory_atlas.v2','dirty','{}','v2'
      FROM memory_events WHERE event_type='RAW_EVENT_RECORDED'
    `);
  }
}

function detachAuxiliaryObjects(db: Database): string[] {
  const owned = new Set(FINAL_AUXILIARY_OBJECTS.map((object) => object.name));
  const rows = db.prepare(`
    SELECT type,name,sql FROM sqlite_master
    WHERE type IN ('view','trigger','index') AND sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
    ORDER BY CASE type WHEN 'view' THEN 0 WHEN 'trigger' THEN 1 ELSE 2 END
  `).all() as Array<{ type: 'view' | 'trigger' | 'index'; name: string; sql: string }>;
  for (const row of rows) db.exec(`DROP ${row.type.toUpperCase()} IF EXISTS ${quoteIdentifier(row.name)}`);
  return rows.filter((row) => !owned.has(row.name)).map((row) => row.sql);
}

function restoreAuxiliaryObjects(db: Database, sql: string[]): void {
  for (const statement of sql) db.exec(statement);
}

function resetFreshBootstrap(db: Database): void {
  if (!tableExists(db, '_cogmem_bootstrap_state')) return;
  const tables = db.prepare(`
    SELECT name,sql FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_cogmem_bootstrap_state','_schema_migrations')
    ORDER BY CASE WHEN sql LIKE 'CREATE VIRTUAL TABLE%' THEN 0 ELSE 1 END,name
  `).all() as Array<{ name: string; sql?: string }>;
  for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`);
}

function installFinalAuxiliaryObjects(db: Database): void {
  for (const object of FINAL_AUXILIARY_OBJECTS) db.exec(object.sql);
}

function entityScopes(db: Database, entityId: string): string[] {
  const scopes = new Set<string>();
  if (tableExists(db, 'entity_instances')) {
    const row = db.prepare(`
      SELECT json_extract(metadata_json,'$.projectId') AS project_id
      FROM entity_instances WHERE instance_id=?
    `).get(entityId) as { project_id?: string | null } | null;
    if (typeof row?.project_id === 'string') scopes.add(row.project_id);
  }
  if (tableExists(db, 'entity_mentions')) {
    for (const row of db.prepare(`
      SELECT DISTINCT COALESCE(project_id,'') AS project_id
      FROM entity_mentions WHERE entity_id=?
    `).all(entityId) as Array<{ project_id: string }>) scopes.add(row.project_id);
  }
  return [...scopes].sort();
}

function entityVisibleInScope(db: Database, entityId: string, scope: string): boolean {
  if (!tableExists(db, 'entity_instances') || !db.prepare(`
    SELECT 1 FROM entity_instances WHERE instance_id=? AND status='active'
  `).get(entityId)) return false;
  return entityScopes(db, entityId).includes(scope);
}

function schemaSql(db: Database, type: string, name: string): string | undefined {
  return (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type=? AND name=?
  `).get(type, name) as { sql?: string } | null)?.sql;
}

function normalizeTableSql(sql: string): string {
  return normalizeSql(sql)
    .replace(/^create virtual table [^ (]+/i, 'create virtual table')
    .replace(/^create table [^ (]+/i, 'create table');
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\bIF NOT EXISTS\b/gi, '')
    .replace(/["'`\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .trim()
    .toLowerCase();
}

function withIfNotExists(sql: string): string {
  return sql
    .replace(/^CREATE VIRTUAL TABLE\s+/i, 'CREATE VIRTUAL TABLE IF NOT EXISTS ')
    .replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

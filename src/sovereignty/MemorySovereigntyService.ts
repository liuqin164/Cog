/**
 * Memory sovereignty (#163, F9): the owner's controls over what is recorded, what is forgotten by
 * time, what leaves the machine, and what the control actions themselves left behind.
 *
 * Three of the four are deliberately small:
 *
 * - **Pause** is a kernel state, checked where the ledger is appended. A paused project writes no
 *   raw row at all; the host is refused rather than handed a filtered result later.
 * - **Range deletion** removes the ledger rows in a half-open window, the compiled-book rows whose
 *   `sourceRefs` point into that window, and the graph/episodes derived from them, then recompiles
 *   the books and rebuilds the Atlas from what is left.
 * - **Export** is a Markdown archive read from the current ledger and books, never a database dump.
 *
 * Every action writes one `governance_audit_log` row. The audit row carries the range, the counts
 * and the time; it never carries the deleted text or the exported content.
 *
 * The written contract is `docs/memory-sovereignty.md`.
 */
import type Database from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CommitmentBook } from '../commitment/CommitmentBook.js';
import type { ProcedureCompiler } from '../procedure/ProcedureCompiler.js';
import type { ProfileCompiler, ProfileEntry } from '../profile/ProfileCompiler.js';
import { eventLifeSensitivityTier } from '../security/LifeSensitivity.js';
import { eventHoldsSecretMark } from '../security/SecretMarks.js';
import type { EventStore } from '../store/EventStore.js';
import type { MemoryEvent, MemorySourceRef } from '../types/index.js';
import { projectScope } from '../topology/ProjectScope.js';

export const SOVEREIGNTY_CONTRACT_VERSION = 1;

/** The control actions this face records. Frozen by the contract document. */
export const SOVEREIGNTY_ACTIONS = [
  'pause_recording',
  'resume_recording',
  'delete_range',
  'export_archive',
] as const;
export type SovereigntyAction = (typeof SOVEREIGNTY_ACTIONS)[number];

/** The methods on the face. Frozen by the contract document. */
export const SOVEREIGNTY_API_METHODS = ['status', 'pause', 'resume', 'deleteRange', 'exportArchive', 'audit'] as const;

/** The fields an audit read returns. Frozen. */
export const SOVEREIGNTY_AUDIT_FIELDS = [
  'auditId',
  'action',
  'projectId',
  'range',
  'counts',
  'createdAt',
] as const;

/** The fields the pause status read returns. Frozen. */
export const SOVEREIGNTY_STATUS_FIELDS = ['projectId', 'paused', 'since'] as const;

/** The sections every exported archive carries, in order. Frozen. */
export const SOVEREIGNTY_EXPORT_SECTIONS = [
  'Conversations',
  'Profile',
  'Procedures',
  'Commitments',
  'Memory graph',
] as const;

/** The counts a range deletion reports. Frozen. */
export const SOVEREIGNTY_DELETE_COUNT_FIELDS = [
  'events',
  'derivedEntries',
  'entryVersions',
  'facts',
  'beliefs',
  'entityMentions',
  'episodes',
  'frames',
  'projectBranches',
  'topologyMembership',
  'interactionUnits',
  'pendingBindings',
  'cognitiveNodes',
  'traceEvents',
] as const;

/** The counts an export reports. Frozen. */
export const SOVEREIGNTY_EXPORT_COUNT_FIELDS = [
  'events',
  'profile',
  'procedures',
  'commitments',
  'graph',
] as const;

/** The refusals this face names. Frozen. */
export const SOVEREIGNTY_ERROR_CODES = [
  'project_id_required',
  'recording_paused',
  'invalid_sovereignty_range',
  'invalid_sovereignty_path',
  'invalid_limit',
] as const;
export type SovereigntyErrorCode = (typeof SOVEREIGNTY_ERROR_CODES)[number];

export interface SovereigntyStatus {
  projectId: string;
  paused: boolean;
  since?: number;
}

export interface SovereigntyAuditRecord {
  auditId: string;
  action: SovereigntyAction | string;
  projectId: string;
  range: { start: number; end: number };
  counts: Record<string, number>;
  createdAt: number;
}

export interface SovereigntyDeleteInput {
  projectId: string;
  start: number;
  end: number;
  reason?: string;
}

export interface SovereigntyDeleteResult extends SovereigntyDeleteInput {
  auditId: string;
  deleted: Record<string, number>;
  artifacts: SovereigntyArtifactCoverage;
}

/**
 * The copies outside the live database that a range deletion handled. The receipt states these
 * numbers and what stayed out of reach, so "deleted" never means more than it did.
 */
export interface SovereigntyArtifactCoverage {
  snapshotsRemoved: number;
  archivesRemoved: number;
  exportsRemoved: number;
  snapshotsScanned: number;
  exportsScanned: number;
  notCovered: string[];
}

export interface SovereigntyExportInput {
  projectId: string;
  outputPath: string;
}

export interface SovereigntyExportResult {
  projectId: string;
  path: string;
  counts: Record<string, number>;
  bytes: number;
  auditId: string;
}

export interface MemorySovereigntyPorts {
  db: Database;
  events: EventStore;
  profile: ProfileCompiler;
  procedures: ProcedureCompiler;
  commitments: CommitmentBook;
  /** Nightly snapshots and weekly archives; unset means this kernel writes none. */
  snapshotsDir?: string;
  /** Markdown exports written by `/export`; unset means none are scanned. */
  exportsDir?: string;
  rebuildAtlas?: (projectId: string) => unknown;
  now?: () => number;
}

function error(code: SovereigntyErrorCode, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code);
}

function requiredProject(projectId: string | undefined): string {
  if (typeof projectId !== 'string' || (projectId !== '' && projectId.trim() === '')) {
    throw error('project_id_required');
  }
  return projectScope(projectId);
}

function refsOf(payload: unknown): string[] {
  const out: string[] = [];
  const sourceRefs = (payload as { sourceRefs?: unknown } | undefined)?.sourceRefs;
  if (Array.isArray(sourceRefs)) {
    for (const ref of sourceRefs) {
      const eventId = (ref as { eventId?: unknown } | undefined)?.eventId;
      if (typeof eventId === 'string') out.push(eventId);
    }
  }
  const evidence = (payload as { evidenceEventIds?: unknown } | undefined)?.evidenceEventIds;
  if (Array.isArray(evidence)) {
    for (const eventId of evidence) if (typeof eventId === 'string') out.push(eventId);
  }
  return out;
}

function eventText(event: MemoryEvent): string {
  const text = (event.payload as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

function iso(ms: number): string {
  const value = new Date(ms);
  return Number.isFinite(value.getTime()) ? value.toISOString() : String(ms);
}

function sensitivityLabel(event: MemoryEvent): string | undefined {
  const labels: string[] = [];
  if (eventHoldsSecretMark(event)) labels.push('secret');
  const tier = eventLifeSensitivityTier(event);
  if (tier) labels.push(`life-sensitivity: ${tier}`);
  return labels.length ? labels.join(', ') : undefined;
}

function entrySensitivity(refs: readonly MemorySourceRef[], events: EventStore): string | undefined {
  const labels = new Set<string>();
  for (const ref of refs) {
    if (!ref.eventId) continue;
    const event = events.getEvent(ref.eventId);
    if (!event) continue;
    const label = sensitivityLabel(event);
    if (label) labels.add(label);
  }
  return labels.size ? [...labels].join(', ') : undefined;
}

function sourceLabel(refs: readonly MemorySourceRef[]): string | undefined {
  const ids = refs.map((ref) => ref.eventId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length ? ids.slice(0, 3).join(', ') : undefined;
}

export class MemorySovereigntyService {
  private readonly now: () => number;

  constructor(private readonly ports: MemorySovereigntyPorts) {
    this.now = ports.now ?? (() => Date.now());
    this.ensureAuditTable();
  }

  /** Whether the project is paused. The write path asks this before appending a raw row. */
  recordingPaused(projectId: string | undefined): boolean {
    const scope = projectScope(projectId);
    return this.readPause(scope) !== undefined;
  }

  status(projectId: string): SovereigntyStatus {
    const scope = requiredProject(projectId);
    const pause = this.readPause(scope);
    return { projectId: scope, paused: pause !== undefined, since: pause?.pausedAt };
  }

  pause(projectId: string, reason?: string): SovereigntyStatus {
    const scope = requiredProject(projectId);
    if (this.readPause(scope)) return this.status(scope);
    const pausedAt = this.now();
    this.ports.db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`)
      .run(this.pauseKey(scope), JSON.stringify({ pausedAt, reason }));
    this.writeAudit('pause_recording', scope, { start: pausedAt, end: pausedAt, counts: {} }, reason);
    return { projectId: scope, paused: true, since: pausedAt };
  }

  resume(projectId: string): SovereigntyStatus {
    const scope = requiredProject(projectId);
    const pause = this.readPause(scope);
    if (!pause) return this.status(scope);
    this.ports.db.prepare(`DELETE FROM _meta WHERE key=?`).run(this.pauseKey(scope));
    const resumedAt = this.now();
    this.writeAudit('resume_recording', scope, {
      start: pause.pausedAt,
      end: resumedAt,
      counts: { pausedMs: Math.max(0, resumedAt - pause.pausedAt) },
    });
    return { projectId: scope, paused: false };
  }

  /**
   * Delete one half-open window. The ledger rows in `[start, end)` go first; every compiled-book
   * row whose `sourceRefs` names one of those events goes with the whole entry stream; facts,
   * beliefs, neurons, episodes and graph documents derived from the window are removed; then the
   * books recompile and the Atlas rebuilds from what remains.
   */
  deleteRange(input: SovereigntyDeleteInput): SovereigntyDeleteResult {
    const scope = requiredProject(input.projectId);
    if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start >= input.end) {
      throw error('invalid_sovereignty_range');
    }
    // Range ids, not range events: a decade-size window is 200k rows, and holding every parsed
    // payload to delete them is what took the resident toward MemoryMax. The scan stays paged.
    const rangeIds = new Set<string>();
    let earliestRecordedAt = input.start;
    this.eachEvent(scope, (event) => {
      if (event.occurredAt < input.start || event.occurredAt >= input.end) return;
      rangeIds.add(event.eventId);
      earliestRecordedAt = Math.min(earliestRecordedAt, event.createdAt ?? event.occurredAt);
    }, { startTime: input.start, endTime: input.end });
    const derived: MemoryEvent[] = [];
    this.eachEvent(scope, (event) => {
      if (!rangeIds.has(event.eventId) && refsOf(event.payload).some((id) => rangeIds.has(id))) derived.push(event);
    });
    const entryStreams = new Set(derived.map((event) => event.streamId).filter((streamId) => (
      streamId.startsWith('profile-entry:') || streamId.startsWith('procedure-entry:') || streamId.startsWith('commitment:')
    )));
    const streamRows: MemoryEvent[] = [];
    if (entryStreams.size > 0) {
      this.eachEvent(scope, (event) => {
        if (entryStreams.has(event.streamId)) streamRows.push(event);
      });
    }
    const deleteIds = new Set([...rangeIds, ...derived.map((event) => event.eventId), ...streamRows.map((event) => event.eventId)]);
    const deleted = Object.fromEntries(SOVEREIGNTY_DELETE_COUNT_FIELDS.map((field) => [field, 0])) as Record<string, number>;
    deleted.events = rangeIds.size;
    deleted.derivedEntries = derived.length;
    deleted.entryVersions = streamRows.length;
    const artifacts: SovereigntyArtifactCoverage = {
      snapshotsRemoved: 0,
      archivesRemoved: 0,
      exportsRemoved: 0,
      snapshotsScanned: 0,
      exportsScanned: 0,
      notCovered: ['数据目录之外的导出文件', '已复制到其他机器的备份'],
    };
    if (deleteIds.size === 0) {
      const auditId = this.writeAudit('delete_range', scope, { start: input.start, end: input.end, counts: deleted, artifacts }, input.reason);
      return { ...input, projectId: scope, auditId, deleted, artifacts };
    }

    // The live database is rewritten, not only logically emptied: without secure_delete the
    // deleted text stays in freelist pages, and without VACUUM it stays in pages that the table
    // b-trees no longer reference. This is the same filesystem contract as `forgetUser`.
    this.ports.db.exec(`PRAGMA secure_delete = ON`);
    // Temporary id sets keep every statement in this deletion below SQLite's variable limit. A
    // 200k-row window would otherwise need a 200k-parameter `IN (...)`, which is both slow and
    // above the limit on some builds.
    this.ports.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS _sovereignty_event_ids (id TEXT PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS _sovereignty_episode_ids (id TEXT PRIMARY KEY);
    `);
    try {
      const insertEventId = this.ports.db.prepare(`INSERT OR IGNORE INTO _sovereignty_event_ids (id) VALUES (?)`);
      this.ports.db.transaction(() => {
        for (const id of deleteIds) insertEventId.run(id);
      })();
      const episodeRows = this.episodesInRange(scope, input.start, input.end);
      const episodeIds = new Set(episodeRows.map((row) => row.episodeId));
      const insertEpisodeId = this.ports.db.prepare(`INSERT OR IGNORE INTO _sovereignty_episode_ids (id) VALUES (?)`);
      this.ports.db.transaction(() => {
        for (const id of episodeIds) insertEpisodeId.run(id);
      })();
      if (episodeIds.size === 0) {
        deleted.episodes = 0;
        deleted.frames = 0;
      }

      this.ports.db.transaction(() => {
      this.deleteIfTable('memory_events_fts', `DELETE FROM memory_events_fts WHERE event_id IN (SELECT id FROM _sovereignty_event_ids)`, []);
      deleted.neurons = 0;
      deleted.synapses = 0;
      deleted.facts = this.runDelete(`DELETE FROM facts WHERE neuron_id IN (SELECT id FROM _sovereignty_event_ids)`, []);
      deleted.beliefs = this.runDelete(`DELETE FROM beliefs WHERE source_event_id IN (SELECT id FROM _sovereignty_event_ids) OR source_neuron_id IN (SELECT id FROM _sovereignty_event_ids)`, []);
      deleted.entityMentions = this.runDelete(`DELETE FROM entity_mentions WHERE neuron_id IN (SELECT id FROM _sovereignty_event_ids)`, []);
      if (episodeIds.size > 0) {
        this.runDelete(`DELETE FROM memory_episode_events WHERE episode_id IN (SELECT id FROM _sovereignty_episode_ids) OR event_id IN (SELECT id FROM _sovereignty_event_ids)`, []);
        this.deleteIfTable('memory_frame_reviews', `DELETE FROM memory_frame_reviews WHERE frame_id IN (SELECT frame_id FROM memory_frames WHERE episode_id IN (SELECT id FROM _sovereignty_episode_ids))`, []);
        this.deleteIfTable('memory_frame_relations', `DELETE FROM memory_frame_relations WHERE frame_id IN (SELECT frame_id FROM memory_frames WHERE episode_id IN (SELECT id FROM _sovereignty_episode_ids))`, []);
        this.deleteIfTable('memory_frame_nodes', `DELETE FROM memory_frame_nodes WHERE frame_id IN (SELECT frame_id FROM memory_frames WHERE episode_id IN (SELECT id FROM _sovereignty_episode_ids))`, []);
        deleted.frames = this.deleteIfTable('memory_frames', `DELETE FROM memory_frames WHERE episode_id IN (SELECT id FROM _sovereignty_episode_ids)`, []);
        deleted.episodes = this.runDelete(`DELETE FROM memory_episodes WHERE episode_id IN (SELECT id FROM _sovereignty_episode_ids)`, []);
      }
      this.deleteIfTable('memory_atlas_documents',
        `DELETE FROM memory_atlas_documents WHERE project_id=? AND (
           source_id IN (SELECT id FROM _sovereignty_event_ids)
           OR EXISTS (SELECT 1 FROM json_each(evidence_event_ids_json) WHERE value IN (SELECT id FROM _sovereignty_event_ids))
         )`,
        [scope]);
      deleted.projectBranches = this.deleteIfTable('project_branches', `DELETE FROM project_branches WHERE project_id=?`, [scope]);
      deleted.topologyMembership = this.deleteIfTable('topology_membership',
        `DELETE FROM topology_membership WHERE neuron_id IN (SELECT id FROM _sovereignty_event_ids) OR COALESCE(project_id,'')=?`,
        [scope]);
      deleted.pendingBindings = this.deleteIfTable('pending_bindings',
        `DELETE FROM pending_bindings WHERE unit_id IN (
           SELECT unit_id FROM interaction_units WHERE json_valid(message_neuron_ids_json) AND EXISTS (
             SELECT 1 FROM json_each(message_neuron_ids_json) WHERE value IN (SELECT id FROM _sovereignty_event_ids)
           )
         )`,
        []);
      deleted.interactionUnits = this.deleteIfTable('interaction_units',
        `DELETE FROM interaction_units WHERE json_valid(message_neuron_ids_json) AND EXISTS (
           SELECT 1 FROM json_each(message_neuron_ids_json) WHERE value IN (SELECT id FROM _sovereignty_event_ids)
         )`,
        []);
      deleted.cognitiveNodes = this.deleteIfTable('cognitive_nodes',
        `DELETE FROM cognitive_nodes WHERE source_neuron_id IN (SELECT id FROM _sovereignty_event_ids) OR COALESCE(project_id,'')=?`,
        [scope]);
      deleted.traceEvents = this.deleteIfTable('trace_events',
        `DELETE FROM trace_events WHERE COALESCE(project_id,'')=? AND timestamp>=? AND timestamp<?`,
        [scope, input.start, input.end]);
      this.runDelete(`DELETE FROM memory_events WHERE event_id IN (SELECT id FROM _sovereignty_event_ids)`, []);
      })();
    } finally {
      this.ports.db.exec(`
        DROP TABLE IF EXISTS _sovereignty_event_ids;
        DROP TABLE IF EXISTS _sovereignty_episode_ids;
      `);
    }
    this.eraseFreedPages();

    // A snapshot or export made after the earliest deleted row was recorded may hold that row's
    // text. Both are whole copies, so they are removed rather than rewritten.
    Object.assign(artifacts, this.removeAffectedArtifacts(earliestRecordedAt));

    // The ledger and derived rows are gone before the audit row is written, so a failed recompile
    // still leaves the owner a record of what was removed.
    const auditId = this.writeAudit('delete_range', scope, { start: input.start, end: input.end, counts: deleted, artifacts }, input.reason);
    // The books are views over the ledger, so a recompile is the consistency proof rather than a
    // second deletion list: an entry whose evidence is gone does not come back.
    if (scope) {
      this.ports.profile.compile({ projectId: scope, now: this.now() });
      this.ports.procedures.compile({ projectId: scope, now: this.now() });
      this.ports.commitments.compile({ projectId: scope, now: this.now() });
    }
    this.ports.rebuildAtlas?.(scope);
    return { ...input, projectId: scope, auditId, deleted, artifacts };
  }

  /** Write the human-readable archive. The current ledger is the source, so deleted ranges are absent. */
  exportArchive(input: SovereigntyExportInput): SovereigntyExportResult {
    const scope = requiredProject(input.projectId);
    const path = typeof input.outputPath === 'string' ? input.outputPath.trim() : '';
    if (!path) throw error('invalid_sovereignty_path');
    // Count first, write second: both passes are paged, so a decade ledger never sits in memory as
    // one array of parsed events plus one array of rendered lines.
    let eventCount = 0;
    this.eachEvent(scope, (event) => {
      if (eventText(event).trim()) eventCount += 1;
    });
    const profile = scope ? this.ports.profile.entries({ projectId: scope }) : [];
    const procedures = scope ? this.ports.procedures.entries({ projectId: scope }) : [];
    const commitments = scope ? this.ports.commitments.list({ projectId: scope, limit: 1000, now: this.now() }) : [];
    const graph = this.graphRows(scope);
    const exportedAt = this.now();
    let buffer: string[] = [
      '# Cog Memory Archive',
      '',
      `Project: ${scope || '(projectless)'}`,
      `Exported: ${iso(exportedAt)}`,
      '',
      `This is a human-readable archive, not a database dump. It contains ${eventCount} conversation turns, ${profile.length} profile entries, ${procedures.length} procedures, ${commitments.length} commitments and ${graph.length} graph nodes.`,
      '',
      '## Conversations',
      '',
    ];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'w', 0o600);
    let bytes = 0;
    let firstChunk = true;
    const write = () => {
      if (buffer.length === 0) return;
      // A newline belongs *between* chunks, not after the last line; otherwise every flush
      // (and the final one) adds a blank line the reader did not ask for.
      const body = `${firstChunk ? '' : '\n'}${buffer.join('\n')}`;
      writeSync(fd, body);
      bytes += Buffer.byteLength(body, 'utf8');
      buffer = [];
      firstChunk = false;
    };
    try {
      if (eventCount === 0) buffer.push('_No conversation turns remain._', '');
      this.eachEvent(scope, (event) => {
        const text = eventText(event).trim();
        if (!text) return;
        const label = sensitivityLabel(event);
        buffer.push(`### ${iso(event.occurredAt)} · ${event.role ?? 'unknown'} · ${event.eventId}`, '');
        if (label) buffer.push(`Sensitivity: ${label}`, '');
        buffer.push(text, '');
        if (buffer.length >= 400) write();
      });
    buffer.push('## Profile', '');
    this.renderEntries(buffer, 'Facts', profile.filter((entry) => entry.ledger === 'facts'), this.ports.events);
    this.renderEntries(buffer, 'Preferences', profile.filter((entry) => entry.ledger === 'preferences'), this.ports.events);
    this.renderEntries(buffer, 'Relations', profile.filter((entry) => entry.ledger === 'relations'), this.ports.events);
    this.renderEntries(buffer, 'Ongoing', profile.filter((entry) => entry.ledger === 'ongoing'), this.ports.events);
    buffer.push('## Procedures', '');
    if (procedures.length === 0) buffer.push('_No procedures remain._', '');
    for (const entry of procedures) {
      const label = entrySensitivity(entry.sourceRefs, this.ports.events);
      const source = sourceLabel(entry.sourceRefs);
      buffer.push(`### ${entry.title}`, '', `Domain: ${entry.domain} · ${entry.grade} · ${entry.origin}${source ? ` · source ${source}` : ''}`, '');
      if (label) buffer.push(`Sensitivity: ${label}`, '');
      buffer.push(...entry.steps.map((step, index) => `${index + 1}. ${step}`), '');
    }
    buffer.push('## Commitments', '');
    if (commitments.length === 0) buffer.push('_No commitments remain._', '');
    for (const entry of commitments) {
      const label = entrySensitivity(entry.sourceRefs, this.ports.events);
      const source = sourceLabel(entry.sourceRefs);
      buffer.push(`- ${entry.content} — ${entry.status}${entry.dueAt ? ` · due ${iso(entry.dueAt)}` : ''}${source ? ` · source ${source}` : ''}`);
      if (label) buffer.push(`  Sensitivity: ${label}`);
    }
    buffer.push('', '## Memory graph', '');
    if (graph.length === 0) buffer.push('_No graph nodes remain._', '');
    for (const row of graph) buffer.push(`- ${row.node_type}: ${row.label}`);
    buffer.push('');
    write();
    } catch (error) {
      // A failed export must not leave half an archive that looks complete.
      closeSync(fd);
      rmSync(path, { force: true });
      throw error;
    }
    closeSync(fd);
    // mode only applies on create: a re-export over an older 0644 file must tighten it too.
    chmodSync(path, 0o600);
    const counts = Object.fromEntries(SOVEREIGNTY_EXPORT_COUNT_FIELDS.map((field) => [field, 0])) as Record<string, number>;
    Object.assign(counts, { events: eventCount, profile: profile.length, procedures: procedures.length, commitments: commitments.length, graph: graph.length });
    const auditId = this.writeAudit('export_archive', scope, { start: exportedAt, end: exportedAt, path, counts });
    return { projectId: scope, path, counts, bytes, auditId };
  }

  /** The owner's read: what was paused, deleted and exported, with range, counts and time. */
  audit(projectId: string, limit = 50): SovereigntyAuditRecord[] {
    const scope = requiredProject(projectId);
    if (!Number.isInteger(limit) || limit <= 0) throw error('invalid_limit');
    const rows = this.ports.db.prepare(`
      SELECT audit_id, action, details_json, created_at
      FROM governance_audit_log
      WHERE project_id=?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(this.auditScope(scope), Math.min(limit, 500)) as Array<{
      audit_id: string;
      action: string;
      details_json: string | null;
      created_at: number;
    }>;
    return rows
      .filter((row) => (SOVEREIGNTY_ACTIONS as readonly string[]).includes(row.action))
      .map((row) => {
        const details = row.details_json ? JSON.parse(row.details_json) as Record<string, unknown> : {};
        const counts = (details.counts ?? details.deleted ?? {}) as Record<string, number>;
        const start = typeof details.start === 'number' ? details.start : typeof details.since === 'number' ? details.since : Number(row.created_at);
        const end = typeof details.end === 'number' ? details.end : start;
        return {
          auditId: row.audit_id,
          action: row.action,
          projectId: scope,
          range: { start, end },
          counts,
          createdAt: Number(row.created_at),
        };
      });
  }

  private renderEntries(lines: string[], title: string, entries: ProfileEntry[], events: EventStore): void {
    lines.push(`### ${title}`, '');
    if (entries.length === 0) lines.push('_No entries remain._', '');
    for (const entry of entries) {
      const label = entrySensitivity(entry.sourceRefs, events);
      const source = sourceLabel(entry.sourceRefs);
      lines.push(`- ${entry.key}: ${entry.value} (recorded ${iso(entry.recordedAt)}${source ? ` · source ${source}` : ''})`);
      if (label) lines.push(`  Sensitivity: ${label}`);
    }
    lines.push('');
  }

  /** Stream the project ledger once; the caller accumulates only what it must keep. */
  private eachEvent(
    scope: string,
    visit: (event: MemoryEvent) => void,
    filters: { startTime?: number; endTime?: number } = {},
  ): void {
    for (const event of this.ports.events.iterateProjectEvents(scope, filters.startTime, filters.endTime)) visit(event);
  }

  private episodesInRange(scope: string, start: number, end: number): Array<{ episodeId: string }> {
    const rows = this.ports.db.prepare(`
      SELECT DISTINCT episode_id FROM memory_episodes
      WHERE project_id=? AND (
        (started_at < ? AND COALESCE(sealed_at, updated_at) >= ?)
        OR start_event_id IN (SELECT id FROM _sovereignty_event_ids)
        OR end_event_id IN (SELECT id FROM _sovereignty_event_ids)
      )
    `).all(scope, end, start) as Array<{ episode_id: string }>;
    return rows.map((row) => ({ episodeId: row.episode_id }));
  }

  private graphRows(scope: string): Array<{ node_type: string; label: string }> {
    if (!this.tableExists('memory_atlas_documents')) return [];
    return this.ports.db.prepare(`
      SELECT node_type, label FROM memory_atlas_documents
      WHERE project_id=? AND status='active'
      ORDER BY node_type, label LIMIT 500
    `).all(scope) as Array<{ node_type: string; label: string }>;
  }

  private eraseFreedPages(): void {
    const db = this.ports.db;
    const ftsTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'`).all() as Array<{ name: string }>;
    for (const { name } of ftsTables) db.exec(`INSERT INTO "${name}"("${name}") VALUES('optimize')`);
    const previousTempStore = (db.prepare('PRAGMA temp_store').get() as { temp_store?: number } | undefined)?.temp_store ?? 0;
    db.exec('PRAGMA temp_store = MEMORY');
    try {
      db.exec('VACUUM');
    } finally {
      db.exec(`PRAGMA temp_store = ${previousTempStore}`);
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Whole-copy artifacts made after the earliest deleted row was recorded can contain it. They are
   * removed, not rewritten: a snapshot is a verification chain of checksum + manifest, and
   * re-creating an old point in time would silently change what that day held.
   */
  private removeAffectedArtifacts(cutoff: number): SovereigntyArtifactCoverage {
    const coverage: SovereigntyArtifactCoverage = {
      snapshotsRemoved: 0,
      archivesRemoved: 0,
      exportsRemoved: 0,
      snapshotsScanned: 0,
      exportsScanned: 0,
      notCovered: ['数据目录之外的导出文件', '已复制到其他机器的备份'],
    };
    const snapshotsDir = this.ports.snapshotsDir;
    if (snapshotsDir && existsSync(snapshotsDir)) {
      const removedBrainManifests = new Set<string>();
      for (const file of readdirSync(snapshotsDir)) {
        if (!/^(?:brain|archive)-.*\.snap$/u.test(file)) continue;
        coverage.snapshotsScanned += 1;
        const snapshotPath = join(snapshotsDir, file);
        const manifestPath = snapshotPath.replace(/\.snap$/u, '.json');
        let createdAt = statSync(snapshotPath).mtimeMs;
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { createdAt?: unknown };
          if (typeof parsed.createdAt === 'string' && Number.isFinite(Date.parse(parsed.createdAt))) {
            createdAt = Date.parse(parsed.createdAt);
          }
        } catch {
          // No readable manifest: the file's own mtime is the only timestamp left.
        }
        if (createdAt < cutoff) continue;
        rmSync(snapshotPath, { force: true });
        rmSync(manifestPath, { force: true });
        if (file.startsWith('archive-')) coverage.archivesRemoved += 1;
        else {
          coverage.snapshotsRemoved += 1;
          removedBrainManifests.add(file);
        }
      }
      this.forgetSnapshotMarker(removedBrainManifests);
    }
    const exportsDir = this.ports.exportsDir;
    if (exportsDir && existsSync(exportsDir)) {
      for (const file of readdirSync(exportsDir)) {
        if (!file.endsWith('.md')) continue;
        coverage.exportsScanned += 1;
        const exportPath = join(exportsDir, file);
        if (statSync(exportPath).mtimeMs < cutoff) continue;
        rmSync(exportPath, { force: true });
        coverage.exportsRemoved += 1;
      }
    }
    return coverage;
  }

  /** `brain_snapshot_last` must not point at a snapshot this deletion removed. */
  private forgetSnapshotMarker(removedBrainManifests: Set<string>): void {
    if (removedBrainManifests.size === 0 || !this.tableExists('_meta')) return;
    const row = this.ports.db.prepare(`SELECT value FROM _meta WHERE key='brain_snapshot_last'`).get() as { value?: string } | undefined;
    if (!row?.value) return;
    try {
      const file = (JSON.parse(row.value) as { file?: unknown }).file;
      if (typeof file === 'string' && removedBrainManifests.has(file)) {
        this.ports.db.prepare(`DELETE FROM _meta WHERE key='brain_snapshot_last'`).run();
      }
    } catch {
      // A malformed marker is not a reason to keep a deleted snapshot's name around.
      this.ports.db.prepare(`DELETE FROM _meta WHERE key='brain_snapshot_last'`).run();
    }
  }

  private readPause(scope: string): { pausedAt: number } | undefined {
    if (!this.tableExists('_meta')) return undefined;
    const row = this.ports.db.prepare(`SELECT value FROM _meta WHERE key=?`).get(this.pauseKey(scope)) as { value?: string } | undefined;
    if (!row?.value) return undefined;
    try {
      const parsed = JSON.parse(row.value) as { pausedAt?: unknown };
      return typeof parsed.pausedAt === 'number' ? { pausedAt: parsed.pausedAt } : undefined;
    } catch {
      return undefined;
    }
  }

  private pauseKey(scope: string): string {
    return `sovereignty.pause:${scope}`;
  }

  private auditScope(scope: string): string {
    return `sha256:${createHash('sha256').update(scope).digest('hex')}`;
  }

  private writeAudit(action: SovereigntyAction, scope: string, details: Record<string, unknown>, reason?: string): string {
    const auditId = `audit-${randomUUID()}`;
    this.ports.db.prepare(`
      INSERT INTO governance_audit_log (audit_id, action, project_id, reason, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(auditId, action, this.auditScope(scope), reason ?? null, JSON.stringify(details), this.now());
    return auditId;
  }

  private ensureAuditTable(): void {
    this.ports.db.exec(`
      CREATE TABLE IF NOT EXISTS governance_audit_log (
        audit_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        project_id TEXT,
        reason TEXT,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private tableExists(table: string): boolean {
    return Boolean(this.ports.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table));
  }

  private runDelete(sql: string, params: Array<string | number>): number {
    try {
      return Number(this.ports.db.prepare(sql).run(...params).changes ?? 0);
    } catch (error) {
      if (error instanceof Error && /no such table:/i.test(error.message)) return 0;
      throw error;
    }
  }

  private deleteIfTable(table: string, sql: string, params: Array<string | number>): number {
    return this.tableExists(table) ? this.runDelete(sql, params) : 0;
  }
}

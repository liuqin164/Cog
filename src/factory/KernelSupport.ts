import { createHash } from 'node:crypto';
import Database from 'bun:sqlite';
import type { EpisodeStore } from '../episode/index.js';
import { logicalTurnsFromPairs } from '../episode/EpisodeBoundaryReplayEngine.js';
import type { MemoryEvent } from '../types/index.js';
import type { EpisodeRepairInput } from './KernelOptions.js';

export function changedFieldsForRepair(input: EpisodeRepairInput): string[] {
  if (input.operation === 'reclassify') {
    return [
      input.episodeType ? 'episodeType' : '',
      input.topicPath ? 'topicPath' : '',
      input.importance !== undefined ? 'importance' : '',
    ].filter(Boolean);
  }
  if (input.operation === 'move-event') return ['episodeEvents'];
  if (input.operation === 'split' || input.operation === 'merge') return ['episodeEvents', 'crossRefs'];
  if (input.operation === 'requeue-dream' || input.operation === 'invalidate-dream-run') return ['dreamQueue'];
  return [];
}

export function validateEpisodeRepairInput(
  input: EpisodeRepairInput,
  store: EpisodeStore,
  resolveEvent: (eventId: string) => MemoryEvent | undefined,
  episodeTypes: readonly string[],
): void {
  if (!input.projectId?.trim()) throw new Error('episode_project_required');
  if (input.operation === 'reclassify' && input.episodeType !== undefined
    && !episodeTypes.includes(input.episodeType)) {
    throw new Error(`invalid_episode_type: expected one of ${episodeTypes.join(', ')}`);
  }
  if (input.operation === 'reclassify' && input.importance !== undefined
    && (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1)) {
    throw new Error('episode_importance_out_of_range');
  }
  if (input.operation === 'split') {
    if (!input.eventIds.length) throw new Error('episode_split_requires_event_ids');
    if (new Set(input.eventIds).size !== input.eventIds.length) throw new Error('episode_split_duplicate_event_ids');
    const source = store.getEpisode(input.episodeId);
    if (!source || source.projectId !== input.projectId) throw new Error(`episode_project_mismatch:${input.episodeId}`);
    if (source.status !== 'sealed') throw new Error('episode_split_requires_sealed_source');
    const sourceIds = new Set(store.listEventLinks(input.episodeId).map((link) => link.eventId));
    if (input.eventIds.some((eventId) => !sourceIds.has(eventId))) throw new Error('episode_split_event_not_in_source');
    if (input.eventIds.length >= sourceIds.size) throw new Error('episode_split_requires_proper_subset');
    const links = store.listEventLinks(input.episodeId);
    const selected = new Set(input.eventIds);
    const indices = links.map((link, index) => selected.has(link.eventId) ? index : -1).filter((index) => index >= 0);
    const first = indices[0];
    const last = indices.at(-1);
    if (first === undefined || last === undefined || last - first + 1 !== indices.length) {
      throw new Error('episode_split_requires_contiguous_range');
    }
    const pairs = links.map((link) => ({ link, event: resolveEvent(link.eventId) }));
    const turns = logicalTurnsFromPairs(pairs);
    if (turns.some((turn) => {
      const included = turn.filter((pair) => selected.has(pair.link.eventId)).length;
      return included > 0 && included !== turn.length;
    })) throw new Error('episode_split_requires_complete_logical_turns');
    for (const eventId of selected) {
      const event = resolveEvent(eventId);
      if (event?.parentEventId && sourceIds.has(event.parentEventId) && !selected.has(event.parentEventId)) {
        throw new Error('episode_split_requires_complete_tool_chain');
      }
      const childInSource = links.some((link) => resolveEvent(link.eventId)?.parentEventId === eventId);
      if (childInSource && !links.filter((link) => resolveEvent(link.eventId)?.parentEventId === eventId).every((link) => selected.has(link.eventId))) {
        throw new Error('episode_split_requires_complete_tool_chain');
      }
    }
    if (!turns.some((turn) => turn.every((pair) => selected.has(pair.link.eventId)) && turn.some((pair) => pair.event?.role === 'user'))) {
      throw new Error('episode_split_requires_primary_user_turn');
    }
  }
  if (input.operation === 'move-event') {
    const link = store.getEventLink(input.eventId);
    if (link?.episodeId === input.targetEpisodeId) throw new Error('episode_move_source_equals_target');
    const source = link ? store.getEpisode(link.episodeId) : undefined;
    const target = store.getEpisode(input.targetEpisodeId);
    if (!source || !target || source.projectId !== input.projectId || target.projectId !== input.projectId) throw new Error('episode_project_mismatch');
    if (source.sessionId !== target.sessionId || source.sourceAgent !== target.sourceAgent || source.conversationThreadId !== target.conversationThreadId) {
      throw new Error('episode_move_scope_mismatch');
    }
  }
  if (input.operation === 'merge') {
    if (input.sourceEpisodeId === input.targetEpisodeId) throw new Error('episode_merge_source_equals_target');
    const source = store.getEpisode(input.sourceEpisodeId);
    const target = store.getEpisode(input.targetEpisodeId);
    if (!source || !target || source.projectId !== input.projectId || target.projectId !== input.projectId) throw new Error('episode_project_mismatch');
    if (source.sessionId !== target.sessionId || source.sourceAgent !== target.sourceAgent || source.conversationThreadId !== target.conversationThreadId) {
      throw new Error('episode_merge_scope_mismatch');
    }
  }
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

export function requiredGovernancePayloadString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`governance payload requires ${field}`);
  return value;
}

export function eventPayloadText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const text = (payload as Record<string, unknown>).text;
  return typeof text === 'string' ? text : undefined;
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function scrubEntityAliasConflicts(db: Database, deletedEntityIds: string[]): void {
  const deleted = new Set(deletedEntityIds);
  const rows = db.prepare(`SELECT conflict_id, entity_ids_json FROM entity_alias_conflicts`).all() as Array<{ conflict_id: string; entity_ids_json: string }>;
  for (const row of rows) {
    const remaining = parseJsonStringArray(row.entity_ids_json).filter((entityId) => !deleted.has(entityId));
    if (remaining.length < 2) {
      db.prepare(`DELETE FROM entity_alias_conflicts WHERE conflict_id = ?`).run(row.conflict_id);
    } else {
      db.prepare(`UPDATE entity_alias_conflicts SET entity_ids_json = ?, updated_at = ? WHERE conflict_id = ?`)
        .run(JSON.stringify(remaining), Date.now(), row.conflict_id);
    }
  }
}

export function rebuildCanonicalEntityAfterForget(
  db: Database,
  canonicalEntityId: string,
  runDelete: (sql: string, params?: Array<string | number>) => number,
): void {
  const remaining = db.prepare(`
    SELECT instance_id,aliases_json,canonical_name FROM entity_instances WHERE canonical_entity_id = ?
    ORDER BY updated_at DESC,instance_id
  `).all(canonicalEntityId) as Array<{ instance_id: string; aliases_json: string; canonical_name: string }>;
  if (remaining.length === 0) {
    runDelete(`DELETE FROM entities WHERE entity_id = ?`, [canonicalEntityId]);
    return;
  }

  const scopedAliases = db.prepare(`SELECT alias_text FROM entity_aliases WHERE entity_id IN (
    SELECT instance_id FROM entity_instances WHERE canonical_entity_id=?
  ) ORDER BY updated_at DESC,alias_id`).all(canonicalEntityId) as Array<{ alias_text: string }>;
  const aliases = uniqueStrings([
    ...scopedAliases.map((row) => row.alias_text),
    ...remaining.flatMap((row) => parseJsonStringArray(row.aliases_json)),
  ]);
  const canonicalName = scopedAliases[0]?.alias_text || remaining[0]?.canonical_name || `entity-${canonicalEntityId.slice(-12)}`;
  db.prepare(`UPDATE entities SET canonical_name = ?, aliases_json = ?, metadata_json = '{}', updated_at = ? WHERE entity_id = ?`)
    .run(canonicalName, JSON.stringify(aliases), Date.now(), canonicalEntityId);
}

export function optionalGovernancePayloadString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`governance payload ${field} must be a string`);
  return value;
}

export function optionalGovernancePayloadNumber(payload: Record<string, unknown>, field: string): number | undefined {
  const value = payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`governance payload ${field} must be a finite number`);
  return value;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function sameProvided(left: unknown, right: unknown): boolean {
  return right === undefined || (left ?? undefined) === right;
}

export function extractNavigationTerms(query: string): string[] {
  return uniqueStrings(
    query
      .toLowerCase()
      .split(/[\s,，。！？、:：/]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

export function requireProjectId(projectId: string): string {
  const normalized = projectId?.trim();
  if (!normalized) throw new Error('project_id_required');
  return normalized;
}

export function stringifyToolPayload(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface AgentTurnIdentityInput {
  projectId?: string;
  agentId: string;
  sessionId: string;
  turnId: string;
  userText: string;
  assistantText?: string;
}

export interface AgentTurnClaim {
  userEventId: string;
  assistantEventId?: string;
  replay: boolean;
}

/**
 * Identity for one message of a named turn.
 *
 * Stable inputs only — project, agent, session, the caller's turn id, and which
 * message of the turn it is. Not the clock, not the turn sequence, not the text:
 * those change between an attempt and its retry, which is how a retry became a
 * duplicate (#113).
 */
export function agentTurnEventId(input: AgentTurnIdentityInput, ordinal: 1 | 2): string {
  return `evt-turn-${createHash('sha256')
    .update(JSON.stringify([input.projectId ?? '', input.agentId, input.sessionId, input.turnId, ordinal]))
    .digest('hex')}`;
}

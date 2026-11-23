/**
 * The session's ledger rows, read.
 *
 * A session is not a second store: it is the conversation lane of `memory_events`, scoped by
 * project, session and the agent that captured it. Every read here is verbatim — the row's own
 * `payload.text`, after exclusion and redaction, never a re-rendering of it.
 *
 * The write side is `ConversationCaptureService` (#157); this module only reads.
 */
import type Database from 'bun:sqlite';

import type { ConversationSpeaker } from '../conversation/index.js';
import type { MemoryEventRole } from '../types/index.js';

/** The most turns one assembly reads. Beyond it the digest says it is truncated rather than lying. */
export const SESSION_LEDGER_MAX_TURNS = 5000;

/** The newest turns the digest lane compiles (#322); older ones stay in the ledger for recall. */
export const SESSION_DIGEST_MAX_TURNS = 512;

export interface SessionTurn {
  eventId: string;
  projectId: string;
  sessionId: string;
  threadId: string;
  /** The named turn this row belongs to (`<runId>:0` for the shell's runs). */
  turnId: string;
  agentId: string;
  speaker: ConversationSpeaker;
  role: MemoryEventRole;
  channel: string;
  /** The ledger's own text: never trimmed, never paraphrased. */
  text: string;
  occurredAt: number;
  globalSeq: number;
}

export interface SessionTurnRead {
  turns: SessionTurn[];
  /** True when turns older than this page exist. */
  truncated: boolean;
}

export interface SessionTurnReadInput {
  projectId: string;
  agentId: string;
  sessionId: string;
  limit?: number;
  beforeGlobalSeq?: number;
  afterGlobalSeq?: number;
}

/** One `tool_call` row: the task's own trajectory, as captured, with no model summary. */
export interface SessionToolCall {
  eventId: string;
  turnId: string;
  toolName: string;
  input: unknown;
}

export interface SessionToolCallReadInput {
  projectId: string;
  agentId: string;
  sessionId: string;
  /** Only rows captured at or after this instant; the task's start boundary. */
  since: number;
}

interface TurnRow {
  event_id: string;
  project_id: string | null;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  role: string | null;
  occurred_at: number;
  global_seq: number | null;
  text: string | null;
  payload_json: string;
}

const TURN_COLUMNS = `
  event_id, project_id, session_id, thread_id, turn_id, role, occurred_at, global_seq,
  json_extract(payload_json, '$.text') AS text, payload_json
`;

/**
 * The lane predicate: a captured conversation turn, scoped to the agent's own session.
 *
 * `source_id` is the capture face's `${agentId}:${sessionId}`. Requiring it is what keeps a second
 * agent's turns in the same session id out of this session's view, and keeps tool rows (which never
 * carry the lane marker) out of the digest.
 */
const LANE_SQL = `
  event_type = 'RAW_EVENT_RECORDED'
  AND project_id = ?
  AND session_id = ?
  AND source_id = ?
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.metadata.captureLane') = 'conversation'
`;

export function readSessionTurns(db: Database, input: SessionTurnReadInput): SessionTurnRead {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? SESSION_LEDGER_MAX_TURNS), SESSION_LEDGER_MAX_TURNS));
  const before = input.beforeGlobalSeq;
  const after = input.afterGlobalSeq;
  const rows = db
    .query(`
      SELECT * FROM (
        SELECT ${TURN_COLUMNS}
        FROM memory_events
        WHERE ${LANE_SQL}
          ${after === undefined ? '' : 'AND COALESCE(global_seq, 0) > ?'}
          ${before === undefined ? '' : `AND (
            occurred_at < (SELECT occurred_at FROM memory_events WHERE global_seq = ?)
            OR (occurred_at = (SELECT occurred_at FROM memory_events WHERE global_seq = ?)
              AND COALESCE(global_seq, 0) < ?)
          )`}
        ORDER BY occurred_at DESC, COALESCE(global_seq, 0) DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY occurred_at ASC, COALESCE(global_seq, 0) ASC, event_id ASC
    `)
    .all(
      input.projectId,
      input.sessionId,
      `${input.agentId}:${input.sessionId}`,
      ...(after === undefined ? [] : [after]),
      ...(before === undefined ? [] : [before, before, before]),
      limit + 1,
    ) as TurnRow[];
  const truncated = rows.length > limit;
  return { turns: (truncated ? rows.slice(rows.length - limit) : rows).map(mapTurn), truncated };
}

/** The tool calls a task made since `since`, in capture order (#262). No upper bound: rows land at `agent_end`. */
export function readSessionToolCalls(db: Database, input: SessionToolCallReadInput): SessionToolCall[] {
  const rows = db
    .query(`
      SELECT event_id, turn_id, occurred_at, global_seq,
        json_extract(payload_json, '$.metadata.toolName') AS tool_name,
        json_extract(payload_json, '$.metadata.input') AS tool_input
      FROM memory_events
      WHERE event_type = 'RAW_EVENT_RECORDED'
        AND raw_event_type = 'tool_call'
        AND COALESCE(project_id, '') = ?
        AND COALESCE(session_id, '') = ?
        AND COALESCE(source_id, '') = ?
        AND occurred_at >= ?
        AND json_valid(payload_json)
      ORDER BY occurred_at ASC, COALESCE(global_seq, 0) ASC, event_id ASC
      LIMIT 500
    `)
    .all(input.projectId, input.sessionId, `${input.agentId}:${input.sessionId}`, input.since) as Array<{
      event_id: string;
      turn_id: string | null;
      tool_name: string | null;
      tool_input: string | null;
    }>;
  return rows
    .filter((row) => typeof row.tool_name === 'string' && row.tool_name !== '')
    .map((row) => ({
      eventId: row.event_id,
      turnId: row.turn_id ?? '',
      toolName: row.tool_name!,
      input: parseToolInput(row.tool_input),
    }));
}

function parseToolInput(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function mapTurn(row: TurnRow): SessionTurn {
  const payload = JSON.parse(row.payload_json) as { metadata?: Record<string, unknown> };
  const metadata = payload.metadata ?? {};
  const role = (row.role ?? 'user') as MemoryEventRole;
  return {
    eventId: row.event_id,
    projectId: row.project_id ?? '',
    sessionId: row.session_id ?? '',
    threadId: row.thread_id ?? '',
    turnId: row.turn_id ?? '',
    agentId: typeof metadata.sourceAgent === 'string' ? metadata.sourceAgent : '',
    // The old turn writer marks the lane but has no per-event speaker (its metadata is shared by
    // the user and assistant rows); the ledger's own role is the unambiguous fallback.
    speaker: (metadata.speaker as ConversationSpeaker | undefined)
      ?? (role === 'assistant' ? 'agent' : role === 'other' ? 'other' : 'owner'),
    role,
    channel: typeof metadata.channel === 'string' ? metadata.channel : '',
    text: row.text ?? '',
    occurredAt: Number(row.occurred_at ?? 0),
    globalSeq: Number(row.global_seq ?? 0),
  };
}

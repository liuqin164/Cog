import type Database from 'bun:sqlite';

import { registerDerivation } from '../governance/DerivationLedger.js';
import type { TextGenerateFn } from '../models/ModelRole.js';
import { digestAnchors, type SessionDeepCompileInput, type SessionDeepCompiler, type SessionDigestEntry } from './SessionDigest.js';
import { readSessionTurns, SESSION_DIGEST_MAX_TURNS, type SessionTurn } from './SessionLedger.js';

export const SESSION_DEEP_SEGMENT_GAP_MS = 30 * 60_000;
export const SESSION_DEEP_MIN_TURNS = 8;
export const SESSION_DEEP_MAX_CARDS_IN_LANE = 24;
export const SESSION_DEEP_MAX_CARDS_PER_RUN = 8;

export interface SessionDeepScope {
  projectId: string;
  agentId: string;
  sessionId: string;
}

export interface SessionDeepCompileRunInput extends Partial<SessionDeepScope> {
  now?: number;
  generateText?: TextGenerateFn;
  maxCards?: number;
}

export interface SessionDeepCompileRunResult {
  created: SessionDigestEntry[];
  scopes: number;
  declaredSkipped: number;
  failures: string[];
}

export interface SessionDeepSegment {
  turns: SessionTurn[];
  declared: boolean;
}

interface CardRow {
  entry_id: string;
  session_id: string;
  occurred_at: number;
  text: string;
  source_refs_json: string;
  anchor: number;
}

const CARD_TABLE = 'session_deep_cards';

function initCardTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CARD_TABLE} (
      entry_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      segment_key TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      anchor INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ${CARD_TABLE}_segment
      ON ${CARD_TABLE} (project_id, agent_id, session_id, segment_key);
  `);
}

export function planDeepSegments(
  turns: readonly SessionTurn[],
  taskEnds: readonly number[],
  now: number,
  gapMs = SESSION_DEEP_SEGMENT_GAP_MS,
  taskStarts: readonly number[] = [],
): SessionDeepSegment[] {
  const windows = taskWindows(taskStarts, taskEnds);
  const segments: SessionDeepSegment[] = [];
  let current: SessionTurn[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    current.push(turn);
    const next = turns[index + 1];
    const cut = (times: readonly number[]) =>
      times.some((at) => at >= turn.occurredAt && (next === undefined || at < next.occurredAt));
    const ends = cut(taskEnds);
    const starts = cut(taskStarts);
    const gap = next === undefined
      ? now - turn.occurredAt > gapMs
      : next.occurredAt - turn.occurredAt > gapMs;
    if (!ends && !starts && !gap) continue;
    const inWindow = windows.some((window) =>
      current[0]!.occurredAt >= window.from && turn.occurredAt <= window.to);
    if (current.length >= SESSION_DEEP_MIN_TURNS) segments.push({ turns: current, declared: ends || inWindow });
    current = [];
  }
  return segments;
}

function taskWindows(taskStarts: readonly number[], taskEnds: readonly number[]): Array<{ from: number; to: number }> {
  const events = [
    ...taskStarts.map((at) => ({ at, start: true })),
    ...taskEnds.map((at) => ({ at, start: false })),
  ].sort((left, right) => left.at - right.at || Number(left.start) - Number(right.start));
  const open: number[] = [];
  return events.flatMap((event) => {
    if (event.start) {
      open.push(event.at);
      return [];
    }
    const from = open.pop();
    return from === undefined ? [] : [{ from, to: event.at }];
  });
}

export function deepCardEntryId(first: SessionDigestEntry, origin: 'rule' | 'model' = 'rule'): string {
  return `digest:card:${origin}:${first.sourceRefs[0] ?? first.entryId}`;
}

export function buildDeepCardEntry(
  input: SessionDeepCompileInput,
  did: string,
  open: string,
  origin: 'rule' | 'model' = 'rule',
): SessionDigestEntry {
  const first = input.entries[0]!;
  const last = input.entries[input.entries.length - 1]!;
  const sourceRefs = [...new Set(input.entries.flatMap((entry) => entry.sourceRefs))];
  const text = renderCardText(input.entries, did, open, origin);
  return {
    entryId: deepCardEntryId(first, origin),
    kind: 'deep',
    sessionId: input.sessionId,
    occurredAt: input.now,
    speaker: 'agent',
    text,
    sourceRefs,
    anchor: digestAnchors(text).length > 0,
  };
}

export function createSessionDeepCompiler(generateText: TextGenerateFn): SessionDeepCompiler {
  return {
    async compile(input: SessionDeepCompileInput): Promise<SessionDigestEntry[]> {
      const source = input.entries.map((entry) => entry.text).join('\n');
      try {
        const parsed = parseCompiledCard(await generateText(DEEP_CARD_SYSTEM_PROMPT, deepCardUserPrompt(input.entries)));
        if (parsed && anchorsVerbatim(`${parsed.did}\n${parsed.open}`, source)) {
          return [buildDeepCardEntry(input, parsed.did, parsed.open, 'model')];
        }
      } catch {
        return [buildDeepCardEntry(input, deterministicDid(input.entries), deterministicOpen(input.entries))];
      }
      return [buildDeepCardEntry(input, deterministicDid(input.entries), deterministicOpen(input.entries))];
    },
  };
}

export function readDeepCardEntries(
  db: Database,
  scope: SessionDeepScope,
  limit = SESSION_DEEP_MAX_CARDS_IN_LANE,
): SessionDigestEntry[] {
  if (!tableExists(db)) return [];
  const corrections = cardCorrections(db, scope.projectId);
  const rows = db.query(`
    SELECT * FROM (
      SELECT entry_id, session_id, occurred_at, text, source_refs_json, anchor, created_at
      FROM ${CARD_TABLE}
      WHERE project_id = ? AND agent_id = ?
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ?
    )
    ORDER BY created_at ASC, entry_id ASC
  `).all(scope.projectId, scope.agentId, limit) as CardRow[];
  return rows.map((row) => {
    const sourceRefs = parseRefs(row.source_refs_json);
    const noted = [...new Set(sourceRefs.map((ref) => corrections.get(ref)).filter(Boolean) as string[])].sort();
    return {
      entryId: row.entry_id,
      kind: 'deep' as const,
      sessionId: row.session_id,
      occurredAt: row.occurred_at,
      speaker: 'agent' as const,
      text: noted.length === 0 ? row.text : `${row.text}\n后有纠正：${noted.map((id) => `mem:${id}`).join('、')}`,
      sourceRefs,
      anchor: row.anchor === 1,
    };
  });
}

function cardCorrections(db: Database, projectId: string): Map<string, string> {
  const corrections = new Map<string, string>();
  try {
    const rows = db.query(`
      SELECT json_extract(prev.value, '$.eventId') AS corrected_id,
        COALESCE(json_extract(e.payload_json, '$.correctionEventId'), e.event_id) AS correction_id
      FROM memory_events e,
        json_each(COALESCE(json_extract(e.payload_json, '$.previousSourceRefs'), json_extract(e.payload_json, '$.sourceRefs'))) prev
      WHERE COALESCE(e.project_id, '') = ? AND e.event_type = 'PROFILE_ENTRY_CORRECTED'
      UNION
      SELECT prior.event_id, cur.event_id
      FROM memory_episode_events cur
      JOIN memory_episode_events prior ON prior.episode_id = cur.episode_id AND prior.position < cur.position
      JOIN memory_events correction ON correction.event_id = cur.event_id
      JOIN memory_events corrected ON corrected.event_id = prior.event_id
      WHERE cur.relation = 'corrects_previous'
        AND COALESCE(correction.project_id, '') = ?
        AND corrected.role = 'user'
    `).all(projectId, projectId) as Array<{ corrected_id: string | null; correction_id: string | null }>;
    for (const row of rows) {
      if (row.corrected_id && row.correction_id && row.corrected_id !== row.correction_id) corrections.set(row.corrected_id, row.correction_id);
    }
  } catch {}
  return corrections;
}

export function mergeDeepCardEntries(
  entries: readonly SessionDigestEntry[],
  cards: readonly SessionDigestEntry[],
): SessionDigestEntry[] {
  return [...cards, ...entries];
}

export async function compileSessionDeepCards(
  db: Database,
  input: SessionDeepCompileRunInput = {},
): Promise<SessionDeepCompileRunResult> {
  initCardTable(db);
  const now = input.now ?? Date.now();
  const scopes = input.agentId && input.sessionId && input.projectId
    ? [{ projectId: input.projectId, agentId: input.agentId, sessionId: input.sessionId }]
    : listDeepScopes(db, input.projectId);
  const result: SessionDeepCompileRunResult = { created: [], scopes: scopes.length, declaredSkipped: 0, failures: [] };
  let remaining = Math.max(0, input.maxCards ?? SESSION_DEEP_MAX_CARDS_PER_RUN);
  for (const scope of scopes) {
    if (remaining <= 0) break;
    try {
      const made = await compileScope(db, scope, now, input.generateText, remaining);
      result.created.push(...made.created);
      result.declaredSkipped += made.declaredSkipped;
      remaining -= made.created.length;
    } catch (error) {
      result.failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}

async function compileScope(
  db: Database,
  scope: SessionDeepScope,
  now: number,
  generateText: TextGenerateFn | undefined,
  limit: number,
): Promise<{ created: SessionDigestEntry[]; declaredSkipped: number }> {
  const read = readSessionTurns(db, { ...scope, limit: SESSION_DIGEST_MAX_TURNS });
  const taskEnds = readTaskEnds(db, scope);
  const taskStarts = readTaskStarts(db, scope);
  const segments = planDeepSegments(read.turns, taskEnds, now, undefined, taskStarts);
  const existing = existingSegmentKeys(db, scope);
  const created: SessionDigestEntry[] = [];
  let declaredSkipped = 0;
  for (const segment of segments) {
    if (created.length >= limit) break;
    if (segment.declared) {
      declaredSkipped += 1;
      continue;
    }
    const entries = segment.turns.map((turn) => ({
      entryId: `digest:${turn.eventId}`,
      kind: 'turn' as const,
      sessionId: turn.sessionId,
      occurredAt: turn.occurredAt,
      speaker: turn.speaker,
      text: turn.text,
      sourceRefs: [turn.eventId],
      anchor: digestAnchors(turn.text).length > 0,
    }));
    const segmentKey = deepSegmentKey(segment);
    if (existing.has(segmentKey)) continue;
    const compileInput: SessionDeepCompileInput = { ...scope, entries, now };
    const compiler = generateText ? createSessionDeepCompiler(generateText) : undefined;
    let card: SessionDigestEntry;
    if (compiler) {
      try {
        card = (await compiler.compile(compileInput))[0] ?? buildDeepCardEntry(compileInput, deterministicDid(entries), deterministicOpen(entries));
      } catch {
        card = buildDeepCardEntry(compileInput, deterministicDid(entries), deterministicOpen(entries));
      }
    } else {
      card = buildDeepCardEntry(compileInput, deterministicDid(entries), deterministicOpen(entries));
    }
    if (insertCard(db, scope, card, segment, now)) {
      created.push(card);
      existing.add(segmentKey);
    }
  }
  return { created, declaredSkipped };
}

function insertCard(
  db: Database,
  scope: SessionDeepScope,
  card: SessionDigestEntry,
  segment: SessionDeepSegment,
  now: number,
): boolean {
  const segmentKey = deepSegmentKey(segment);
  const changes = db.query(`
    INSERT OR IGNORE INTO ${CARD_TABLE}
      (entry_id, project_id, agent_id, session_id, segment_key, occurred_at, speaker, text, source_refs_json, anchor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    card.entryId,
    scope.projectId,
    scope.agentId,
    scope.sessionId,
    segmentKey,
    card.occurredAt,
    card.speaker,
    card.text,
    JSON.stringify(card.sourceRefs),
    card.anchor ? 1 : 0,
    now,
  ).changes;
  if (Number(changes ?? 0) === 0) return false;
  registerDerivation(db, {
    kind: 'session_deep_cards',
    derivedId: card.entryId,
    sourceEventIds: card.sourceRefs,
    projectId: scope.projectId,
    createdAt: now,
  });
  return true;
}

function existingSegmentKeys(db: Database, scope: SessionDeepScope): Set<string> {
  const rows = db.query(`
    SELECT segment_key FROM ${CARD_TABLE}
    WHERE project_id = ? AND agent_id = ? AND session_id = ?
  `).all(scope.projectId, scope.agentId, scope.sessionId) as Array<{ segment_key: string }>;
  return new Set(rows.map((row) => row.segment_key));
}

function deepSegmentKey(segment: SessionDeepSegment): string {
  return `${segment.turns[0]!.eventId}:${segment.turns[segment.turns.length - 1]!.eventId}`;
}

function listDeepScopes(db: Database, projectId?: string): SessionDeepScope[] {
  const rows = db.query(`
    SELECT project_id AS projectId, session_id AS sessionId,
      json_extract(payload_json, '$.metadata.sourceAgent') AS agentId
    FROM memory_events
    WHERE event_type = 'RAW_EVENT_RECORDED'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.metadata.captureLane') = 'conversation'
      ${projectId === undefined ? '' : 'AND project_id = ?'}
    GROUP BY project_id, session_id, agentId
  `).all(...(projectId === undefined ? [] : [projectId])) as Array<{ projectId: string; sessionId: string; agentId: string | null }>;
  return rows
    .filter((row) => row.projectId && row.sessionId && row.agentId)
    .map((row) => ({ projectId: row.projectId, sessionId: row.sessionId, agentId: row.agentId! }));
}

function readTaskEnds(db: Database, scope: SessionDeepScope): number[] {
  const base = baseSessionId(scope.sessionId);
  const source = `${scope.agentId}:${base}`;
  const rows = db.query(`
    SELECT occurred_at FROM memory_events
    WHERE event_type = 'RAW_EVENT_RECORDED'
      AND project_id = ?
      AND raw_event_type = 'task_event'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.metadata.kind') = 'task-procedure'
      AND (session_id = ? OR substr(session_id, 1, length(?) + 1) = ? || ':')
      AND (source_id = ? OR substr(source_id, 1, length(?) + 1) = ? || ':')
  `).all(scope.projectId, base, base, base, source, source, source) as Array<{ occurred_at: number }>;
  return rows.map((row) => row.occurred_at);
}

function readTaskStarts(db: Database, scope: SessionDeepScope): number[] {
  const base = baseSessionId(scope.sessionId);
  const source = `${scope.agentId}:${base}`;
  const rows = db.query(`
    SELECT occurred_at FROM memory_events
    WHERE event_type = 'RAW_EVENT_RECORDED'
      AND project_id = ?
      AND raw_event_type = 'tool_call'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.metadata.toolName') = 'declare_task'
      AND json_extract(payload_json, '$.metadata.input.action') = 'start'
      AND (session_id = ? OR substr(session_id, 1, length(?) + 1) = ? || ':')
      AND (source_id = ? OR substr(source_id, 1, length(?) + 1) = ? || ':')
  `).all(scope.projectId, base, base, base, source, source, source) as Array<{ occurred_at: number }>;
  return rows.map((row) => row.occurred_at);
}

function baseSessionId(sessionId: string): string {
  const index = sessionId.lastIndexOf(':');
  return index > 0 && /^\d{4}-\d{2}-\d{2}$/u.test(sessionId.slice(index + 1))
    ? sessionId.slice(0, index)
    : sessionId;
}

const DEEP_CARD_SYSTEM_PROMPT = [
  'You compile one episode card from a closed run of conversation turns.',
  'Reply with exactly one JSON object: {"did":"...","open":"..."} and nothing else.',
  '"did" says what the run accomplished in one to three sentences. "open" lists unresolved items, one per line, or an empty string.',
  'Any number, quoted span, person name, or decision that you mention must be copied character for character from the turns. Never paraphrase those fragments.',
  'Write in the same language as the turns.',
].join('\n');

function deepCardUserPrompt(entries: readonly SessionDigestEntry[]): string {
  const lines: string[] = ['Turns:'];
  let used = 0;
  for (const entry of entries) {
    const text = clipCardText(entry.text.replace(/\s+/gu, ' ').trim(), 300);
    const line = `[${entry.sourceRefs[0] ?? entry.entryId}] ${entry.speaker}: ${text}`;
    if (used + line.length > 8_000) break;
    used += line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

function parseCompiledCard(raw: string): { did: string; open: string } | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { did?: unknown; open?: unknown };
    return typeof parsed.did === 'string' && typeof parsed.open === 'string'
      ? { did: parsed.did, open: parsed.open }
      : undefined;
  } catch {
    return undefined;
  }
}

function anchorsVerbatim(card: string, source: string): boolean {
  const present = new Set(digestAnchors(source));
  return digestAnchors(card).every((anchor) => present.has(anchor));
}

function deterministicDid(entries: readonly SessionDigestEntry[]): string {
  const picked = [
    entries.find((entry) => entry.speaker === 'owner'),
    [...entries].reverse().find((entry) => entry.speaker === 'agent'),
    entries[entries.length - 1],
  ];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of picked) {
    if (!entry) continue;
    const line = entry.text.split('\n').map((part) => part.trim()).find(Boolean);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(clipCardText(line, 180));
  }
  return lines.join('；') || '无';
}

const OPEN_MARKERS = /(待办|待定|未完成|遗留|下一步|回头|下次|TODO)/u;

function deterministicOpen(entries: readonly SessionDigestEntry[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const rawLine of entry.text.split('\n')) {
      const line = rawLine.trim();
      if (!line || !OPEN_MARKERS.test(line) || seen.has(line)) continue;
      seen.add(line);
      lines.push(clipCardText(line, 160));
      if (lines.length >= 3) return lines.join('；');
    }
  }
  return lines.join('；') || '无';
}

function clipCardText(text: string, limit: number): string {
  const points = Array.from(text);
  if (points.length <= limit) return text;
  const clipped = points.slice(0, limit).join('');
  const trailing = clipped.match(/[0-9][0-9.,:%+\-/]*$/u);
  return (trailing && /[0-9.,:%+\-/]/u.test(points[limit] ?? '') ? clipped.slice(0, clipped.length - trailing[0].length) : clipped).trimEnd();
}

function renderCardText(entries: readonly SessionDigestEntry[], did: string, open: string, origin: 'rule' | 'model'): string {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const anchors = [...new Set(entries.flatMap((entry) => digestAnchors(entry.text)))].slice(0, 12);
  const pointers = sample(entries.map((entry) => entry.entryId), 10);
  const primary = [first.sourceRefs[0], last.sourceRefs[0]].filter((id): id is string => typeof id === 'string');
  return [
    origin === 'model' ? '情节卡（模型整理，未经核实）' : '情节卡（本段）',
    `做了什么：${did.trim() || '无'}`,
    `遗留问题：${open.trim() || '无'}`,
    `锚点：${anchors.join('、') || '无'}`,
    `指针：${pointers.join('、')}（共 ${entries.length} 条）；${primary.map((id) => `mem:${id}`).join('、')}`,
  ].join('\n');
}

function sample<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const stride = (items.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * stride)]!);
}

function parseRefs(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === 'string') : [];
  } catch {
    return [];
  }
}

function tableExists(db: Database): boolean {
  return Boolean(db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(CARD_TABLE));
}

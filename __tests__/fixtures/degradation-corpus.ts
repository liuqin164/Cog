import { createHash } from 'node:crypto';
import type { MemoryKernel } from '../../src/factory.js';

export const DEGRADATION_DAY_MS = 86_400_000;
export const DEGRADATION_HOUR_MS = 3_600_000;
export const DEGRADATION_TIME_ZONE = 'Asia/Tokyo';
export const DEGRADATION_PROJECT_ID = 'degradation-r05';
export const DEGRADATION_START = Date.UTC(2026, 5, 1);

const VERBS_ZH = ['重构', '迁移', '修复', '审计', '压测', '限流', '灰度', '回滚', '扩容', '降级'];
const VERBS_EN = ['refactor', 'migrate', 'fix', 'audit', 'load-test', 'rate-limit', 'canary', 'rollback', 'scale', 'degrade'];
const VERBS_JA = ['リファクタ', '移行', '修正', '監査', '負荷試験', '制限', 'カナリア', 'ロールバック', '拡張', '縮退'];
const PEOPLE = ['张伟', '李娜', '王强', '陈静', 'Alice', 'Bob', '田中', '佐藤'];

export type DegradationRole = 'user' | 'assistant' | 'tool';

export interface DegradationEvent {
  eventId: string;
  threadId: string;
  sessionId: string;
  turnId: string;
  role: DegradationRole;
  rawEventType: 'message' | 'tool_result';
  occurredAt: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface DegradationAnchors {
  stableEventId: string;
  teaEventId: string;
  brevityEventId: string;
  stableFactCode: string;
  newPromiseCode: string;
  cjkCode: string;
  secret: string;
  cjkSecret: string;
}

export interface DegradationCorpus {
  seed: number;
  events: number;
  days: number;
  timeZone: string;
  projectId: string;
  startAt: number;
  endAt: number;
  realPathStart: number;
  eventsList: DegradationEvent[];
  anchors: DegradationAnchors;
}

export interface DegradationCorpusOptions {
  events?: number;
  days?: number;
  seed?: number;
  timeZone?: string;
  projectId?: string;
  startAt?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`invalid_${name}`);
  return resolved;
}

export function generateDegradationCorpus(options: DegradationCorpusOptions = {}): DegradationCorpus {
  const events = positiveInteger(options.events, 10_000, 'events');
  const days = positiveInteger(options.days, 90, 'days');
  const seed = options.seed ?? 471;
  const timeZone = options.timeZone ?? DEGRADATION_TIME_ZONE;
  const projectId = options.projectId ?? DEGRADATION_PROJECT_ID;
  const startAt = options.startAt ?? DEGRADATION_START;
  const endAt = startAt + days * DEGRADATION_DAY_MS;
  const random = mulberry32(seed);
  const stableFactCode = 'STABLE-FACT-471';
  const newPromiseCode = 'NEW-PROMISE-471';
  const cjkCode = 'CJK-HIT-471';
  const secret = 'DEGRADATION_SECRET_471';
  const cjkSecret = '岚雾';
  const eventsList: DegradationEvent[] = [];

  for (let index = 0; index < events; index += 1) {
    const occurredAt = startAt + 9 * DEGRADATION_HOUR_MS
      + Math.floor((index * days * DEGRADATION_DAY_MS) / events);
    const person = PEOPLE[Math.floor(random() * PEOPLE.length)]!;
    const language = index % 3;
    const special = index < 5;
    const toolResult = !special && index % 97 === 0;
    const role: DegradationRole = special
      ? (index === 3 ? 'tool' : 'user')
      : toolResult
        ? 'tool'
        : index % 7 === 0
          ? 'assistant'
          : 'user';
    const rawEventType = role === 'tool' ? 'tool_result' as const : 'message' as const;
    const text = index === 0
      ? `最早的稳定事实：我住在东京都世田谷区三丁目十二号，单据号 ${stableFactCode}。`
      : index === 1
        ? '我喜欢喝乌龙茶，偏好代号 PREF-TEA-471。'
        : index === 2
          ? '我回答时喜欢简短一点，偏好代号 PREF-BRIEF-471。'
          : index === 3
            ? `工具结果：检索到 ${secret}，中文标记${cjkSecret}。`
            : index === 4
              ? `联络人星屑，代号 ${cjkCode}，负责${person}。`
              : toolResult
                ? `工具结果：检索 ${index} 完成，负责人 ${person}，单据号 D-${index}。`
                : language === 0
                  ? `第 ${index} 件事：${VERBS_ZH[index % VERBS_ZH.length]} 模块 ${index % 17}，负责人 ${person}，单据号 D-${index}。`
                  : language === 1
                    ? `item ${index}: ${VERBS_EN[index % VERBS_EN.length]} module ${index % 17}, owner ${person}, ticket D-${index}.`
                    : `${index} 件目：${VERBS_JA[index % VERBS_JA.length]} モジュール ${index % 17}、担当 ${person}、伝票 D-${index}。`;
    const metadata = {
      sourceAgent: 'hermes',
      ...(toolResult || index === 3 ? { toolName: 'search', toolCallId: `call-${index}` } : {}),
    };
    eventsList.push({
      eventId: `evt-r05-${String(index).padStart(6, '0')}`,
      threadId: `thread-${index % 40}`,
      sessionId: `session-${Math.floor(index / 20)}`,
      turnId: `turn-${index}`,
      role,
      rawEventType,
      occurredAt,
      text,
      metadata,
    });
  }

  return {
    seed,
    events,
    days,
    timeZone,
    projectId,
    startAt,
    endAt,
    realPathStart: events - Math.floor(events / 5),
    eventsList,
    anchors: {
      stableEventId: eventsList[0]!.eventId,
      teaEventId: eventsList[1]!.eventId,
      brevityEventId: eventsList[2]!.eventId,
      stableFactCode,
      newPromiseCode,
      cjkCode,
      secret,
      cjkSecret,
    },
  };
}

export function localDateOf(timestamp: number, timeZone: string): string {
  const offset = timeZone === 'Asia/Tokyo' ? 9 * DEGRADATION_HOUR_MS : 0;
  return new Date(timestamp + offset).toISOString().slice(0, 10);
}

export function cjkTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const run of text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  return [...terms];
}

function sequenceKey(kind: string, projectId: string, id: string): string {
  return `${kind}:${createHash('sha256').update(`${projectId}\0${id}`).digest('hex')}`;
}

export function seedDegradationCorpus(kernel: MemoryKernel, corpus: DegradationCorpus): void {
  const db = kernel.factStore.getDatabase();
  const directEvents = corpus.eventsList.slice(0, corpus.realPathStart);
  const insertEvent = db.prepare(`
    INSERT INTO memory_events (
      event_id, global_seq, stream_id, stream_type, event_type, raw_event_type, event_version,
      project_id, project_scope, actor_id, source_id, content_hash, thread_id, session_id,
      local_date, local_date_source, thread_seq, turn_id, turn_seq, event_ordinal, role,
      prev_event_id, next_event_id, ordering_confidence, occurred_at, payload_json, payload_hash, created_at
    ) VALUES (?, ?, ?, 'thread', 'RAW_EVENT_RECORDED', ?, 1, ?, ?, ?, 'degradation-fixture', ?, ?, ?,
      ?, 'legacy_unknown', ?, ?, ?, 1, ?, NULL, NULL, 'high', ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO memory_events_fts (
      event_id, text, project_id, workspace_id, thread_id, session_id, local_date, role, raw_event_type
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `);
  const insertTerm = db.prepare(`
    INSERT OR IGNORE INTO memory_event_cjk_terms (term, event_id, global_seq) VALUES (?, ?, ?)
  `);
  const threadSeq = new Map<string, number>();
  db.transaction(() => {
    directEvents.forEach((event, index) => {
      threadSeq.set(event.threadId, index + 1);
      const globalSeq = index + 1;
      const payload = JSON.stringify({ text: event.text, metadata: event.metadata });
      const payloadHash = createHash('sha256').update(payload).digest('hex');
      const contentHash = createHash('sha256').update(event.text).digest('hex');
      const localDate = localDateOf(event.occurredAt, corpus.timeZone);
      insertEvent.run(
        event.eventId, globalSeq, event.eventId, event.rawEventType,
        corpus.projectId, corpus.projectId, event.role, contentHash,
        event.threadId, event.sessionId, localDate, index + 1,
        event.turnId, index + 1, event.role, event.occurredAt,
        payload, payloadHash, event.occurredAt,
      );
      insertFts.run(
        event.eventId, event.text, corpus.projectId, event.threadId,
        event.sessionId, localDate, event.role, event.rawEventType,
      );
      for (const term of cjkTerms(event.text)) insertTerm.run(term, event.eventId, globalSeq);
    });
    const maxRowid = Number((db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM memory_events').get() as { value: number }).value);
    const ftsRows = Number((db.prepare('SELECT COUNT(*) AS value FROM memory_events_fts').get() as { value: number }).value);
    const cjkRows = Number((db.prepare('SELECT COUNT(*) AS value FROM memory_event_cjk_terms').get() as { value: number }).value);
    const state = db.prepare(`
      INSERT INTO memory_event_fts_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    state.run('indexed_rowid', String(maxRowid));
    state.run('indexed_fts_rows', String(ftsRows));
    state.run('cjk_indexed_rowid', String(maxRowid));
    state.run('cjk_terms', String(cjkRows));
    db.prepare(`
      INSERT INTO event_sequence_counters (counter_key, value) VALUES (?, ?)
      ON CONFLICT(counter_key) DO UPDATE SET value = MAX(value, excluded.value)
    `).run('global', String(directEvents.length));
    const eventCounter = db.prepare(`
      INSERT INTO event_sequence_counters (counter_key, value) VALUES (?, ?)
      ON CONFLICT(counter_key) DO UPDATE SET value = MAX(value, excluded.value)
    `);
    for (const [threadId, value] of threadSeq) {
      eventCounter.run(sequenceKey('thread', corpus.projectId, threadId), value);
      eventCounter.run(sequenceKey('turn', corpus.projectId, threadId), value);
    }
  })();
  for (const event of corpus.eventsList.slice(corpus.realPathStart)) {
    kernel.recordRawEvent({
      eventId: event.eventId,
      projectId: corpus.projectId,
      threadId: event.threadId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      role: event.role,
      rawEventType: event.rawEventType,
      content: event.text,
      occurredAt: event.occurredAt,
      metadata: event.metadata,
    });
  }
}


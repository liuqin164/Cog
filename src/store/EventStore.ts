import Database from 'bun:sqlite';
import { createHash, randomUUID } from 'crypto';
import type { EncryptionProvider } from '../encryption/index.js';
import type { LifeSensitivityTier } from '../security/LifeSensitivity.js';
import type {
  EventAuditPage,
  MemoryEvent,
  MemoryEventCausalityType,
  MemoryEventContext,
  MemoryRawEventType,
  MemoryEventRole,
  MemoryEventType,
  OrderingConfidence,
  StreamType,
} from '../types/index.js';
import { assertLocalDate, localDateFor, resolveProjectClockContext } from '../utils/LocalDateContext.js';

export interface ProjectionCheckpoint {
  projectionName: string;
  lastEventId?: string;
  lastEventTime?: number;
  lastGlobalSeq?: number;
  lastRebuildAt?: number;
  lastFullCount: number;
  lastChecksum?: string;
  status: 'idle' | 'building' | 'ready' | 'degraded' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface AppendEventInput<TPayload = Record<string, unknown>> {
  eventId?: string;
  streamId: string;
  streamType: StreamType;
  eventType: MemoryEventType;
  rawEventType?: MemoryRawEventType;
  eventVersion?: number;
  projectId?: string;
  workspaceId?: string;
  actorId?: string;
  causationId?: string;
  correlationId?: string;
  sourceNeuronId?: string;
  sourceId?: string;
  contentHash?: string;
  threadId?: string;
  sessionId?: string;
  localDate?: string;
  localDateSource?: 'explicit' | 'legacy_unknown';
  timeZone?: string;
  projectTimeZone?: string;
  threadSeq?: number;
  turnId?: string;
  turnSeq?: number;
  eventOrdinal?: number;
  role?: MemoryEventRole;
  parentEventId?: string;
  prevEventId?: string;
  nextEventId?: string;
  causalityType?: MemoryEventCausalityType;
  sourceOffset?: number;
  lineStart?: number;
  lineEnd?: number;
  charStart?: number;
  charEnd?: number;
  orderingConfidence?: OrderingConfidence;
  occurredAt?: number;
  payload: TPayload;
}

const MEMORY_EVENT_COLUMNS = `
  event_id, global_seq, stream_id, stream_type, event_type, raw_event_type, event_version, project_id,
  workspace_id, actor_id, causation_id, correlation_id, source_neuron_id, source_id,
  content_hash, thread_id, session_id, local_date, local_date_source, thread_seq, turn_id, turn_seq,
  event_ordinal, role, parent_event_id, prev_event_id, next_event_id, causality_type,
  source_offset, line_start, line_end, char_start, char_end, ordering_confidence,
  occurred_at, payload_json, payload_hash, created_at
`;

/**
 * How the events a raw-event search matched are ordered.
 *
 * Chronological is for replay and audit: reading a thread back, the order is the
 * point. Relevance is for recall, where the caller wants the event that answers the
 * question and the sequence it sat in is incidental. Ordering every match by
 * `global_seq` made the oldest hit the best hit, so the newest and most apt answer
 * never reached the caller.
 *
 * Declared once. It was written out in full in two files, and a union that means one
 * thing should not have two definitions to drift apart.
 */
export type RawEventOrder = 'chronological' | 'relevance';

export class EventStore {
  private ftsRebuilds = 0;
  private readonly validatedLocalDates = new Set<string>();
  private readonly appendListeners = new Set<(event: MemoryEvent) => void>();
  private db: Database;
  private ownsDb = true;

  constructor(dbPath: string | Database = ':memory:', private readonly encryptionProvider?: EncryptionProvider, private readonly projectTimeZone?: string) {
    if (dbPath instanceof Database) {
      this.db = dbPath;
      this.ownsDb = false;
    } else {
      this.db = new Database(dbPath);
    }
    this.initializeSchema();
  }

  getProjectTimeZone(): string | undefined { return this.projectTimeZone; }

  getDatabase(): Database { return this.db; }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id TEXT PRIMARY KEY,
        global_seq INTEGER,
        stream_id TEXT NOT NULL,
        stream_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        raw_event_type TEXT,
        event_version INTEGER NOT NULL,
        project_id TEXT,
        project_scope TEXT NOT NULL DEFAULT '',
        workspace_id TEXT,
        actor_id TEXT,
        causation_id TEXT,
        correlation_id TEXT,
        source_neuron_id TEXT,
        source_id TEXT,
        content_hash TEXT,
        thread_id TEXT,
        session_id TEXT,
        local_date TEXT,
        local_date_source TEXT NOT NULL DEFAULT 'legacy_unknown',
        thread_seq INTEGER,
        turn_id TEXT,
        turn_seq INTEGER,
        event_ordinal INTEGER,
        role TEXT,
        parent_event_id TEXT,
        prev_event_id TEXT,
        next_event_id TEXT,
        causality_type TEXT,
        source_offset INTEGER,
        line_start INTEGER,
        line_end INTEGER,
        char_start INTEGER,
        char_end INTEGER,
        ordering_confidence TEXT,
        occurred_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        UNIQUE (project_scope, stream_id, event_version)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_events_stream
        ON memory_events(stream_type, stream_id, event_version);

      CREATE INDEX IF NOT EXISTS idx_memory_events_type_time
        ON memory_events(event_type, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_events_global_seq
        ON memory_events(global_seq);

      CREATE INDEX IF NOT EXISTS idx_memory_events_thread_order
        ON memory_events(thread_id, thread_seq, event_ordinal, global_seq);

      CREATE INDEX IF NOT EXISTS idx_memory_events_parent
        ON memory_events(parent_event_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_events_fts USING fts5(
        event_id UNINDEXED,
        text,
        project_id UNINDEXED,
        workspace_id UNINDEXED,
        thread_id UNINDEXED,
        session_id UNINDEXED,
        local_date UNINDEXED,
        role UNINDEXED,
        raw_event_type UNINDEXED,
        tokenize='unicode61'
      );

      CREATE TABLE IF NOT EXISTS memory_event_cjk_terms (
        term TEXT NOT NULL,
        event_id TEXT NOT NULL,
        global_seq INTEGER NOT NULL,
        PRIMARY KEY (term, event_id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_memory_event_cjk_terms_seq
        ON memory_event_cjk_terms(term, global_seq, event_id);

      CREATE TABLE IF NOT EXISTS event_sequence_counters (
        counter_key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
    this.ensureCompatibilityColumns();
    this.seedSequenceCounters();
  }

  private ensureCompatibilityColumns(): void {
    const rows = this.db.prepare(`PRAGMA table_info(memory_events)`).all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    const addColumn = (name: string, ddl: string): void => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE memory_events ADD COLUMN ${ddl};`);
    };

    addColumn('global_seq', 'global_seq INTEGER');
    addColumn('raw_event_type', 'raw_event_type TEXT');
    addColumn('workspace_id', 'workspace_id TEXT');
    addColumn('source_id', 'source_id TEXT');
    addColumn('content_hash', 'content_hash TEXT');
    addColumn('thread_id', 'thread_id TEXT');
    addColumn('session_id', 'session_id TEXT');
    addColumn('local_date', 'local_date TEXT');
    addColumn('local_date_source', "local_date_source TEXT NOT NULL DEFAULT 'legacy_unknown'");
    addColumn('thread_seq', 'thread_seq INTEGER');
    addColumn('turn_id', 'turn_id TEXT');
    addColumn('turn_seq', 'turn_seq INTEGER');
    addColumn('event_ordinal', 'event_ordinal INTEGER');
    addColumn('role', 'role TEXT');
    addColumn('parent_event_id', 'parent_event_id TEXT');
    addColumn('prev_event_id', 'prev_event_id TEXT');
    addColumn('next_event_id', 'next_event_id TEXT');
    addColumn('causality_type', 'causality_type TEXT');
    addColumn('source_offset', 'source_offset INTEGER');
    addColumn('line_start', 'line_start INTEGER');
    addColumn('line_end', 'line_end INTEGER');
    addColumn('char_start', 'char_start INTEGER');
    addColumn('char_end', 'char_end INTEGER');
    addColumn('ordering_confidence', 'ordering_confidence TEXT');

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_global_seq ON memory_events(global_seq);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_thread_order ON memory_events(thread_id, thread_seq, event_ordinal, global_seq);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_parent ON memory_events(parent_event_id);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS import_source_anchors (
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        import_anchor TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, source_id, import_anchor)
      );
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_events_fts USING fts5(
        event_id UNINDEXED,
        text,
        project_id UNINDEXED,
        workspace_id UNINDEXED,
        thread_id UNINDEXED,
        session_id UNINDEXED,
        local_date UNINDEXED,
        role UNINDEXED,
        raw_event_type UNINDEXED,
        tokenize='unicode61'
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_event_cjk_terms (
        term TEXT NOT NULL,
        event_id TEXT NOT NULL,
        global_seq INTEGER NOT NULL,
        PRIMARY KEY (term, event_id)
      ) WITHOUT ROWID;
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_event_cjk_terms_seq ON memory_event_cjk_terms(term, global_seq, event_id);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_event_fts_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.rebuildRawEventFtsIfNeeded();
    this.rebuildCjkTermsIfNeeded();
  }

  /**
   * Observe committed appends. Returns the off switch.
   *
   * Notified after the transaction commits, so a listener never sees a row that a rollback removed.
   * A listener that throws is swallowed: the ledger write is already durable and an observer's bug
   * must not turn it into a caller's error. Only new rows are announced — an import-anchor conflict
   * returns the row already in the ledger, which was announced when it was written.
   */
  onAppend(listener: (event: MemoryEvent) => void): () => void {
    this.appendListeners.add(listener);
    return () => {
      this.appendListeners.delete(listener);
    };
  }

  append<TPayload = Record<string, unknown>>(input: AppendEventInput<TPayload>, retry = 0): MemoryEvent<TPayload> {
    try {
      const event = this.db.transaction(() => this.appendAtomic(input))();
      for (const listener of [...this.appendListeners]) {
        try {
          listener(event as MemoryEvent);
        } catch {
          // Deliberately swallowed; see onAppend().
        }
      }
      return event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const streamConflict = /UNIQUE constraint failed: memory_events\.(?:project_scope, memory_events\.)?stream_id(?:, memory_events\.event_version)?/.test(message);
      const anchorConflict = message === 'import_anchor_already_exists';
      if (streamConflict && input.eventVersion === undefined && retry < 5) {
        return this.append(input, retry + 1);
      }
      if (!anchorConflict) throw error;
      const metadata = (input.payload as { metadata?: Record<string, unknown> } | undefined)?.metadata;
      const anchor = typeof metadata?.importAnchor === 'string' ? metadata.importAnchor : undefined;
      const existing = anchor && input.projectId !== undefined && input.sourceId
        ? this.findImportedEventAnchor(input.projectId, input.sourceId, anchor)
        : null;
      if (!existing) throw error;
      const contentHash = input.contentHash ?? createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
      if (existing.contentHash !== contentHash) throw new Error(`import_anchor_content_conflict:${anchor}`);
      return existing as MemoryEvent<TPayload>;
    }
  }

  private appendAtomic<TPayload>(input: AppendEventInput<TPayload>): MemoryEvent<TPayload> {
    const eventVersion = input.eventVersion ?? this.getNextEventVersion(input.streamId, input.projectId ?? '');
    const occurredAt = input.occurredAt ?? Date.now();
    if (!Number.isFinite(occurredAt) || Math.abs(occurredAt) > 8_640_000_000_000_000) throw new Error('invalid_event_timestamp');
    const payloadJson = JSON.stringify(input.payload);
    const storedPayloadJson = this.encodePayload(payloadJson);
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
    const threadId = input.threadId ?? (input.streamType === 'thread' ? input.streamId : undefined);
    const threadSeq = input.threadSeq ?? (threadId ? this.getNextThreadSeq(threadId, input.projectId ?? '') : undefined);
    const globalSeq = this.getNextGlobalSeq();
    const createdAt = Date.now();
    // A caller-provided date is evidence supplied by the caller, never the
    // clock used to prove a generated date. Compute the clock independently
    // so generated provenance cannot be forged by self-comparison.
    if (input.localDateSource && input.localDateSource !== 'explicit' && input.localDateSource !== 'legacy_unknown') {
      throw new Error('invalid_local_date_source');
    }
    if (input.projectTimeZone && this.projectTimeZone && input.projectTimeZone !== this.projectTimeZone) {
      throw new Error('project_timezone_override_forbidden');
    }
    const clock = resolveProjectClockContext({ now: occurredAt, timeZone: input.timeZone, projectTimeZone: this.projectTimeZone ?? input.projectTimeZone });
    const localDate = input.localDate ?? clock.localDateNow;
    const localDateSource = input.localDateSource ?? (input.localDate
      ? 'explicit'
      : clock.source === 'explicit'
        ? 'generated_explicit_timezone'
        : clock.source === 'project_config'
          ? 'generated_project_timezone'
          : clock.source === 'host_environment'
            ? 'generated_host_timezone'
            : 'generated_utc_fallback');
    if (localDateSource === 'explicit' && !input.localDate) throw new Error('explicit_local_date_required');
    // Resolver validation already covers generated dates. Re-check only data
    // supplied by a caller so bulk ingestion does not pay the civil-date
    // round-trip cost twice for every event.
    if (input.localDate) {
      this.assertExplicitLocalDate(localDate, clock.timeZone);
      if (localDateSource === 'explicit' && localDate !== localDateFor(occurredAt, clock.timeZone)) throw new Error('explicit_local_date_timestamp_mismatch');
    }
    if (localDateSource.startsWith('generated_') && localDate !== clock.localDateNow) throw new Error('generated_local_date_mismatch');
    const event: MemoryEvent<TPayload> = {
      eventId: input.eventId || `evt-${randomUUID()}`,
      globalSeq,
      streamId: input.streamId,
      streamType: input.streamType,
      eventType: input.eventType,
      rawEventType: input.rawEventType,
      eventVersion,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      causationId: input.causationId,
      correlationId: input.correlationId,
      sourceNeuronId: input.sourceNeuronId,
      sourceId: input.sourceId,
      contentHash: input.contentHash ?? payloadHash,
      threadId,
      sessionId: input.sessionId,
      localDate,
      localDateSource,
      threadSeq,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      eventOrdinal: input.eventOrdinal,
      role: input.role,
      parentEventId: input.parentEventId,
      prevEventId: input.prevEventId,
      nextEventId: input.nextEventId,
      causalityType: input.causalityType,
      sourceOffset: input.sourceOffset,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      charStart: input.charStart,
      charEnd: input.charEnd,
      orderingConfidence: input.orderingConfidence ?? (threadSeq !== undefined || input.eventOrdinal !== undefined || input.sourceOffset !== undefined || input.lineStart !== undefined ? 'high' : 'low'),
      occurredAt,
      payload: input.payload,
      payloadHash,
      createdAt,
      ingestedAt: createdAt
    };

    const insert = () => this.db.prepare(`
      INSERT INTO memory_events (
        event_id, global_seq, stream_id, stream_type, event_type, raw_event_type, event_version, project_id, project_scope,
        workspace_id, actor_id, causation_id, correlation_id, source_neuron_id, source_id,
        content_hash, thread_id, session_id, local_date, local_date_source, thread_seq, turn_id, turn_seq,
        event_ordinal, role, parent_event_id, prev_event_id, next_event_id, causality_type,
        source_offset, line_start, line_end, char_start, char_end, ordering_confidence,
        occurred_at, payload_json, payload_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.globalSeq ?? null,
      event.streamId,
      event.streamType,
      event.eventType,
      event.rawEventType || null,
      event.eventVersion,
      event.projectId ?? null,
      event.projectId ?? '',
      event.workspaceId || null,
      event.actorId || null,
      event.causationId || null,
      event.correlationId || null,
      event.sourceNeuronId || null,
      event.sourceId || null,
      event.contentHash || null,
      event.threadId || null,
      event.sessionId || null,
      event.localDate || null,
      event.localDateSource || 'legacy_unknown',
      event.threadSeq ?? null,
      event.turnId || null,
      event.turnSeq ?? null,
      event.eventOrdinal ?? null,
      event.role || null,
      event.parentEventId || null,
      event.prevEventId || null,
      event.nextEventId || null,
      event.causalityType || null,
      event.sourceOffset ?? null,
      event.lineStart ?? null,
      event.lineEnd ?? null,
      event.charStart ?? null,
      event.charEnd ?? null,
      event.orderingConfidence || null,
      event.occurredAt,
      storedPayloadJson,
      event.payloadHash,
      event.createdAt
    );
    this.assertLinkedEventScopes(event.projectId, [event.parentEventId, event.prevEventId, event.nextEventId]);
    insert();
    this.advanceSequence(sequenceKey('event', event.projectId ?? '', event.streamId), event.eventVersion);
    if (event.threadId && event.threadSeq !== undefined) this.advanceSequence(sequenceKey('thread', event.projectId ?? '', event.threadId), event.threadSeq);
    if (event.threadId && event.turnSeq !== undefined) this.advanceSequence(sequenceKey('turn', event.projectId ?? '', event.threadId), event.turnSeq);
    this.upsertImportAnchor(event);
    this.upsertRawEventFts(event);
    return event;
  }

  private assertExplicitLocalDate(localDate: string, timeZone: string): void {
    const key = `${timeZone}\0${localDate}`;
    if (this.validatedLocalDates.has(key)) return;
    assertLocalDate(localDate, timeZone);
    // Keep the cache bounded for long-lived import processes.
    if (this.validatedLocalDates.size >= 512) this.validatedLocalDates.clear();
    this.validatedLocalDates.add(key);
  }

  private upsertImportAnchor(event: MemoryEvent<unknown>): void {
    const metadata = (event.payload as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    const anchor = typeof metadata?.importAnchor === 'string' ? metadata.importAnchor : undefined;
    if (!anchor || event.projectId === undefined || !event.sourceId || !event.contentHash) return;
    this.db.prepare(`
      INSERT INTO import_source_anchors (project_id, source_id, import_anchor, event_id, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, source_id, import_anchor) DO NOTHING
    `).run(event.projectId, event.sourceId, anchor, event.eventId, event.contentHash, event.createdAt);
    const inserted = this.db.prepare(`SELECT event_id FROM import_source_anchors WHERE project_id = ? AND source_id = ? AND import_anchor = ?`)
      .get(event.projectId, event.sourceId, anchor) as { event_id?: string } | null;
    if (inserted?.event_id !== event.eventId) {
      const existingEvent = inserted?.event_id
        ? this.db.prepare(`SELECT 1 FROM memory_events WHERE event_id = ?`).get(inserted.event_id)
        : null;
      if (!existingEvent) {
        this.db.prepare(`
          UPDATE import_source_anchors
          SET event_id = ?, content_hash = ?, created_at = ?
          WHERE project_id = ? AND source_id = ? AND import_anchor = ?
        `).run(event.eventId, event.contentHash, event.createdAt, event.projectId, event.sourceId, anchor);
        return;
      }
      throw new Error('import_anchor_already_exists');
    }
  }

  getNextGlobalSeq(): number {
    return this.nextSequence('global');
  }

  getNextEventVersion(streamId: string, projectId?: string): number {
    return this.nextSequence(sequenceKey('event', projectId ?? '', streamId));
  }

  getNextThreadSeq(threadId: string, projectId?: string): number {
    return this.nextSequence(sequenceKey('thread', projectId ?? '', threadId));
  }

  getNextTurnSeq(threadId: string, projectId?: string): number {
    return this.nextSequence(sequenceKey('turn', projectId ?? '', threadId));
  }

  private nextSequence(key: string): number {
    const row = this.db.prepare(`
      INSERT INTO event_sequence_counters(counter_key,value) VALUES(?,1)
      ON CONFLICT(counter_key) DO UPDATE SET value=value+1
      RETURNING value
    `).get(key) as { value: number };
    return row.value;
  }

  private advanceSequence(key: string, value: number): void {
    this.db.prepare(`INSERT INTO event_sequence_counters(counter_key,value) VALUES(?,?)
      ON CONFLICT(counter_key) DO UPDATE SET value=MAX(value,excluded.value)`).run(key, value);
  }

  private seedSequenceCounters(): void {
    const upsert = this.db.prepare(`INSERT INTO event_sequence_counters(counter_key,value) VALUES(?,?)
      ON CONFLICT(counter_key) DO UPDATE SET value=MAX(value,excluded.value)`);
    const global = this.db.prepare(`SELECT COALESCE(MAX(global_seq),0) AS value FROM memory_events`).get() as { value: number };
    upsert.run('global', global.value);
    for (const row of this.db.prepare(`SELECT project_scope,stream_id,MAX(event_version) AS value FROM memory_events GROUP BY project_scope,stream_id`).all() as Array<{ project_scope: string; stream_id: string; value: number }>) {
      upsert.run(sequenceKey('event', row.project_scope, row.stream_id), row.value);
    }
    for (const row of this.db.prepare(`SELECT project_scope,COALESCE(thread_id,stream_id) AS thread_id,MAX(thread_seq) AS thread_value,MAX(turn_seq) AS turn_value
      FROM memory_events WHERE thread_id IS NOT NULL OR stream_type='thread' GROUP BY project_scope,COALESCE(thread_id,stream_id)`).all() as Array<{ project_scope: string; thread_id: string; thread_value?: number; turn_value?: number }>) {
      if (row.thread_value != null) upsert.run(sequenceKey('thread', row.project_scope, row.thread_id), row.thread_value);
      if (row.turn_value != null) upsert.run(sequenceKey('turn', row.project_scope, row.thread_id), row.turn_value);
    }
  }

  getEventsAfter(lastEventTime?: number): MemoryEvent[] {
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE (? IS NULL OR occurred_at > ?)
      ORDER BY COALESCE(global_seq, 0) ASC, occurred_at ASC, event_id ASC
    `).all(lastEventTime ?? null, lastEventTime ?? null) as any[];

    return rows.map((row) => this.mapRow(row));
  }

  getEventsAfterGlobalSeq(lastGlobalSeq?: number, throughGlobalSeq?: number): MemoryEvent[] {
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE (? IS NULL OR COALESCE(global_seq, 0) > ?)
        AND (? IS NULL OR COALESCE(global_seq, 0) <= ?)
      ORDER BY COALESCE(global_seq, 0) ASC, occurred_at ASC, event_id ASC
    `).all(
      lastGlobalSeq ?? null,
      lastGlobalSeq ?? null,
      throughGlobalSeq ?? null,
      throughGlobalSeq ?? null
    ) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  getEventsByGlobalSeqPage(options: {
    afterGlobalSeq?: number;
    throughGlobalSeq: number;
    eventTypes?: string[];
    projectId?: string;
    limit?: number;
  }): MemoryEvent[] {
    const conditions = ['COALESCE(global_seq,0)>?', 'COALESCE(global_seq,0)<=?'];
    const params: Array<string | number> = [options.afterGlobalSeq ?? 0, options.throughGlobalSeq];
    if (options.eventTypes?.length) {
      conditions.push(`event_type IN (${options.eventTypes.map(() => '?').join(',')})`);
      params.push(...options.eventTypes);
    }
    if (options.projectId !== undefined) {
      conditions.push(`COALESCE(project_id,'')=?`);
      params.push(options.projectId);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 500, 5_000)));
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(global_seq,0), occurred_at, event_id
      LIMIT ?
    `).all(...params) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  getLatestGlobalSeq(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(global_seq), 0) AS value FROM memory_events`).get() as { value: number };
    return row.value;
  }

  findImportedEventAnchor(projectId: string, sourceId: string, importAnchor: string): MemoryEvent | null {
    const row = this.db.prepare(`
      SELECT ${qualifiedMemoryEventColumns('e')}
      FROM import_source_anchors a
      JOIN memory_events e ON e.event_id = a.event_id
      WHERE a.project_id = ? AND a.source_id = ? AND a.import_anchor = ?
    `).get(projectId, sourceId, importAnchor) as any;
    return row ? this.mapRow(row) : null;
  }

  getLatestEvent(): MemoryEvent | null {
    const row = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      ORDER BY COALESCE(global_seq, 0) DESC, occurred_at DESC, event_id DESC
      LIMIT 1
    `).get() as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * The conversational rows the time-awareness block reads (F2 of #156), reduced to what a time
   * signal needs: when a turn happened and which side spoke. No payload and no text — the context
   * block is not a second read path for the ledger's words.
   */
  listRawEventOccurrences(options: {
    projectId?: string;
    from?: number;
    to?: number;
    limit?: number;
  } = {}): Array<{ eventId: string; occurredAt: number; role?: MemoryEventRole }> {
    const conditions = [`event_type = 'RAW_EVENT_RECORDED'`];
    const params: Array<string | number> = [];
    if (options.projectId !== undefined) {
      conditions.push(`COALESCE(project_id, '') = ?`);
      params.push(options.projectId);
    }
    if (options.from !== undefined) {
      conditions.push('occurred_at >= ?');
      params.push(options.from);
    }
    if (options.to !== undefined) {
      conditions.push('occurred_at <= ?');
      params.push(options.to);
    }
    params.push(Math.max(1, Math.min(50_000, options.limit ?? 5_000)));
    const rows = this.db.prepare(`
      SELECT event_id, occurred_at, role
      FROM memory_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY occurred_at ASC, event_id ASC
      LIMIT ?
    `).all(...params) as Array<{ event_id: string; occurred_at: number; role: string | null }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      occurredAt: Number(row.occurred_at),
      role: (row.role ?? undefined) as MemoryEventRole | undefined,
    }));
  }

  /** The most recent conversational row at or before an instant, optionally by speaker. */
  getLatestRawEventOccurrence(options: {
    projectId?: string;
    atOrBefore?: number;
    role?: MemoryEventRole;
  } = {}): { eventId: string; occurredAt: number; role?: MemoryEventRole } | null {
    const conditions = [`event_type = 'RAW_EVENT_RECORDED'`];
    const params: Array<string | number> = [];
    if (options.projectId !== undefined) {
      conditions.push(`COALESCE(project_id, '') = ?`);
      params.push(options.projectId);
    }
    if (options.atOrBefore !== undefined) {
      conditions.push('occurred_at <= ?');
      params.push(options.atOrBefore);
    }
    if (options.role !== undefined) {
      conditions.push('role = ?');
      params.push(options.role);
    }
    const row = this.db.prepare(`
      SELECT event_id, occurred_at, role
      FROM memory_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT 1
    `).get(...params) as { event_id: string; occurred_at: number; role: string | null } | null;
    if (!row) return null;
    return { eventId: row.event_id, occurredAt: Number(row.occurred_at), role: (row.role ?? undefined) as MemoryEventRole | undefined };
  }

  listRawEventsAfterGlobalSeq(options: {
    projectId?: string;
    workspaceId?: string;
    threadId?: string;
    sessionId?: string;
    afterGlobalSeq?: number;
    limit?: number;
  } = {}): MemoryEvent[] {
    const conditions = [`event_type = 'RAW_EVENT_RECORDED'`];
    const params: Array<string | number> = [];
    if (options.projectId !== undefined) {
      conditions.push("COALESCE(project_id, '') = ?");
      params.push(options.projectId);
    }
    if (options.workspaceId) {
      conditions.push('workspace_id = ?');
      params.push(options.workspaceId);
    }
    if (options.threadId) {
      conditions.push('thread_id = ?');
      params.push(options.threadId);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.afterGlobalSeq !== undefined) {
      conditions.push('COALESCE(global_seq, 0) > ?');
      params.push(options.afterGlobalSeq);
    }
    params.push(Math.max(1, options.limit ?? 100));
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(global_seq, 0) ASC, occurred_at ASC, event_id ASC
      LIMIT ?
    `).all(...params) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  getEventsByStreamId(streamId: string, projectId?: string): MemoryEvent[] {
    const scope = projectId === undefined ? '' : ` AND project_scope=?`;
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE stream_id = ?${scope}
      ORDER BY event_version ASC, COALESCE(global_seq, 0) ASC, event_id ASC
    `).all(streamId, ...(projectId === undefined ? [] : [projectId])) as any[];

    return rows.map((row) => this.mapRow(row));
  }

  queryEvents(
    page: number = 1,
    pageSize: number = 20,
    filters?: {
      streamId?: string[];
      streamType?: StreamType[];
      eventType?: MemoryEventType[];
      actorId?: string[];
      causationId?: string[];
      correlationId?: string[];
      projectId?: string[];
      workspaceId?: string[];
      threadId?: string[];
      sessionId?: string[];
      localDate?: string;
      startTime?: number;
      endTime?: number;
      sinceGlobalSeq?: number;
      untilGlobalSeq?: number;
      order?: 'asc' | 'desc';
    }
  ): EventAuditPage {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, pageSize);
    const offset = (safePage - 1) * safePageSize;
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filters?.streamId?.length) {
      conditions.push(`stream_id IN (${filters.streamId.map(() => '?').join(', ')})`);
      params.push(...filters.streamId);
    }
    if (filters?.streamType?.length) {
      conditions.push(`stream_type IN (${filters.streamType.map(() => '?').join(', ')})`);
      params.push(...filters.streamType);
    }
    if (filters?.eventType?.length) {
      conditions.push(`event_type IN (${filters.eventType.map(() => '?').join(', ')})`);
      params.push(...filters.eventType);
    }
    if (filters?.actorId?.length) {
      conditions.push(`actor_id IN (${filters.actorId.map(() => '?').join(', ')})`);
      params.push(...filters.actorId);
    }
    if (filters?.causationId?.length) {
      conditions.push(`causation_id IN (${filters.causationId.map(() => '?').join(', ')})`);
      params.push(...filters.causationId);
    }
    if (filters?.correlationId?.length) {
      conditions.push(`correlation_id IN (${filters.correlationId.map(() => '?').join(', ')})`);
      params.push(...filters.correlationId);
    }
    if (filters?.projectId?.length) {
      conditions.push(`COALESCE(project_id, '') IN (${filters.projectId.map(() => '?').join(', ')})`);
      params.push(...filters.projectId);
    }
    if (filters?.workspaceId?.length) {
      conditions.push(`workspace_id IN (${filters.workspaceId.map(() => '?').join(', ')})`);
      params.push(...filters.workspaceId);
    }
    if (filters?.threadId?.length) {
      conditions.push(`thread_id IN (${filters.threadId.map(() => '?').join(', ')})`);
      params.push(...filters.threadId);
    }
    if (filters?.sessionId?.length) {
      conditions.push(`session_id IN (${filters.sessionId.map(() => '?').join(', ')})`);
      params.push(...filters.sessionId);
    }
    if (filters?.localDate) {
      conditions.push('local_date = ?');
      params.push(filters.localDate);
    }
    if (filters?.startTime !== undefined) {
      conditions.push('occurred_at >= ?');
      params.push(filters.startTime);
    }
    if (filters?.endTime !== undefined) {
      conditions.push('occurred_at < ?');
      params.push(filters.endTime);
    }
    if (filters?.sinceGlobalSeq !== undefined) {
      conditions.push('COALESCE(global_seq, 0) >= ?');
      params.push(filters.sinceGlobalSeq);
    }
    if (filters?.untilGlobalSeq !== undefined) {
      conditions.push('COALESCE(global_seq, 0) <= ?');
      params.push(filters.untilGlobalSeq);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderSql = filters?.order === 'asc'
      ? 'COALESCE(global_seq, 0) ASC, occurred_at ASC, event_id ASC'
      : 'COALESCE(global_seq, 0) DESC, occurred_at DESC, event_id DESC';
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM memory_events ${where}
    `).get(...params) as { count: number } | null;
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      ${where}
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...params, safePageSize, offset) as any[];

    return {
      page: safePage,
      pageSize: safePageSize,
      total: totalRow?.count || 0,
      records: rows.map((row) => this.mapRow(row)),
      appliedFilters: {
        streamId: filters?.streamId,
        streamType: filters?.streamType,
        eventType: filters?.eventType,
        actorId: filters?.actorId,
        causationId: filters?.causationId,
        correlationId: filters?.correlationId,
        projectId: filters?.projectId,
        workspaceId: filters?.workspaceId,
        threadId: filters?.threadId,
        sessionId: filters?.sessionId,
        localDate: filters?.localDate,
        startTime: filters?.startTime,
        endTime: filters?.endTime,
        sinceGlobalSeq: filters?.sinceGlobalSeq,
        untilGlobalSeq: filters?.untilGlobalSeq,
        order: filters?.order,
      }
    };
  }

  /**
   * Stream one project's ledger in chronological order (#307). `queryEvents` pages with OFFSET,
   * which re-scans the prefix for every page; a decade-size forget or export should read once.
   */
  *iterateProjectEvents(projectId: string, startTime?: number, endTime?: number): IterableIterator<MemoryEvent> {
    const conditions = [`COALESCE(project_id, '') = ?`];
    const params: Array<string | number> = [projectId];
    if (startTime !== undefined) {
      conditions.push('occurred_at >= ?');
      params.push(startTime);
    }
    if (endTime !== undefined) {
      conditions.push('occurred_at < ?');
      params.push(endTime);
    }
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(global_seq, 0) ASC, occurred_at ASC, event_id ASC
    `).iterate(...params) as IterableIterator<any>;
    for (const row of rows) yield this.mapRow(row);
  }

  getEvent(eventId: string): MemoryEvent | null {
    const row = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE event_id = ?
    `).get(eventId) as any;
    return row ? this.mapRow(row) : null;
  }

  /**
   * One thread's events in thread order.
   *
   * Two indexed arms instead of one `OR`. The `OR` kept SQLite off
   * `idx_memory_events_thread_order` — the index built for exactly this read,
   * and off `idx_memory_events_stream` for the stream-spelled thread — so every
   * call scanned the whole event table and sorted it in a temp B-tree: 6.5 ms to
   * return a 60-event thread from a 20k-event store, on a path recall calls once
   * per returned memory. `project_scope` is the indexed spelling of
   * `COALESCE(project_id, '')`, which is how every writer stores it and how
   * `getEventsByStreamId` already reads it.
   */
  getThreadEvents(
    threadId: string,
    options: {
      projectId?: string;
      sessionId?: string;
      localDate?: string;
      limit?: number;
    } = {},
  ): MemoryEvent[] {
    const filters: string[] = [];
    const filterParams: Array<string | number> = [];
    if (options.projectId !== undefined) {
      filters.push('project_scope = ?');
      filterParams.push(options.projectId);
    }
    if (options.sessionId) {
      filters.push('session_id = ?');
      filterParams.push(options.sessionId);
    }
    if (options.localDate) {
      filters.push('local_date = ?');
      filterParams.push(options.localDate);
    }
    const filtersSql = filters.map((filter) => ` AND ${filter}`).join('');

    const boundedLimit = options.limit === undefined ? undefined : Math.max(1, Math.min(Math.trunc(options.limit), 10_000));
    const limitSql = boundedLimit === undefined ? '' : 'LIMIT ?';
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM (
        SELECT ${MEMORY_EVENT_COLUMNS}
        FROM memory_events
        WHERE thread_id = ?${filtersSql}
        UNION ALL
        SELECT ${MEMORY_EVENT_COLUMNS}
        FROM memory_events
        WHERE thread_id IS NULL AND stream_type = 'thread' AND stream_id = ?${filtersSql}
      )
      ORDER BY COALESCE(thread_seq, event_version) ASC,
               COALESCE(event_ordinal, 0) ASC,
               COALESCE(global_seq, 0) ASC,
               event_id ASC
      ${limitSql}
    `).all(
      threadId, ...filterParams,
      threadId, ...filterParams,
      ...(boundedLimit === undefined ? [] : [boundedLimit]),
    ) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  getEventContext(eventId: string, options: { before?: number; after?: number } = {}): MemoryEventContext | null {
    const event = this.getEvent(eventId);
    if (!event) return null;
    const beforeCount = Math.max(0, options.before ?? 2);
    const afterCount = Math.max(0, options.after ?? 2);
    const ordered = event.threadId
      ? this.getThreadEvents(event.threadId, { projectId: event.projectId })
      : this.getEventsByStreamId(event.streamId, event.projectId ?? '');
    const index = ordered.findIndex((item) => item.eventId === event.eventId);
    const before = index >= 0 ? ordered.slice(Math.max(0, index - beforeCount), index) : [];
    const after = index >= 0 ? ordered.slice(index + 1, index + 1 + afterCount) : [];
    return {
      event,
      before,
      after,
      parent: event.parentEventId ? this.getEventInScope(event.parentEventId, event.projectId) : undefined,
      children: this.getChildEvents(event.eventId, event.projectId),
    };
  }

  searchRawEvents(
    query: string,
    options: {
      projectId?: string;
      workspaceId?: string;
      threadId?: string;
      sessionId?: string;
      localDate?: string;
      startTime?: number;
      endTime?: number;
      limit?: number;
      orderBy?: RawEventOrder;
    } = {},
  ): MemoryEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    const ftsQuery = this.toRawEventFtsQuery(query);
    if (!ftsQuery) return [];

    const columns = MEMORY_EVENT_COLUMNS.split(',').map((column) => `e.${column.trim()}`).join(', ');
    const scope = this.rawEventScopeConditions(options);

    const newestFirst = options.orderBy === 'relevance';
    const cjkTerm = this.cjkQueryTerm(query);
    if (cjkTerm) {
      const order = newestFirst ? 'DESC' : 'ASC';
      const rows = this.db.prepare(`
        SELECT ${columns}
        FROM memory_event_cjk_terms t
        JOIN memory_events e ON e.event_id = t.event_id
        WHERE t.term = ?${scope.sql}
        ORDER BY t.global_seq ${order}, t.event_id ${order}
        LIMIT ?
      `).all(cjkTerm, ...scope.params, limit) as any[];
      if (rows.length > 0 || this.cjkIndexComplete()) return rows.map((row) => this.mapRow(row));
    }

    const exactOrder = options.orderBy === 'relevance'
      ? 'bm25(memory_events_fts) ASC, COALESCE(e.global_seq, 0) ASC, e.event_id ASC'
      : `COALESCE(e.global_seq, 0) ASC,
               COALESCE(e.thread_seq, e.event_version) ASC,
               COALESCE(e.event_ordinal, 0) ASC,
               e.event_id ASC`;
    const exact = this.db.prepare(`
      SELECT ${columns}
      FROM memory_events_fts
      JOIN memory_events e ON e.event_id = memory_events_fts.event_id
      WHERE memory_events_fts MATCH ?${scope.sql}
      ORDER BY ${exactOrder}
      LIMIT ?
    `).all(ftsQuery, ...scope.params, limit) as any[];
    if (exact.length > 0) return exact.map((row) => this.mapRow(row));

    const loose = this.boundedRawEventCandidates(query, options, limit);
    if (loose.length > 0) return loose.map((row) => this.mapRow(row));

    const indexed = this.cjkPostingSearch(query, options, limit);
    if (indexed) return indexed.map((row) => this.mapRow(row));

    return this.fallbackRawTextSearch(query, options, limit);
  }

  private rawEventScopeConditions(options: {
    projectId?: string;
    workspaceId?: string;
    threadId?: string;
    sessionId?: string;
    localDate?: string;
    startTime?: number;
    endTime?: number;
  }): { sql: string; params: Array<string | number> } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (options.projectId !== undefined) {
      conditions.push("COALESCE(e.project_id, '') = ?");
      params.push(options.projectId);
    }
    if (options.workspaceId) {
      conditions.push('e.workspace_id = ?');
      params.push(options.workspaceId);
    }
    if (options.threadId) {
      conditions.push('e.thread_id = ?');
      params.push(options.threadId);
    }
    if (options.sessionId) {
      conditions.push('e.session_id = ?');
      params.push(options.sessionId);
    }
    if (options.localDate) {
      conditions.push('e.local_date = ?');
      params.push(options.localDate);
    }
    if (options.startTime !== undefined) {
      conditions.push('e.occurred_at >= ?');
      params.push(options.startTime);
    }
    if (options.endTime !== undefined) {
      conditions.push('e.occurred_at < ?');
      params.push(options.endTime);
    }
    return { sql: conditions.map((condition) => ` AND ${condition}`).join(''), params };
  }

  getChildEvents(parentEventId: string, projectId?: string): MemoryEvent[] {
    const queryProject = projectId === undefined ? null : projectId;
    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE parent_event_id = ?
        AND (? IS NULL OR COALESCE(project_id,'') = ?)
      ORDER BY COALESCE(thread_seq, event_version) ASC,
               COALESCE(event_ordinal, 0) ASC,
               COALESCE(global_seq, 0) ASC,
               event_id ASC
    `).all(parentEventId, queryProject, queryProject) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  updateNextEventId(eventId: string, nextEventId: string | undefined): void {
    this.db.transaction(() => {
      const source = this.db.prepare(`SELECT COALESCE(project_id,'') AS scope FROM memory_events WHERE event_id=?`).get(eventId) as { scope: string } | null;
      if (!source) throw new Error('event_link_source_not_found');
      if (nextEventId) this.assertLinkedEventScopes(source.scope, [nextEventId]);
      this.db.prepare(`UPDATE memory_events SET next_event_id=? WHERE event_id=?`).run(nextEventId || null, eventId);
    })();
  }

  private getEventInScope(eventId: string, projectId: string | undefined): MemoryEvent | undefined {
    const event = this.getEvent(eventId);
    return event && (event.projectId ?? '') === (projectId ?? '') ? event : undefined;
  }

  private assertLinkedEventScopes(projectId: string | undefined, eventIds: Array<string | undefined>): void {
    const scope = projectId ?? '';
    for (const eventId of new Set(eventIds.filter((id): id is string => Boolean(id)))) {
      const row = this.db.prepare(`SELECT COALESCE(project_id,'') AS scope FROM memory_events WHERE event_id=?`).get(eventId) as { scope: string } | null;
      if (!row) throw new Error('event_link_target_not_found');
      if (row.scope !== scope) throw new Error('event_link_project_scope_mismatch');
    }
  }

  getEventCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM memory_events`).get() as { count: number } | null;
    return row?.count || 0;
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private mapRow(row: any): MemoryEvent {
    return {
      eventId: row.event_id,
      globalSeq: row.global_seq || undefined,
      streamId: row.stream_id,
      streamType: row.stream_type,
      eventType: row.event_type,
      rawEventType: row.raw_event_type || undefined,
      eventVersion: row.event_version,
      projectId: row.project_id == null ? undefined : String(row.project_id),
      workspaceId: row.workspace_id || undefined,
      actorId: row.actor_id || undefined,
      causationId: row.causation_id || undefined,
      correlationId: row.correlation_id || undefined,
      sourceNeuronId: row.source_neuron_id || undefined,
      sourceId: row.source_id || undefined,
      contentHash: row.content_hash || undefined,
      threadId: row.thread_id || (row.stream_type === 'thread' ? row.stream_id : undefined),
      sessionId: row.session_id || undefined,
      localDate: row.local_date || undefined,
      localDateSource: (row.local_date_source as MemoryEvent['localDateSource'] | undefined) || legacyLocalDateSource(row.payload_json),
      threadSeq: row.thread_seq ?? undefined,
      turnId: row.turn_id || undefined,
      turnSeq: row.turn_seq ?? undefined,
      eventOrdinal: row.event_ordinal ?? undefined,
      role: row.role || undefined,
      parentEventId: row.parent_event_id || undefined,
      prevEventId: row.prev_event_id || undefined,
      nextEventId: row.next_event_id || undefined,
      causalityType: row.causality_type || undefined,
      sourceOffset: row.source_offset ?? undefined,
      lineStart: row.line_start ?? undefined,
      lineEnd: row.line_end ?? undefined,
      charStart: row.char_start ?? undefined,
      charEnd: row.char_end ?? undefined,
      orderingConfidence: row.ordering_confidence || undefined,
      occurredAt: row.occurred_at,
      payload: JSON.parse(this.decodePayload(row.payload_json)),
      payloadHash: row.payload_hash,
      createdAt: row.created_at,
      ingestedAt: row.created_at,
    };
  }

  private upsertRawEventFts(event: MemoryEvent<unknown>): void {
    this.db.prepare(`DELETE FROM memory_events_fts WHERE event_id = ?`).run(event.eventId);
    this.db.prepare(`DELETE FROM memory_event_cjk_terms WHERE event_id = ?`).run(event.eventId);
    if (this.encryptionProvider) return;
    const text = this.extractIndexText(event.payload);
    if (!text.trim()) return;
    this.db.prepare(`
      INSERT INTO memory_events_fts (
        event_id, text, project_id, workspace_id, thread_id, session_id, local_date, role, raw_event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      text,
      event.projectId ?? null,
      event.workspaceId || null,
      event.threadId || null,
      event.sessionId || null,
      event.localDate || null,
      event.role || null,
      event.rawEventType || null,
    );
    const insertTerm = this.db.prepare(`
      INSERT OR IGNORE INTO memory_event_cjk_terms (term, event_id, global_seq) VALUES (?, ?, ?)
    `);
    for (const term of this.cjkTermKeys(text)) insertTerm.run(term, event.eventId, event.globalSeq ?? 0);
    // The term index now covers every row this connection has written, so an
    // empty two-character answer is final instead of a reason to scan.
    this.db.prepare(`
      INSERT INTO memory_event_fts_state (key, value)
      VALUES ('cjk_indexed_rowid', (SELECT COALESCE(MAX(rowid), 0) FROM memory_events))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  }

  private rebuildRawEventFtsIfNeeded(): void {
    if (this.encryptionProvider) {
      this.db.prepare(`DELETE FROM memory_events_fts`).run();
      this.writeFtsState(null, 0);
      return;
    }
    const ftsCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM memory_events_fts`).get() as { count: number } | null)?.count || 0);
    const eventCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM memory_events`).get() as { count: number } | null)?.count || 0);
    const maxRowid = Number((this.db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM memory_events`).get() as { maxRowid: number } | null)?.maxRowid || 0);
    const state = this.readFtsState();

    if (ftsCount >= eventCount) {
      this.writeFtsState(maxRowid, ftsCount);
      return;
    }
    // A short index is expected and permanent: events with no indexable text
    // (state transitions, boundaries) never get a row, so counting rows against
    // events can never converge and would re-index the whole database on every
    // open. The recorded row count is what separates "short by design" from
    // "truncated", which still has to be repaired.
    if (state !== null && state.rowid === maxRowid && state.ftsRows === ftsCount) return;

    const truncated = ftsCount === 0 && eventCount > 0;
    const startRowid = !truncated && state !== null && state.rowid <= maxRowid && ftsCount >= state.ftsRows ? state.rowid : -1;
    if (startRowid < 0) {
      this.db.prepare(`DELETE FROM memory_events_fts`).run();
      this.ftsRebuilds += 1;
    }
    const rows = this.db.prepare(`
      SELECT rowid AS index_rowid, ${MEMORY_EVENT_COLUMNS}
      FROM memory_events
      WHERE rowid > ?
      ORDER BY rowid ASC
    `).all(startRowid) as any[];
    for (const row of rows) {
      this.upsertRawEventFts(this.mapRow(row));
    }
    const indexedCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM memory_events_fts`).get() as { count: number } | null)?.count || 0);
    this.writeFtsState(maxRowid, indexedCount);
    if (startRowid < 0) {
      const terms = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM memory_event_cjk_terms`).get() as { count: number } | null)?.count || 0);
      this.writeCjkState(maxRowid, terms);
    }
  }

  getRawEventFtsState(): { watermark: number | null; maxRowid: number; ftsRows: number; rebuilds: number } {
    const maxRowid = Number((this.db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM memory_events`).get() as { maxRowid: number } | null)?.maxRowid || 0);
    const ftsRows = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM memory_events_fts`).get() as { count: number } | null)?.count || 0);
    return { watermark: this.readFtsState()?.rowid ?? null, maxRowid, ftsRows, rebuilds: this.ftsRebuilds };
  }

  private readFtsState(): { rowid: number; ftsRows: number } | null {
    const rows = this.db.prepare(`SELECT key, value FROM memory_event_fts_state WHERE key IN ('indexed_rowid', 'indexed_fts_rows')`).all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((row) => [row.key, Number(row.value)]));
    const rowid = map.get('indexed_rowid');
    const ftsRows = map.get('indexed_fts_rows');
    if (!Number.isFinite(rowid) || !Number.isFinite(ftsRows)) return null;
    return { rowid: rowid as number, ftsRows: ftsRows as number };
  }

  private writeFtsState(rowid: number | null, ftsRows: number): void {
    if (rowid === null) {
      this.db.prepare(`DELETE FROM memory_event_fts_state`).run();
      return;
    }
    const upsert = this.db.prepare(`
      INSERT INTO memory_event_fts_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.db.transaction(() => {
      upsert.run('indexed_rowid', String(rowid));
      upsert.run('indexed_fts_rows', String(ftsRows));
    })();
  }

  private extractIndexText(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.output === 'string') return record.output;
    if (typeof record.title === 'string') return record.title;
    return '';
  }

  private cjkQueryTerm(query: string): string | null {
    const term = query.trim();
    return /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2}$/.test(term) ? term : null;
  }

  private cjkTermKeys(text: string): string[] {
    const terms = new Set<string>();
    for (const run of text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? []) {
      for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
    }
    return [...terms];
  }

  private readCjkState(): { rowid: number; terms: number } | null {
    const rows = this.db.prepare(`SELECT key, value FROM memory_event_fts_state WHERE key IN ('cjk_indexed_rowid', 'cjk_terms')`).all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((row) => [row.key, Number(row.value)]));
    const rowid = map.get('cjk_indexed_rowid');
    const terms = map.get('cjk_terms');
    if (!Number.isFinite(rowid) || !Number.isFinite(terms)) return null;
    return { rowid: rowid as number, terms: terms as number };
  }

  private writeCjkState(rowid: number | null, terms: number): void {
    if (rowid === null) {
      this.db.prepare(`DELETE FROM memory_event_fts_state WHERE key IN ('cjk_indexed_rowid', 'cjk_terms')`).run();
      return;
    }
    const upsert = this.db.prepare(`
      INSERT INTO memory_event_fts_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.db.transaction(() => {
      upsert.run('cjk_indexed_rowid', String(rowid));
      upsert.run('cjk_terms', String(terms));
    })();
  }

  /** Whether every event the ledger holds has already been read for CJK terms. */
  private cjkIndexComplete(): boolean {
    const maxRowid = Number((this.db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS value FROM memory_events`).get() as { value: number } | null)?.value || 0);
    const state = this.readCjkState();
    return Boolean(state && state.rowid >= maxRowid);
  }

  private rebuildCjkTermsIfNeeded(): void {
    if (this.encryptionProvider) {
      this.db.prepare(`DELETE FROM memory_event_cjk_terms`).run();
      this.writeCjkState(null, 0);
      return;
    }
    const maxRowid = Number((this.db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS value FROM memory_events`).get() as { value: number } | null)?.value || 0);
    const state = this.readCjkState();
    if (state && state.rowid >= maxRowid) return;
    const rows = this.db.prepare(`
      SELECT e.event_id, e.global_seq, f.text
      FROM memory_events e
      JOIN memory_events_fts f ON f.event_id = e.event_id
      WHERE e.rowid > ?
      ORDER BY e.rowid ASC
    `).all(state?.rowid ?? 0) as Array<{ event_id: string; global_seq: number | null; text: string }>;
    const remove = this.db.prepare(`DELETE FROM memory_event_cjk_terms WHERE event_id = ?`);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO memory_event_cjk_terms (term, event_id, global_seq) VALUES (?, ?, ?)`);
    this.db.transaction(() => {
      for (const row of rows) {
        remove.run(row.event_id);
        for (const term of this.cjkTermKeys(row.text)) insert.run(term, row.event_id, row.global_seq ?? 0);
      }
    })();
    const terms = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM memory_event_cjk_terms`).get() as { count: number } | null)?.count || 0);
    this.writeCjkState(maxRowid, terms);
  }

  /** Capped per-term document count, routed through the search path recall itself uses. */
  countRawEventMatches(token: string, options: { projectId?: string; workspaceId?: string; threadId?: string; cap?: number } = {}): number {
    const cap = Math.max(1, Math.min(options.cap ?? 64, 500));
    const ftsQuery = this.toRawEventFtsQuery(token);
    if (!ftsQuery) return 0;
    const scope = this.rawEventScopeConditions(options);
    const cjkTerm = this.cjkQueryTerm(token);
    if (cjkTerm) {
      const rows = this.db.prepare(`
        SELECT 1 FROM memory_event_cjk_terms t
        JOIN memory_events e ON e.event_id = t.event_id
        WHERE t.term = ?${scope.sql}
        LIMIT ?
      `).all(cjkTerm, ...scope.params, cap) as any[];
      if (rows.length > 0 || this.cjkIndexComplete()) return rows.length;
    }
    if (/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}$/u.test(token)) {
      const rows = this.cjkPostingRows(this.rawTextSearchTokens(token), { ...options, orderBy: 'relevance' }, cap);
      if (rows) return rows.length;
    }
    // Only the cap matters: whether a word is held by three events or by the
    // whole ledger is a frequency question, not a ranking one. Asking the
    // ranked search answered it by sorting every match, which is exactly the
    // cost this check exists to avoid (#243).
    const found = this.db.prepare(`
      SELECT 1 FROM memory_events_fts
      JOIN memory_events e ON e.event_id = memory_events_fts.event_id
      WHERE memory_events_fts MATCH ?${scope.sql}
      LIMIT ?
    `).all(ftsQuery, ...scope.params, cap) as any[];
    if (found.length > 0 || this.encryptionProvider) return found.length;
    // The index cannot split a CJK run, so the fallback scan is the only
    // evidence left. It stops at the cap the same way.
    return this.db.prepare(`
      SELECT 1 FROM memory_events_fts
      JOIN memory_events e ON e.event_id = memory_events_fts.event_id
      WHERE LOWER(memory_events_fts.text) LIKE ? ESCAPE '\\'${scope.sql}
      LIMIT ?
    `).all(`%${escapeSqlLike(token)}%`, ...scope.params, cap).length;
  }

  private toRawEventFtsQuery(query: string): string {
    return this.rawEventFtsTokens(query)
      .map((token) => `"${token}"`)
      .join(' ');
  }

  private rawEventFtsOrTokens(query: string): string[] {
    const meaningful = this.rawEventFtsTokens(query).filter((token) => !QUERY_STOP_WORDS.has(token));
    // Every word was a question word; the query still has to search for them.
    return meaningful.length > 0 ? meaningful : this.rawEventFtsTokens(query);
  }

  private boundedRawEventCandidates(
    query: string,
    options: {
      projectId?: string;
      workspaceId?: string;
      threadId?: string;
      sessionId?: string;
      localDate?: string;
      startTime?: number;
      endTime?: number;
      orderBy?: RawEventOrder;
    },
    limit: number,
  ): any[] {
    const tokens = [...new Set(this.rawEventFtsOrTokens(query))].slice(0, 12);
    if (tokens.length === 0) return [];
    const cap = Math.max(limit * 8, 64);
    const order = options.orderBy === 'relevance' ? 'DESC' : 'ASC';
    const columns = MEMORY_EVENT_COLUMNS.split(',').map((column) => `e.${column.trim()}`).join(', ');
    const scope = this.rawEventScopeConditions(options);
    const statement = this.db.prepare(`
      SELECT ${columns}, bm25(memory_events_fts) AS rank
      FROM memory_events_fts
      JOIN memory_events e ON e.event_id = memory_events_fts.event_id
      WHERE memory_events_fts MATCH ?${scope.sql}
      ORDER BY rank ASC, COALESCE(e.global_seq, 0) ${order}, e.event_id ${order}
      LIMIT ?
    `);
    const candidates = new Map<string, { row: any; matched: number; rarest: number; rank: number }>();
    for (const token of tokens) {
      const rows = statement.all(`"${token}"`, ...scope.params, cap) as any[];
      for (const row of rows) {
        const existing = candidates.get(row.event_id);
        if (existing) {
          existing.matched += 1;
          existing.rarest = Math.min(existing.rarest, rows.length);
          existing.rank = Math.min(existing.rank, row.rank);
          continue;
        }
        candidates.set(row.event_id, { row, matched: 1, rarest: rows.length, rank: row.rank });
      }
    }
    return [...candidates.values()]
      .sort((left, right) =>
        right.matched - left.matched
        || left.rarest - right.rarest
        || left.rank - right.rank
        || (options.orderBy === 'relevance'
          ? (right.row.global_seq ?? 0) - (left.row.global_seq ?? 0)
          : (left.row.global_seq ?? 0) - (right.row.global_seq ?? 0))
        || (options.orderBy === 'relevance'
          ? String(right.row.event_id).localeCompare(String(left.row.event_id))
          : String(left.row.event_id).localeCompare(String(right.row.event_id))))
      .slice(0, limit)
      .map((candidate) => candidate.row);
  }

  private rawEventFtsTokens(query: string): string[] {
    return query
      // A hyphen separates words for the index too: `unicode61` indexes
      // `CODE-10-7000` as three tokens, so keeping the hyphen here made the
      // phrase `"CODE-10-7000"` the one query the index could never answer.
      .split(/[^\p{L}\p{N}_]+/u)
      .map((token) => token.trim().replace(/"/g, ''))
      .filter((token) => token.length > 0)
      .slice(0, 12);
  }

  private fallbackRawTextSearch(
    query: string,
    options: {
      projectId?: string;
      workspaceId?: string;
      threadId?: string;
      sessionId?: string;
      localDate?: string;
      startTime?: number;
      endTime?: number;
      orderBy?: RawEventOrder;
    },
    limit: number,
  ): MemoryEvent[] {
    if (this.encryptionProvider) return [];
    const tokens = this.rawTextSearchTokens(query);
    if (tokens.length === 0) return [];

    const likeConditions = tokens.map(() => `LOWER(memory_events_fts.text) LIKE ? ESCAPE '\\'`);
    const likeParams: Array<string | number> = tokens.map((token) => `%${escapeSqlLike(token)}%`);
    const scope = this.rawEventScopeConditions(options);
    const score = likeConditions
      .map((condition) => `CASE WHEN ${condition} THEN 1 ELSE 0 END`)
      .join(' + ');
    const order = options.orderBy === 'relevance' ? 'DESC' : 'ASC';

    const rows = this.db.prepare(`
      SELECT ${MEMORY_EVENT_COLUMNS.split(',').map((column) => `e.${column.trim()}`).join(', ')},
             (${score}) AS matched
      FROM memory_events_fts
      JOIN memory_events e ON e.event_id = memory_events_fts.event_id
      WHERE (${likeConditions.join(' OR ')})${scope.sql}
      ORDER BY matched DESC, COALESCE(e.global_seq, 0) ${order}, e.event_id ${order}
      LIMIT ?
    `).all(...likeParams, ...likeParams, ...scope.params, limit) as any[];
    return rows.map((row) => this.mapRow(row));
  }

  private cjkPostingRows(
    tokens: readonly string[],
    options: {
      projectId?: string;
      workspaceId?: string;
      threadId?: string;
      sessionId?: string;
      localDate?: string;
      startTime?: number;
      endTime?: number;
      orderBy?: RawEventOrder;
    },
    limit: number,
  ): any[] | null {
    if (tokens.length === 0) return null;
    const cjk = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}$/u;
    if (!tokens.every((token) => cjk.test(token)) || !this.cjkIndexComplete()) return null;
    const scope = this.rawEventScopeConditions(options);
    const cap = Math.max(limit * 8, 64);
    const statement = this.db.query(`
      SELECT t.event_id AS event_id, t.global_seq AS global_seq
      FROM memory_event_cjk_terms t
      JOIN memory_events e ON e.event_id = t.event_id
      WHERE t.term = ?${scope.sql}
      LIMIT ?
    `);
    const candidates = new Map<string, { eventId: string; globalSeq: number; matched: number }>();
    for (const token of new Set(tokens)) {
      for (const row of statement.all(token, ...scope.params, cap) as Array<{ event_id: string; global_seq: number | null }>) {
        const existing = candidates.get(row.event_id);
        if (existing) existing.matched += 1;
        else candidates.set(row.event_id, { eventId: row.event_id, globalSeq: row.global_seq ?? 0, matched: 1 });
      }
    }
    const relevance = options.orderBy === 'relevance';
    const ordered = [...candidates.values()]
      .sort((left, right) =>
        right.matched - left.matched
        || (relevance ? right.globalSeq - left.globalSeq : left.globalSeq - right.globalSeq)
        || (relevance ? right.eventId.localeCompare(left.eventId) : left.eventId.localeCompare(right.eventId)))
      .slice(0, limit);
    if (ordered.length === 0) return [];
    const columns = MEMORY_EVENT_COLUMNS.split(',').map((column) => `e.${column.trim()}`).join(', ');
    const rows = this.db.query(`SELECT ${columns} FROM memory_events e WHERE e.event_id IN (${ordered.map(() => '?').join(',')})`)
      .all(...ordered.map((candidate) => candidate.eventId)) as any[];
    const byId = new Map(rows.map((row) => [row.event_id, row]));
    return ordered.map((candidate) => byId.get(candidate.eventId)).filter((row): row is any => Boolean(row));
  }

  private cjkPostingSearch(
    query: string,
    options: {
      projectId?: string;
      workspaceId?: string;
      threadId?: string;
      sessionId?: string;
      localDate?: string;
      startTime?: number;
      endTime?: number;
      orderBy?: RawEventOrder;
    },
    limit: number,
  ): any[] | null {
    if (this.encryptionProvider) return null;
    return this.cjkPostingRows(this.rawTextSearchTokens(query), options, limit);
  }

  private rawTextSearchTokens(query: string): string[] {
    const tokens: string[] = [];
    for (const part of query.split(/[^\p{L}\p{N}_-]+/u)) {
      const token = part.trim().toLowerCase();
      if (token.length === 0) continue;
      if (QUERY_STOP_WORDS.has(token)) continue;
      if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(token)) {
        if (token.length <= 2) {
          tokens.push(token);
          continue;
        }
        for (let i = 0; i + 2 <= token.length; i += 1) {
          const bigram = token.slice(i, i + 2);
          if (!QUERY_STOP_WORDS.has(bigram)) tokens.push(bigram);
        }
        continue;
      }
      tokens.push(token);
    }
    return [...new Set(tokens)].slice(0, 48);
  }

  /**
   * The events a one-time back-scan looks at (#142): id, role and text, nothing else.
   *
   * Narrow on purpose. A repair walks the whole ledger, and handing it the ordinary query surface would invite it to
   * grow into a second reader with its own ideas about scope.
   */
  listEventsForSecretBackScan(): Array<{ eventId: string; role: string; text: string }> {
    const rows = this.db.prepare('SELECT event_id, role, payload_json FROM memory_events').all() as Array<{ event_id: string; role: string | null; payload_json: string }>;
    return rows.map((row) => {
      const payload = JSON.parse(this.decodePayload(row.payload_json)) as { text?: unknown; content?: unknown };
      const text = typeof payload.text === 'string' ? payload.text : (typeof payload.content === 'string' ? payload.content : '');
      return { eventId: row.event_id, role: row.role ?? '', text };
    });
  }

  /**
   * Stamp the write-path secret mark onto an existing event (#142), leaving its text untouched.
   *
   * The mark has to be byte-for-byte the shape `recordRawEvent` writes, because the reader that withholds the event
   * reads exactly those fields. Idempotent: an event already carrying the key is left alone and reports false.
   * `payload_hash` is recomputed because it tracks the payload; `content_hash` is deliberately left alone — it
   * describes the text, the text is not changing, and rewriting it would change the record's content identity.
   */
  addSecretFindings(eventId: string, key: 'secretFindings' | 'secretFindingsAssistant', findings: { total: number; byKind: Record<string, number> }): boolean {
    const row = this.db.prepare('SELECT payload_json FROM memory_events WHERE event_id=?').get(eventId) as { payload_json: string } | undefined;
    if (!row) return false;
    const payload = JSON.parse(this.decodePayload(row.payload_json)) as Record<string, unknown>;
    const metadata = (payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}) as Record<string, unknown>;
    const existing = metadata[key] as { total?: number } | undefined;
    if (existing && Number(existing.total ?? 0) > 0) return false;
    payload.metadata = { ...metadata, [key]: { total: findings.total, byKind: findings.byKind } };
    const payloadJson = JSON.stringify(payload);
    this.db.prepare('UPDATE memory_events SET payload_json=?, payload_hash=? WHERE event_id=?')
      .run(this.encodePayload(payloadJson), createHash('sha256').update(payloadJson).digest('hex'), eventId);
    return true;
  }

  markToolObservationPromoted(eventId: string): boolean {
    const row = this.db.prepare('SELECT payload_json FROM memory_events WHERE event_id=?').get(eventId) as { payload_json: string } | undefined;
    if (!row) return false;
    const payload = JSON.parse(this.decodePayload(row.payload_json)) as Record<string, unknown>;
    const metadata = (payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}) as Record<string, unknown>;
    if (metadata.toolObservationPromoted === true) return false;
    payload.metadata = { ...metadata, toolObservationPromoted: true };
    const payloadJson = JSON.stringify(payload);
    this.db.prepare('UPDATE memory_events SET payload_json=?, payload_hash=? WHERE event_id=?')
      .run(this.encodePayload(payloadJson), createHash('sha256').update(payloadJson).digest('hex'), eventId);
    return true;
  }

  /**
   * Correct the life-sensitivity mark on one event (#164), or clear the correction with `null`.
   *
   * The correction is stored beside the write-time findings rather than rewriting them, so clearing
   * it restores the original judgement. A `daily` correction is an explicit "not sensitive" and wins
   * over the findings; recall and surfacing read the event every time and hold no cache.
   */
  correctLifeSensitivity(eventId: string, tier: LifeSensitivityTier | null): boolean {
    const row = this.db.prepare('SELECT payload_json FROM memory_events WHERE event_id=?').get(eventId) as { payload_json: string } | undefined;
    if (!row) return false;
    const payload = JSON.parse(this.decodePayload(row.payload_json)) as Record<string, unknown>;
    const metadata = (payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}) as Record<string, unknown>;
    if (tier === null) delete metadata.lifeSensitivityCorrection;
    else metadata.lifeSensitivityCorrection = { tier, correctedAt: Date.now() };
    payload.metadata = metadata;
    const payloadJson = JSON.stringify(payload);
    this.db.prepare('UPDATE memory_events SET payload_json=?, payload_hash=? WHERE event_id=?')
      .run(this.encodePayload(payloadJson), createHash('sha256').update(payloadJson).digest('hex'), eventId);
    return true;
  }

  private encodePayload(payloadJson: string): string {
    return this.encryptionProvider?.encrypt(payloadJson) ?? payloadJson;
  }

  private decodePayload(payloadJson: string): string {
    return this.encryptionProvider?.decrypt(payloadJson) ?? payloadJson;
  }
}

function qualifiedMemoryEventColumns(alias: string): string {
  return MEMORY_EVENT_COLUMNS.split(',').map((column) => `${alias}.${column.trim()}`).join(', ');
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Words that ask rather than say.
 *
 * A question and the statement answering it share the words that carry meaning
 * and nothing else. Left in, "the" and "is" match almost every event, and a
 * loose search returns the whole ledger ranked by how often it says "the".
 * Dropped, the question matches on the words that distinguish it.
 */
const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me',
  'my', 'of', 'on', 'or', 'our', 'should', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', 'your',
  '吗', '呢', '吧', '啊', '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和',
  '就', '都', '也', '还', '有', '这', '那', '什么', '怎么', '哪', '哪个', '多少', '为什么',
]);

function sequenceKey(kind: string, projectId: string, id: string): string {
  return `${kind}:${createHash('sha256').update(`${projectId}\0${id}`).digest('hex')}`;
}

function legacyLocalDateSource(payloadJson: string): MemoryEvent['localDateSource'] {
  try {
    const payload = JSON.parse(payloadJson) as { metadata?: Record<string, unknown> };
    if (payload.metadata?.localDateSource === 'event_store_utc_default') return 'generated_utc';
    if (payload.metadata?.localDateSource === 'explicit') return 'explicit';
  } catch {
    return 'legacy_unknown';
  }
  return 'legacy_unknown';
}

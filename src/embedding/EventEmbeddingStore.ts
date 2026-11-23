import type Database from 'bun:sqlite';

export interface EventEmbeddingHit {
  eventId: string;
  score: number;
}

interface CachedVector {
  vector: Float32Array;
  occurredAt: number;
  seq: number;
}

interface EmbeddingCache {
  dimensions: number;
  maxSeq: number;
  vectors: Map<string, CachedVector>;
}

export class EventEmbeddingStore {
  private readonly caches = new Map<string, EmbeddingCache>();

  constructor(private readonly db: Database, private readonly minSimilarity = 0.5) {}

  upsert(eventId: string, modelId: string, vector: Float32Array, projectId: string | undefined): void {
    if (vector.length === 0) return;
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_event_embeddings(event_id,model_id,dimensions,vector_blob,project_id,updated_at)
      VALUES(?,?,?,?,?,?)
    `).run(eventId, modelId, vector.length, blob, projectId ?? '', Date.now());
    const keys = [this.cacheKey(projectId, modelId), this.cacheKey(undefined, modelId)]
      .filter((key) => this.caches.get(key)?.dimensions === vector.length);
    if (keys.length === 0) return;
    const event = this.db.prepare(`
      SELECT COALESCE(global_seq, 0) AS seq, occurred_at AS occurredAt
      FROM memory_events
      WHERE event_id = ?
    `).get(eventId) as { seq: number; occurredAt: number } | null;
    if (!event) return;
    for (const key of keys) {
      const cache = this.caches.get(key)!;
      cache.vectors.set(eventId, { vector: new Float32Array(vector), occurredAt: event.occurredAt, seq: event.seq });
      cache.maxSeq = Math.max(cache.maxSeq, event.seq);
    }
  }

  findNearest(
    vector: Float32Array,
    projectId: string | undefined,
    limit: number,
    modelId: string,
  ): EventEmbeddingHit[] {
    if (vector.length === 0) return [];
    const cache = this.loadCache(projectId, modelId, vector.length);
    return [...cache.vectors.entries()]
      .map(([eventId, entry]) => ({ eventId, score: cosine(vector, entry.vector) }))
      .filter((hit) => hit.score >= this.minSimilarity)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, limit));
  }

  private cacheKey(projectId: string | undefined, modelId: string): string {
    return `${projectId ?? ''}\u0000${modelId}`;
  }

  private loadCache(projectId: string | undefined, modelId: string, dimensions: number): EmbeddingCache {
    const key = this.cacheKey(projectId, modelId);
    const cached = this.caches.get(key);
    const cache = cached?.dimensions === dimensions
      ? cached
      : { dimensions, maxSeq: -1, vectors: new Map<string, CachedVector>() };
    const rows = this.db.prepare(`
      SELECT emb.event_id AS eventId, emb.vector_blob AS vectorBlob,
             COALESCE(e.global_seq, 0) AS seq, e.occurred_at AS occurredAt
      FROM memory_event_embeddings emb
      JOIN memory_events e ON e.event_id = emb.event_id
      WHERE emb.model_id=? AND emb.dimensions=? AND (? IS NULL OR COALESCE(emb.project_id,'')=?)
        AND COALESCE(e.global_seq, 0) > ?
    `).all(modelId, dimensions, projectId ?? null, projectId ?? '', cache.maxSeq) as Array<{
      eventId: string;
      vectorBlob: Uint8Array;
      seq: number;
      occurredAt: number;
    }>;
    for (const row of rows) {
      cache.vectors.set(row.eventId, {
        vector: new Float32Array(row.vectorBlob.buffer, row.vectorBlob.byteOffset, row.vectorBlob.byteLength / 4),
        occurredAt: row.occurredAt,
        seq: row.seq,
      });
      cache.maxSeq = Math.max(cache.maxSeq, row.seq);
    }
    if (cache !== cached) this.caches.set(key, cache);
    return cache;
  }

  getProgress(projectId?: string): { total: number; completed: number; failed: number } {
    const count = (sql: string, param?: string): number => Number(
      (this.db.prepare(sql).get(...(param === undefined ? [] : [param])) as { count?: number } | null)?.count ?? 0,
    );
    const total = projectId === undefined
      ? count(`SELECT COUNT(*) AS count FROM memory_events WHERE event_type='RAW_EVENT_RECORDED'`)
      : count(`SELECT COUNT(*) AS count FROM memory_events WHERE event_type='RAW_EVENT_RECORDED' AND COALESCE(project_id,'')=?`, projectId);
    const completed = projectId === undefined
      ? count(`SELECT COUNT(*) AS count FROM memory_event_embeddings`)
      : count(`SELECT COUNT(*) AS count FROM memory_event_embeddings WHERE COALESCE(project_id,'')=?`, projectId);
    return { total, completed, failed: 0 };
  }

  hasStaleVectors(modelId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM memory_event_embeddings WHERE model_id<>? LIMIT 1`).get(modelId));
  }
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

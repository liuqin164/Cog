import type Database from 'bun:sqlite';

export interface EventEmbeddingHit {
  eventId: string;
  score: number;
}

export class EventEmbeddingStore {
  constructor(private readonly db: Database) {}

  upsert(eventId: string, modelId: string, vector: Float32Array, projectId: string | undefined): void {
    if (vector.length === 0) return;
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_event_embeddings(event_id,model_id,dimensions,vector_blob,project_id,updated_at)
      VALUES(?,?,?,?,?,?)
    `).run(eventId, modelId, vector.length, blob, projectId ?? '', Date.now());
  }

  findNearest(
    vector: Float32Array,
    projectId: string | undefined,
    limit: number,
    modelId: string,
  ): EventEmbeddingHit[] {
    if (vector.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT event_id, vector_blob FROM memory_event_embeddings
      WHERE model_id=? AND dimensions=? AND COALESCE(project_id,'')=?
    `).all(modelId, vector.length, projectId ?? '') as Array<{ event_id: string; vector_blob: Uint8Array }>;
    return rows
      .map((row) => ({
        eventId: row.event_id,
        score: cosine(vector, new Float32Array(
          row.vector_blob.buffer,
          row.vector_blob.byteOffset,
          row.vector_blob.byteLength / 4,
        )),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, limit));
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

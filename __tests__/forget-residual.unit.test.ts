import { expect, test } from 'bun:test';
import type Database from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { TraceStore } from '../src/observability/TraceStore.js';
import { makeTempDir } from './helpers/tmp.js';

test('deleteRange leaves the window text in no table, including FTS shadows', () => {
  const dir = makeTempDir('forget-residual-');
  const projectId = 'forget-residual';
  const secret = 'BANK_TAIL_7731_RESIDUAL_TOKEN';
  const base = Date.now() - 60_000;
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    for (let index = 0; index < 600; index += 1) {
      kernel.recordRawEvent({
        projectId,
        threadId: 'residual-thread',
        role: 'user',
        content: `filler turn ${index} ${'x'.repeat(40)}`,
        occurredAt: base - 86_400_000 + index,
      });
    }
    const event = kernel.recordRawEvent({
      projectId,
      threadId: 'residual-thread',
      role: 'user',
      content: `我的银行卡尾号是 ${secret}`,
      occurredAt: base + 1_000,
    });
    kernel.compileMemory({ projectId, content: secret, createdAt: base + 1_000 }, event.eventId);

    db.exec(`
      CREATE TABLE project_branches (branch_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_key TEXT NOT NULL, branch_kind TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE topology_membership (neuron_id TEXT NOT NULL, project_id TEXT, dimension_type TEXT NOT NULL, dimension_key TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE cognitive_nodes (node_id TEXT PRIMARY KEY, node_type TEXT NOT NULL, node_key TEXT NOT NULL, title TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', source_neuron_id TEXT, metadata_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    db.prepare(`INSERT INTO project_branches VALUES ('branch-1', ?, 'k', 'conversation', ?, ?, ?)`).run(projectId, secret, base, base);
    db.prepare(`INSERT INTO topology_membership VALUES (?, ?, 'topic', 'k', ?, ?)`).run(event.eventId, projectId, secret, base);
    db.prepare(`INSERT INTO cognitive_nodes VALUES ('node-1', 'topic', 'k', ?, ?, ?, NULL, ?, ?)`).run(secret, projectId, event.eventId, base, base);
    const traces = new TraceStore(db);
    traces.initSchema();
    traces.append({
      id: 'trace-1',
      timestamp: base + 2_000,
      projectId,
      eventType: 'recall.result',
      payload: { query: secret, selectedIds: [event.eventId] },
    });

    const before = countRows(db);
    const result = kernel.sovereignty.deleteRange({ projectId, start: base, end: base + 60_000 });
    expect(result.deleted.projectBranches).toBe(before.project_branches);
    expect(result.deleted.topologyMembership).toBe(before.topology_membership);
    expect(result.deleted.interactionUnits).toBe(before.interaction_units);
    expect(result.deleted.cognitiveNodes).toBe(before.cognitive_nodes);
    expect(result.deleted.traceEvents).toBe(before.trace_events);
    expect(before.interaction_units).toBeGreaterThan(0);
    expect(before.trace_events).toBe(1);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='memory_events_fts_data'`).get()).toBeTruthy();

    expect(rowsHolding(db, secret)).toEqual([]);
  } finally {
    kernel.close();
  }
}, 20_000);

test('#374 deleteRange rewrites FTS5 segments at real scale so CJK dead bytes do not survive', () => {
  const dir = makeTempDir('forget-fts-segments-');
  const dbPath = join(dir, 'memory.sqlite');
  const projectId = 'forget-fts-segments';
  const secret = '北海道';
  const marker = 'FTS_SEGMENT_374_MARKER';
  const base = Date.UTC(2026, 0, 11);
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    for (let index = 0; index < 2000; index += 1) {
      kernel.recordRawEvent({
        projectId,
        threadId: 'fts-thread',
        role: 'user',
        content: `filler ${index} ${'あ'.repeat(10)}`,
        occurredAt: base + index,
      });
    }
    kernel.recordRawEvent({
      projectId,
      threadId: 'fts-thread',
      role: 'user',
      content: `私の好きな街は${secret}です ${marker}`,
      occurredAt: base + 100_000,
    });
    const match = db.prepare(`SELECT COUNT(*) AS c FROM memory_events_fts WHERE memory_events_fts MATCH ?`);
    expect(match.get(marker)).toEqual({ c: 1 });
    expect(rowsHolding(db, secret).length).toBeGreaterThan(0);

    kernel.sovereignty.deleteRange({ projectId, start: base + 100_000, end: base + 100_001 });

    expect(match.get(marker)).toEqual({ c: 0 });
    expect(rowsHolding(db, secret)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM memory_events_fts`).get()).toEqual({ c: 2000 });
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret)), file).toBe(false);
    }
  } finally {
    kernel.close();
  }
}, 60_000);

function countRows(db: Database): Record<string, number> {
  const tables = ['project_branches', 'topology_membership', 'interaction_units', 'cognitive_nodes', 'trace_events'];
  return Object.fromEntries(tables.map((table) => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
    return [table, Number(row.c)];
  }));
}

function rowsHolding(db: Database, needle: string): string[] {
  const hits: string[] = [];
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    for (const column of columns) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE instr(CAST("${column.name}" AS TEXT), ?) > 0`).get(needle) as { c: number };
      if (Number(row.c) > 0) hits.push(`${name}.${column.name}:${row.c}`);
    }
  }
  return hits;
}

import { expect, test } from 'bun:test';
import type Database from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

test('#373 deleteRange drops pending_bindings for removed interaction units and their bytes', () => {
  const dir = makeTempDir('forget-pending-');
  const dbPath = join(dir, 'memory.sqlite');
  const projectId = 'forget-pending';
  const secret = 'PENDING_BINDING_373_TOKEN';
  const base = Date.UTC(2026, 0, 10);
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    const text = `你把 ${secret} 放在哪里了?`;
    const event = kernel.recordRawEvent({
      projectId,
      threadId: 'pending-thread',
      role: 'user',
      content: text,
      occurredAt: base + 1_000,
    });
    kernel.compileMemory({ projectId, content: text, createdAt: base + 1_000 }, event.eventId);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM pending_bindings`).get()).toEqual({ c: 1 });

    const result = kernel.sovereignty.deleteRange({ projectId, start: base, end: base + 86_400_000 });
    expect(result.deleted.pendingBindings).toBe(1);
    expect(rowsHolding(db, secret)).toEqual([]);

    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret)), file).toBe(false);
    }
  } finally {
    kernel.close();
  }
});

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

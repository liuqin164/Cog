import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { checkpointTruncate } from '../src/sovereignty/MemorySovereigntyService.js';
import { makeTempDir } from './helpers/tmp.js';

const DAY = 24 * 60 * 60 * 1000;

test('#423 all snapshot stores are scanned, counted by kind, and erased', () => {
  const dir = makeTempDir('forget-artifacts-');
  const dbPath = join(dir, 'memory.sqlite');
  const snapshotsDir = join(dir, 'snapshots');
  const exportsDir = join(dir, 'exports');
  mkdirSync(snapshotsDir, { recursive: true });
  mkdirSync(exportsDir, { recursive: true });
  const projectId = 'artifact-window';
  const base = Date.now() - 60_000;
  const kernel = createMemoryKernel({ dbPath, snapshotsDir, exportsDir, projectTimeZone: 'UTC' });
  try {
    kernel.recordRawEvent({
      projectId,
      threadId: 'artifact-thread',
      role: 'user',
      content: 'whole copy artifact token',
      occurredAt: base,
    });
    const recent = base + 1;
    for (const file of ['brain-1.snap', 'archive-1.snap', 'pre-upgrade-4.0-1.snap', 'memory-1.snap', 'failed-1.snap', '.archive-2.snap', '.bundle-2.snap', '.snapshot-1.db']) {
      const path = join(snapshotsDir, file);
      writeFileSync(path, 'copy');
      utimesSync(path, recent / 1000, recent / 1000);
    }
    writeFileSync(join(snapshotsDir, 'brain-1.json'), JSON.stringify({ createdAt: new Date(recent).toISOString() }));
    const oldPath = join(snapshotsDir, 'brain-old.snap');
    writeFileSync(oldPath, 'old copy');
    const old = base - 10 * DAY;
    utimesSync(oldPath, old / 1000, old / 1000);
    writeFileSync(join(exportsDir, 'memory-before.md'), 'export');

    const result = kernel.sovereignty.deleteRange({ projectId, start: base - 1, end: base + 1 });
    expect(result.artifacts.snapshotsRemoved).toBe(6);
    expect(result.artifacts.archivesRemoved).toBe(2);
    expect(result.artifacts.upgradesRemoved).toBe(1);
    expect(result.artifacts.failedCopiesRemoved).toBe(1);
    expect(result.artifacts.databasesRemoved).toBe(1);
    expect(result.artifacts.exportsRemoved).toBe(1);
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(join(snapshotsDir, 'pre-upgrade-4.0-1.snap'))).toBe(false);
    expect(existsSync(join(snapshotsDir, '.snapshot-1.db'))).toBe(false);
    const audit = kernel.getGovernanceAudit(projectId).find((entry) => entry.auditId === result.auditId)!;
    expect((audit.details as { artifacts: { upgradesRemoved: number } }).artifacts.upgradesRemoved).toBe(1);
  } finally {
    kernel.close();
  }
});

test('#423 a failure after the main commit leaves a marker, and the next call finishes the erase', () => {
  const dir = makeTempDir('forget-recovery-');
  const dbPath = join(dir, 'memory.sqlite');
  const snapshotsDir = join(dir, 'snapshots');
  mkdirSync(snapshotsDir, { recursive: true });
  const projectId = 'recovery-window';
  const base = Date.now() - 60_000;
  const kernel = createMemoryKernel({ dbPath, snapshotsDir, projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    kernel.recordRawEvent({
      projectId,
      threadId: 'recovery-thread',
      role: 'user',
      content: 'recovery token',
      occurredAt: base,
    });
    const blocker = join(snapshotsDir, 'pre-upgrade-9.snap');
    mkdirSync(blocker);
    utimesSync(blocker, (base + 1) / 1000, (base + 1) / 1000);

    expect(() => kernel.sovereignty.deleteRange({ projectId, start: base - 1, end: base + 1 })).toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM memory_events WHERE COALESCE(project_id,'')=?`).get(projectId)).toEqual({ c: 0 });
    expect(db.prepare(`SELECT value FROM _meta WHERE key=?`).get(`sovereignty.pending_erase:${projectId}`)).toBeTruthy();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM governance_audit_log WHERE action='delete_range'`).get()).toEqual({ c: 0 });

    rmSync(blocker, { recursive: true, force: true });
    const late = join(snapshotsDir, 'pre-upgrade-10.snap');
    writeFileSync(late, 'late copy');
    utimesSync(late, (base + 2) / 1000, (base + 2) / 1000);

    const recovered = kernel.sovereignty.deleteRange({ projectId, start: base + DAY, end: base + DAY + 1 });
    expect(recovered.recovered?.artifacts.upgradesRemoved).toBe(1);
    expect(recovered.artifacts.upgradesRemoved).toBe(0);
    expect(recovered.deleted.events).toBe(0);
    expect(recovered.recovered?.auditId).not.toBe(recovered.auditId);
    expect(existsSync(late)).toBe(false);
    expect(db.prepare(`SELECT value FROM _meta WHERE key=?`).get(`sovereignty.pending_erase:${projectId}`)).toBeNull();
    const auditIds = (db.prepare(`SELECT audit_id FROM governance_audit_log WHERE action='delete_range' AND project_id=?`)
      .all(`sha256:${createHash('sha256').update(projectId).digest('hex')}`) as Array<{ audit_id: string }>)
      .map((row) => row.audit_id);
    expect(auditIds).toContain(recovered.auditId);
    expect(auditIds).toContain(recovered.recovered!.auditId);
    const noop = db.prepare(`SELECT details_json FROM governance_audit_log WHERE audit_id=?`).get(recovered.auditId) as { details_json: string };
    expect((JSON.parse(noop.details_json) as { counts: { events: number } }).counts.events).toBe(0);
  } finally {
    kernel.close();
  }
});

test('#423 wal_checkpoint(TRUNCATE) reads its result instead of assuming it ran', () => {
  const dir = makeTempDir('forget-checkpoint-');
  const dbPath = join(dir, 'memory.sqlite');
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  const reader = new Database(dbPath);
  try {
    kernel.recordRawEvent({ projectId: 'checkpoint', threadId: 't', role: 'user', content: 'wal token' });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM memory_events').get();
    expect(checkpointTruncate(kernel.factStore.getDatabase())).toBe(false);
    reader.exec('COMMIT');
    expect(checkpointTruncate(kernel.factStore.getDatabase())).toBe(true);
  } finally {
    reader.close();
    kernel.close();
  }
});

function ftsDataContains(db: Database, needle: string): boolean {
  const rows = db.prepare(`SELECT block FROM memory_atlas_fts_data`).all() as Array<{ block: Uint8Array }>;
  return rows.some((row) => Buffer.from(row.block).includes(Buffer.from(needle)));
}

test('#502 Atlas rebuild and GC run before optimize/VACUUM, leaving no FTS segment bytes', () => {
  const dir = makeTempDir('forget-fts-order-');
  const dbPath = join(dir, 'memory.sqlite');
  const projectId = 'fts-erase-order';
  const base = Date.now() - 60_000;
  const marker = 'zzuniqueterm9f3c7';
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  try {
    const event = kernel.recordRawEvent({
      projectId,
      threadId: 'fts-thread',
      role: 'user',
      content: `${marker} hello world`,
      occurredAt: base,
    });
    const db = kernel.factStore.getDatabase();
    db.prepare(`INSERT INTO memory_atlas_documents (
      node_id, project_id, node_type, source_id, label, summary, confidence,
      support_count, status, occurred_at, evidence_event_ids_json, metadata_json, updated_at
    ) VALUES (?, ?, 'raw_event', ?, ?, ?, 1, 0, 'active', ?, '[]', '{}', ?)`)
      .run(`raw_event:${event.eventId}`, projectId, event.eventId, marker, `${marker} summary`, base, base);
    kernel.memoryAtlasStore.refreshFtsProject(projectId);
    expect(ftsDataContains(db, marker)).toBe(true);

    const service = kernel.sovereignty as unknown as {
      ports: { profile: { compile(input: unknown): unknown }; procedures: { compile(input: unknown): unknown }; commitments: { compile(input: unknown): unknown }; intentions: { compile(input: unknown): unknown }; rebuildAtlas?: (scope: string) => unknown };
      eraseFreedPages(): boolean;
    };
    const order: string[] = [];
    for (const key of ['profile', 'procedures', 'commitments', 'intentions'] as const) {
      const compile = service.ports[key].compile.bind(service.ports[key]);
      service.ports[key].compile = (input) => {
        order.push(key);
        return compile(input);
      };
    }
    const rebuildAtlas = service.ports.rebuildAtlas!.bind(service.ports);
    service.ports.rebuildAtlas = (scope) => {
      order.push('atlas');
      return rebuildAtlas(scope);
    };
    const eraseFreedPages = service.eraseFreedPages.bind(service);
    service.eraseFreedPages = () => {
      order.push('erase');
      return eraseFreedPages();
    };

    kernel.sovereignty.deleteRange({ projectId, start: base - 1, end: base + 1 });

    expect(order).toContain('atlas');
    expect(order[order.length - 1]).toBe('erase');
    expect(order.indexOf('erase')).toBeGreaterThan(order.indexOf('profile'));
    expect(order.indexOf('erase')).toBeGreaterThan(order.indexOf('procedures'));
    expect(order.indexOf('erase')).toBeGreaterThan(order.indexOf('commitments'));
    expect(order.indexOf('erase')).toBeGreaterThan(order.indexOf('intentions'));
    expect(order.indexOf('erase')).toBeGreaterThan(order.indexOf('atlas'));
    expect(ftsDataContains(db, marker)).toBe(false);
    expect(readFileSync(dbPath).includes(Buffer.from(marker))).toBe(false);
  } finally {
    kernel.close();
  }
});

test('#502 the pending marker survives an erase that did not settle, and clears after the retry', () => {
  const dir = makeTempDir('forget-fts-marker-');
  const dbPath = join(dir, 'memory.sqlite');
  const projectId = 'fts-erase-marker';
  const base = Date.now() - 60_000;
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    kernel.recordRawEvent({
      projectId,
      threadId: 'fts-marker-thread',
      role: 'user',
      content: 'fts marker retry token',
      occurredAt: base,
    });
    const service = kernel.sovereignty as unknown as { eraseFreedPages(): boolean };
    const eraseFreedPages = service.eraseFreedPages.bind(service);
    service.eraseFreedPages = () => false;

    const first = kernel.sovereignty.deleteRange({ projectId, start: base - 1, end: base + 1 });
    expect(first.artifacts.notCovered.length).toBeGreaterThan(0);
    const pending = db.prepare(`SELECT value FROM _meta WHERE key=?`).get(`sovereignty.pending_erase:${projectId}`) as { value: string } | null;
    expect(pending).toBeTruthy();
    expect(JSON.parse(pending!.value).walSettled).toBe(false);

    service.eraseFreedPages = eraseFreedPages;
    kernel.sovereignty.deleteRange({ projectId, start: base + DAY, end: base + DAY + 1 });
    expect(db.prepare(`SELECT value FROM _meta WHERE key=?`).get(`sovereignty.pending_erase:${projectId}`)).toBeNull();
  } finally {
    kernel.close();
  }
});


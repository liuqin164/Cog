import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    expect(recovered.artifacts.upgradesRemoved).toBe(1);
    expect(existsSync(late)).toBe(false);
    expect(db.prepare(`SELECT value FROM _meta WHERE key=?`).get(`sovereignty.pending_erase:${projectId}`)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM governance_audit_log WHERE action='delete_range' AND project_id=?`).get(`sha256:${createHash('sha256').update(projectId).digest('hex')}`)).toEqual({ c: 1 });
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


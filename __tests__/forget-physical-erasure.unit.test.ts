import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * #303: a range deletion is physical, not logical. The seeded text must be absent from the live
 * database file, its WAL, the nightly snapshots and the Markdown exports once deleteRange returns.
 */
test('deleteRange erases the window from the database bytes, snapshots and exports', async () => {
  const dir = makeTempDir('forget-physical-');
  const dbPath = join(dir, 'memory.sqlite');
  const snapshotsDir = join(dir, 'snapshots');
  const exportsDir = join(dir, 'exports');
  const secret = 'PHYSICAL_ERASURE_TOKEN_51d0a7e2';
  const projectId = 'erase-range';
  const base = Date.UTC(2026, 0, 10);
  const kernel = createMemoryKernel({ dbPath, snapshotsDir, exportsDir, projectTimeZone: 'UTC' });
  try {
    for (const offset of [1_000, 2_000, 3_000]) {
      kernel.recordRawEvent({
        projectId,
        threadId: 'erase-thread',
        role: 'user',
        content: `${secret} turn ${offset}`,
        occurredAt: base + offset,
      });
    }
    kernel.recordRawEvent({
      projectId,
      threadId: 'erase-thread',
      role: 'user',
      content: 'kept turn outside the window',
      occurredAt: base + 86_400_000 + 1_000,
    });
    // Both copies are made while the secret is still live, the way a nightly run and `/export` do.
    const snapshot = await kernel.backup.snapshot();
    expect(snapshot?.verification.ok).toBe(true);
    kernel.sovereignty.exportArchive({ projectId, outputPath: join(exportsDir, 'memory-before-forget.md') });
    expect(readFileSync(join(exportsDir, 'memory-before-forget.md'), 'utf8')).toContain(secret);

    const result = kernel.sovereignty.deleteRange({ projectId, start: base, end: base + 86_400_000 });
    expect(result.deleted.events).toBe(3);
    expect(result.artifacts.snapshotsRemoved).toBe(1);
    expect(result.artifacts.archivesRemoved).toBe(1);
    expect(result.artifacts.exportsRemoved).toBe(1);
    expect(result.artifacts.notCovered.length).toBeGreaterThan(0);
    expect(kernel.eventStore.queryEvents(1, 10, {
      projectId: [projectId],
      startTime: base + 86_400_000,
    }).total).toBeGreaterThanOrEqual(1);

    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      if (file === 'snapshots' || file === 'exports') continue;
      expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
    }
    for (const directory of [snapshotsDir, exportsDir]) {
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory)) {
        expect(readFileSync(join(directory, file)).includes(Buffer.from(secret))).toBe(false);
      }
    }
    expect(readdirSync(exportsDir)).toEqual([]);
    expect(readdirSync(snapshotsDir).filter((file) => /\.snap$/u.test(file))).toEqual([]);
  } finally {
    kernel.close();
  }
});

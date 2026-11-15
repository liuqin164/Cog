/**
 * The nightly whole-brain snapshot (#196, F19).
 *
 * It reuses `SnapshotExporter` — the one `.snap` DB copy format — and writes a JSON manifest beside
 * it with the soul versions, the key configuration and the five counts. Every snapshot is verified
 * (checksum, opens, counts) and the newest `SNAPSHOT_RETENTION` are kept. The first verified
 * snapshot of an ISO week is also copied to a weekly archive, so a slow contamination that takes
 * more than seven nights to notice still leaves a clean point; the newest
 * `SNAPSHOT_WEEKLY_RETENTION` archives are kept. The contract is `docs/health-backup.md`.
 */
import { createHash } from 'node:crypto';
import Database from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { SnapshotExporter } from './SnapshotExporter.js';
import { readSnapshotFile } from './SnapshotImporter.js';
import {
  BRAIN_COUNT_FIELDS,
  SNAPSHOT_FORMAT,
  SNAPSHOT_MANIFEST_VERSION,
  SNAPSHOT_RETENTION,
  SNAPSHOT_WEEKLY_RETENTION,
  SNAPSHOT_VERIFICATION_CHECKS,
  readBrainCounts,
  readSoulVersions,
  type BrainConfig,
  type BrainManifest,
  type BrainVerification,
} from './BrainManifest.js';

export interface BrainBackupOptions {
  dbPath: string;
  /** Unset means "this kernel does not take nightly snapshots" (a bare test kernel). */
  snapshotsDir?: string;
  embeddingDimension: number;
  coreVersion: string;
  config: BrainConfig;
  now?: () => number;
}

export class BrainBackup {
  private readonly now: () => number;

  constructor(private readonly options: BrainBackupOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Write, verify and rotate one snapshot. `undefined` when no snapshots directory is configured. */
  async snapshot(): Promise<BrainManifest | undefined> {
    const dir = this.options.snapshotsDir;
    if (!dir || this.options.dbPath === ':memory:' || this.options.dbPath.startsWith('file:')) return undefined;
    mkdirSync(dir, { recursive: true });
    const createdAt = new Date(this.now()).toISOString();
    const stamp = createdAt.replace(/[:.]/g, '-');
    const snapshotFile = `brain-${stamp}.snap`;
    const manifestFile = `brain-${stamp}.json`;
    const snapshotPath = join(dir, snapshotFile);
    const manifestPath = join(dir, manifestFile);

    const meta = await new SnapshotExporter({
      embeddingDimension: this.options.embeddingDimension,
      coreVersion: this.options.coreVersion,
    }).export(this.options.dbPath, snapshotPath);
    const counts = this.readCounts();
    const manifest: BrainManifest = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_MANIFEST_VERSION,
      createdAt,
      coreVersion: this.options.coreVersion,
      snapshot: {
        file: snapshotFile,
        byteLength: meta.byteLength,
        checksum: meta.header.checksum,
      },
      counts,
      soulVersions: this.readSoulVersions(),
      config: this.options.config,
      verification: {
        ok: false,
        checkedAt: createdAt,
        checks: { checksum: false, opens: false, counts: false },
      },
    };
    manifest.verification = this.verifyFiles(snapshotPath, manifest, createdAt);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    // Only a snapshot that passed its own checks is a clean point worth archiving.
    if (manifest.verification.ok) this.archive(dir, snapshotPath, manifest, createdAt);
    this.recordLast(manifest, manifestFile);
    this.rotate(dir);
    return manifest;
  }

  /** The retained snapshots, newest first. */
  list(): BrainManifest[] {
    const dir = this.options.snapshotsDir;
    if (!dir || !existsSync(dir)) return [];
    const manifests: BrainManifest[] = [];
    for (const file of readdirSync(dir)) {
      if (!/^(?:brain|archive)-.*\.json$/u.test(file)) continue;
      try {
        manifests.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as BrainManifest);
      } catch {
        // A half-written manifest is not a snapshot; it is ignored by the list and left on disk for
        // the operator to see, not silently deleted.
      }
    }
    return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || right.snapshot.file.localeCompare(left.snapshot.file));
  }

  /** Re-verify one manifest's snapshot and return the manifest with the fresh result. */
  verify(manifestPath: string): BrainManifest {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrainManifest;
    const snapshotPath = join(dirname(manifestPath), manifest.snapshot.file);
    manifest.verification = this.verifyFiles(snapshotPath, manifest, new Date(this.now()).toISOString());
    return manifest;
  }

  private readCounts() {
    const db = new Database(this.options.dbPath, { readonly: true });
    try {
      return readBrainCounts(db);
    } finally {
      db.close();
    }
  }

  private readSoulVersions() {
    const db = new Database(this.options.dbPath, { readonly: true });
    try {
      return readSoulVersions(db);
    } finally {
      db.close();
    }
  }

  private verifyFiles(snapshotPath: string, manifest: BrainManifest, checkedAt: string): BrainVerification {
    const checks: BrainVerification['checks'] = { checksum: false, opens: false, counts: false };
    let detail: string | undefined;
    try {
      const { header, dbBytes } = readSnapshotFile(snapshotPath);
      checks.checksum = createHash('sha256').update(dbBytes).digest('hex') === header.checksum
        && header.checksum === manifest.snapshot.checksum;
      const probePath = join(dirname(snapshotPath), `.verify-${basename(snapshotPath)}.db`);
      try {
        writeFileSync(probePath, dbBytes);
        const probe = new Database(probePath, { readonly: true });
        try {
          probe.prepare('SELECT 1').get();
          checks.opens = true;
          const restored = readBrainCounts(probe);
          checks.counts = BRAIN_COUNT_FIELDS.every((field) => restored[field] === manifest.counts[field]);
        } finally {
          probe.close();
        }
      } finally {
        rmSync(probePath, { force: true });
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    return {
      ok: SNAPSHOT_VERIFICATION_CHECKS.every((check) => checks[check]),
      checkedAt,
      checks,
      ...(detail ? { detail } : {}),
    };
  }

  private recordLast(manifest: BrainManifest, manifestFile: string): void {
    try {
      const db = new Database(this.options.dbPath);
      try {
        db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)').run(
          'brain_snapshot_last',
          JSON.stringify({
            file: manifestFile,
            createdAt: manifest.createdAt,
            ok: manifest.verification.ok,
            checks: manifest.verification.checks,
            checkedAt: manifest.verification.checkedAt,
          }),
        );
      } finally {
        db.close();
      }
    } catch {
      // A read-only database cannot record the mark; the manifest on disk is still the record.
    }
  }

  private rotate(dir: string): void {
    const snapshots = readdirSync(dir)
      .filter((file) => /^brain-.*\.snap$/u.test(file))
      .sort()
      .reverse();
    for (const old of snapshots.slice(SNAPSHOT_RETENTION)) {
      rmSync(join(dir, old), { force: true });
      rmSync(join(dir, old.replace(/\.snap$/u, '.json')), { force: true });
    }
  }

  /** Copy the week's first verified snapshot, then keep only the newest weekly archives. */
  private archive(dir: string, snapshotPath: string, manifest: BrainManifest, createdAt: string): void {
    const week = isoWeekKey(createdAt);
    const archiveFile = `archive-${week}.snap`;
    const manifestFile = `archive-${week}.json`;
    const archivePath = join(dir, archiveFile);
    if (existsSync(archivePath) && existsSync(join(dir, manifestFile))) return;
    copyFileSync(snapshotPath, archivePath);
    const archiveManifest: BrainManifest = {
      ...manifest,
      snapshot: { ...manifest.snapshot, file: archiveFile },
      verification: {
        ok: false,
        checkedAt: createdAt,
        checks: { checksum: false, opens: false, counts: false },
      },
    };
    archiveManifest.verification = this.verifyFiles(archivePath, archiveManifest, createdAt);
    writeFileSync(join(dir, manifestFile), JSON.stringify(archiveManifest, null, 2), 'utf8');
    this.rotateWeekly(dir);
  }

  private rotateWeekly(dir: string): void {
    const archives = readdirSync(dir)
      .filter((file) => /^archive-.*\.snap$/u.test(file))
      .sort()
      .reverse();
    for (const old of archives.slice(SNAPSHOT_WEEKLY_RETENTION)) {
      rmSync(join(dir, old), { force: true });
      rmSync(join(dir, old.replace(/\.snap$/u, '.json')), { force: true });
    }
  }
}

/** ISO-8601 week key, e.g. `2026-W01`. Weeks start on Monday; the year is the week's own. */
function isoWeekKey(iso: string): string {
  const date = new Date(iso);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

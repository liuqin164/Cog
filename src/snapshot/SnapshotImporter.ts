import { createHash } from 'node:crypto';
import Database from 'bun:sqlite';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { SnapshotHeader } from './SnapshotHeader.js';
import { ChecksumError, DimensionMismatchError, SnapshotTargetExistsError, SnapshotVersionError } from './errors.js';

export interface ImportOptions {
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface ImportResult {
  header: SnapshotHeader;
  targetPath: string;
  skipped: boolean;
}

export interface SnapshotImporterOptions {
  expectedEmbeddingDimension: number;
}

/**
 * Read the framing without importing. The nightly snapshot's verification opens the embedded
 * database, and the bundle writer reuses the bytes; both need the same parse the importer uses.
 */
export function readSnapshotFile(snapshotPath: string): { header: SnapshotHeader; dbBytes: Buffer } {
  const bytes = readFileSync(snapshotPath);
  if (bytes.byteLength < 5) throw new SnapshotVersionError('truncated');
  const headerLength = bytes.readUInt32LE(0);
  const headerStart = 4;
  const headerEnd = headerStart + headerLength;
  const header = JSON.parse(bytes.subarray(headerStart, headerEnd).toString('utf8')) as SnapshotHeader;
  return { header, dbBytes: bytes.subarray(headerEnd) };
}

export class SnapshotImporter {
  constructor(private readonly options: SnapshotImporterOptions) {}

  async import(snapshotPath: string, targetDbPath: string, opts: ImportOptions = {}): Promise<ImportResult> {
    const { header, dbBytes } = this.readSnapshot(snapshotPath);
    if (header.version !== 1) throw new SnapshotVersionError(header.version);
    if (header.embeddingDimension !== this.options.expectedEmbeddingDimension) {
      throw new DimensionMismatchError(this.options.expectedEmbeddingDimension, header.embeddingDimension);
    }
    const checksum = createHash('sha256').update(dbBytes).digest('hex');
    if (checksum !== header.checksum) throw new ChecksumError();

    if (opts.dryRun) {
      return { header, targetPath: targetDbPath, skipped: true };
    }
    if (existsSync(targetDbPath) && opts.overwrite !== true) {
      throw new SnapshotTargetExistsError(targetDbPath);
    }
    mkdirSync(dirname(targetDbPath), { recursive: true });
    const stagedPath = join(dirname(targetDbPath), `.restore-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      writeFileSync(stagedPath, dbBytes);
      const fd = openSync(stagedPath, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const db = new Database(stagedPath, { readonly: true });
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM memory_events WHERE event_type = 'RAW_EVENT_RECORDED'`).get() as { c?: number } | undefined;
        const count = Number(row?.c ?? 0);
        if (count !== header.neuronCount) {
          throw new Error(`staged database holds ${count} neurons, the snapshot header says ${header.neuronCount}`);
        }
      } finally {
        db.close();
      }
      renameSync(stagedPath, targetDbPath);
      for (const suffix of ['-wal', '-shm']) rmSync(`${targetDbPath}${suffix}`, { force: true });
      return { header, targetPath: targetDbPath, skipped: false };
    } finally {
      rmSync(stagedPath, { force: true });
    }
  }

  private readSnapshot(snapshotPath: string): { header: SnapshotHeader; dbBytes: Buffer } {
    return readSnapshotFile(snapshotPath);
  }
}

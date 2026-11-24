import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface TraceRecord {
  at: number;
  kind: string;
  [key: string]: unknown;
}

export interface TraceScan {
  /** Every record that parsed; malformed lines are skipped, never fatal. */
  records: TraceRecord[];
  /** Byte offsets of malformed complete lines. */
  damaged: number[];
  /** The file does not end on a record boundary, so the next append would be glued onto the tail. */
  unterminated: boolean;
  /** The final line was torn by a kill mid-append and does not parse. */
  tailTruncated: boolean;
  /** Nothing parsed at all while the file was non-empty: total loss, moved aside by `recover()`. */
  totalLoss: boolean;
  bytes: number;
}

const TEXT_FIELDS = new Set([
  'text', 'args', 'reason', 'value', 'detail', 'purpose', 'message', 'command',
  'spec', 'question', 'findings', 'nextStep', 'stoppedStep', 'output', 'path',
  'key', 'title', 'error', 'rejectedReason',
]);

function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringValues(item, out);
  return out;
}

export function forgetNeedles(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => {
    const trimmed = text.trim();
    return [trimmed, ...trimmed.split(/[^\p{L}\p{N}_-]+/u)].filter(longEnoughForTrace);
  }))];
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function longEnoughForTrace(token: string): boolean {
  return token.length >= (CJK.test(token) ? 4 : 8);
}

export function forgetHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashedValue(value: string, hashes: ReadonlySet<string>): boolean {
  return [value.trim(), ...value.trim().split(/[^\p{L}\p{N}_-]+/u)]
    .some((token) => longEnoughForTrace(token) && hashes.has(forgetHash(token)));
}

function shouldForget(record: TraceRecord, start: number, end: number, needles: readonly string[], hashes: ReadonlySet<string>): boolean {
  const values = stringValues(record);
  if (needles.some((needle) => values.some((value) => value.includes(needle)))) return true;
  if (hashes.size > 0 && values.some((value) => hashedValue(value, hashes))) return true;
  if (typeof record.at !== 'number' || record.at < start || record.at >= end) return false;
  return Object.entries(record).some(([key, value]) => TEXT_FIELDS.has(key) && typeof value === 'string' && value !== '');
}

/**
 * The trace is evidence, and evidence is allowed to age out (#226). One rotated generation keeps
 * the previous ~8 MiB; `read()`/`recover()` see the live file, and the `.1` file is what a forensics
 * pass opens when the live log starts mid-story. Rotation is by rename, which is safe because this
 * file is shell-owned (unlike `service.log`, written through a daemon's inherited fd).
 */
export const TRACE_MAX_BYTES = 8 * 1024 * 1024;

export class TraceLog {
  readonly path: string;
  private readonly maxBytes: number;
  private warned = false;
  /** Byte ranges already reported; keyed by offset so a repeated read cannot grow the log. */
  private readonly reportedDamage = new Set<number>();

  constructor(readonly dir: string, fileName = 'shell-events.jsonl', options: { maxBytes?: number } = {}) {
    this.path = join(dir, fileName);
    this.maxBytes = options.maxBytes ?? TRACE_MAX_BYTES;
  }

  append(kind: string, record: Record<string, unknown> = {}, now = Date.now()): void {
    // `at` and `kind` win over anything a caller put in `record`: a scheduled time belongs in its
    // own field (scheduledAt), never as the time the record was written.
    const entry: TraceRecord = { ...record, at: now, kind };
    try {
      mkdirSync(this.dir, { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[companion-shell] trace write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (statSync(this.path).size < this.maxBytes) return;
    } catch {
      return;
    }
    const rotated = `${this.path}.1`;
    try {
      rmSync(rotated, { force: true });
      renameSync(this.path, rotated);
    } catch {
      // A rotation that cannot rename is not a reason to stop recording; the size check retries.
      return;
    }
    // Offsets in `reportedDamage` address the old file; clearing them keeps the new file's report
    // honest instead of suppressing a fresh corruption at a coincidentally equal offset.
    this.reportedDamage.clear();
    this.append('trace_rotated', { maxBytes: this.maxBytes, rotated });
  }

  /**
   * Test/CLI helper: every parseable record. A malformed line is skipped and the rest survives —
   * returning `[]` for the whole file on one bad byte is how evidence disappears silently.
   */
  read(): TraceRecord[] {
    return this.scan().records;
  }

  forgetWindow(start: number, end: number, texts: readonly string[] = [], hashes: readonly string[] = []): number {
    const needles = forgetNeedles(texts);
    const hashed = new Set(hashes);
    return this.rewrite(this.path, start, end, needles, hashed) + this.rewrite(`${this.path}.1`, start, end, needles, hashed);
  }

  private rewrite(path: string, start: number, end: number, needles: readonly string[], hashes: ReadonlySet<string>): number {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return 0;
    }
    let removed = 0;
    const kept: string[] = [];
    for (const line of raw.split('\n')) {
      let record: TraceRecord | undefined;
      try {
        record = line === '' ? undefined : (JSON.parse(line) as TraceRecord);
      } catch {
        record = undefined;
      }
      if (record && shouldForget(record, start, end, needles, hashes)) {
        removed += 1;
        continue;
      }
      kept.push(line);
    }
    if (removed === 0) return 0;
    const temp = `${path}.tmp`;
    writeFileSync(temp, kept.join('\n'), 'utf8');
    const fd = openSync(temp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    return removed;
  }

  /**
   * The log's recovery entry: the same tolerant read, plus the one-time record of the damage and the
   * repair of a torn tail. A file that ends mid-record is terminated with a newline, exactly as Pi's
   * session loader repairs a truncated final line, so the next append cannot be glued onto the
   * fragment; the damaged byte range is written down once.
   */
  recover(): TraceScan & { reported: boolean } {
    return this.recoverOnce(false);
  }

  private recoverOnce(moved: boolean): TraceScan & { reported: boolean } {
    const scan = this.scan();
    if (scan.totalLoss && !moved) {
      // Total loss: nothing in this file can be read back. Move the bytes aside so the shell keeps a
      // log it can write to, and say so loudly rather than running on with no evidence at all.
      try {
        renameSync(this.path, `${this.path}.corrupt`);
      } catch {
        // The move is hygiene; the record below is the part that matters.
      }
      this.append('trace_corrupt', { totalLoss: true, skipped: scan.damaged.length, bytes: scan.bytes });
      return { ...this.scan(), totalLoss: true, reported: true };
    }
    let reported = false;
    const fresh = scan.damaged.filter((offset) => !this.reportedDamage.has(offset));
    if (scan.unterminated) {
      // Pi's rule (`loadEntriesFromFile`): a non-empty file that does not end in a newline gets one.
      // Without it the record this method is about to append — or any later append — would land on
      // the torn line and take a parseable record down with it.
      try {
        appendFileSync(this.path, '\n', 'utf8');
      } catch {
        // Best effort; the report below still lands on a fresh line unless the file is unwritable.
      }
    }
    if (fresh.length > 0) {
      for (const offset of scan.damaged) this.reportedDamage.add(offset);
      this.append('trace_corrupt', {
        skipped: fresh.length,
        totalSkipped: scan.damaged.length,
        tailTruncated: scan.tailTruncated,
        kept: scan.records.length,
        bytes: scan.bytes,
      });
      reported = true;
    }
    return { ...scan, reported };
  }

  /** One read of the file, line by line, with byte offsets so a report is idempotent. */
  private scan(): TraceScan {
    let raw: string;
    let bytes: number;
    try {
      raw = readFileSync(this.path, 'utf8');
      bytes = statSync(this.path).size;
    } catch {
      return { records: [], damaged: [], unterminated: false, tailTruncated: false, totalLoss: false, bytes: 0 };
    }
    const records: TraceRecord[] = [];
    const damaged: number[] = [];
    let offset = 0;
    let torn = false;
    const lines = raw.split('\n');
    const unterminated = raw.length > 0 && !raw.endsWith('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineOffset = offset;
      offset += Buffer.byteLength(line, 'utf8') + 1;
      if (line === '') continue;
      try {
        records.push(JSON.parse(line) as TraceRecord);
      } catch {
        damaged.push(lineOffset);
        // Only the final line can be a torn write; a bad line in the middle is a bad record.
        if (index === lines.length - 1 && unterminated) torn = true;
      }
    }
    return { records, damaged, unterminated, tailTruncated: torn, totalLoss: records.length === 0 && damaged.length > 0, bytes };
  }
}

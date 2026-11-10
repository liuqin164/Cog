/**
 * Append-only JSONL trace: transitions, hook decisions, cage violations, capture outcomes.
 *
 * The trace is evidence, not state. A trace write that fails does not halt the shell (unlike the
 * checkpoint, where a failed write means the recovered state would be a lie), but it does say so on
 * stderr once, because a silently missing trace is how a spike loses the kill test's story.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TraceRecord {
  at: number;
  kind: string;
  [key: string]: unknown;
}

export class TraceLog {
  readonly path: string;
  private warned = false;

  constructor(readonly dir: string, fileName = 'shell-events.jsonl') {
    this.path = join(dir, fileName);
  }

  append(kind: string, record: Record<string, unknown> = {}, now = Date.now()): void {
    // `at` and `kind` win over anything a caller put in `record`: a scheduled time belongs in its
    // own field (scheduledAt), never as the time the record was written.
    const entry: TraceRecord = { ...record, at: now, kind };
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[companion-shell] trace write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Test/CLI helper: read every record written so far. */
  read(): TraceRecord[] {
    try {
      return readFileSync(this.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line: string) => JSON.parse(line) as TraceRecord);
    } catch {
      return [];
    }
  }
}

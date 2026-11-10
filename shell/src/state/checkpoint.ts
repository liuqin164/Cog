/**
 * The shell's own runtime state, written on every transition.
 *
 * Persistence is the kill-recovery contract: a process killed mid-RUNNING must come back with a
 * state that says what it was doing, its wake intents, and an active run id that can be retired.
 * A write that fails means the state on disk is not the state in memory, so the caller halts and
 * alarms instead of running on with a checkpoint nobody can trust.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isState, type State, type Trigger } from './table.ts';

export interface TransitionRecord {
  seq: number;
  from: State;
  to: State;
  trigger: Trigger;
  reason?: string;
  runId?: string;
  at: number;
}

export interface WakeIntent {
  id: string;
  at: number;
  reason: string;
  createdAt: number;
  consumedAt?: number;
}

export interface ShellRuntimeState {
  lastDreamDate?: string;
  lastInteractionAt?: number;
  lastInteractionText?: string;
  /** The block injected when the shell last woke; the system prompt reuses it until the next wake. */
  lastTimeContext?: string;
  /**
   * The tool loadout the transcript declared (Pi's `declareToolChanges`). Recovery compares it with
   * the executable set: a loadout the checkpoint promised but the process can no longer run is a
   * loud failure, not a silently degraded run.
   */
  declaredTools?: string[];
  /**
   * The tool calls a RUNNING run had started but not finished when the checkpoint was last written.
   * On recovery these are what a replay would have to be judged against; the shell refuses replay
   * for any whose policy is `never` (see `ToolDefinition.replay`).
   */
  inFlightToolCalls?: Array<{ toolCallId: string; toolName: string }>;
}

export interface CheckpointState {
  version: 1;
  state: State;
  seq: number;
  activeRunId?: string;
  lastTransition?: TransitionRecord;
  wakeIntents: WakeIntent[];
  runtime: ShellRuntimeState;
  history: TransitionRecord[];
  updatedAt: number;
}

export class CheckpointWriteError extends Error {
  readonly code = 'checkpoint_write_failed';
  constructor(readonly path: string, readonly cause: unknown) {
    super(`checkpoint_write_failed: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export class CheckpointCorruptError extends Error {
  readonly code = 'checkpoint_corrupt';
}

const MAX_HISTORY = 200;

export function emptyCheckpoint(now = Date.now()): CheckpointState {
  return { version: 1, state: 'DORMANT', seq: 0, wakeIntents: [], runtime: {}, history: [], updatedAt: now };
}

export class CheckpointStore {
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, 'checkpoint.json');
  }

  load(): CheckpointState | undefined {
    if (!existsSync(this.path)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new CheckpointCorruptError(`checkpoint_corrupt: ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new CheckpointCorruptError(`checkpoint_corrupt: ${this.path}: not an object`);
    const value = parsed as CheckpointState;
    if (value.version !== 1 || !isState(String(value.state)) || typeof value.seq !== 'number') {
      throw new CheckpointCorruptError(`checkpoint_corrupt: ${this.path}: unexpected shape`);
    }
    return value;
  }

  /** Atomic and durable: temp file, fsync, rename, fsync the directory. Throws on any failure. */
  save(state: CheckpointState): void {
    const temp = `${this.path}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      const fd = openSync(temp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      const dirFd = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // The temp file is best-effort cleanup; the save failure is what the caller must hear.
      }
      throw new CheckpointWriteError(this.path, error);
    }
  }

  trimHistory(history: TransitionRecord[]): TransitionRecord[] {
    return history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;
  }
}

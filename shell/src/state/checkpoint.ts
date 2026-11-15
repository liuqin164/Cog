/**
 * The shell's own runtime state, written on every transition.
 *
 * Persistence is the kill-recovery contract: a process killed mid-RUNNING must come back with a
 * state that says what it was doing, its wake intents, and an active run id that can be retired.
 * A write that fails means the state on disk is not the state in memory, so the caller halts and
 * alarms instead of running on with a checkpoint nobody can trust.
 *
 * Publishing is atomic (temp + fsync + rename), and one previous generation is kept by hard link, so
 * the live path holds either the previous complete checkpoint or the new one — never a half file, and
 * never nothing. A live file damaged from outside falls back one generation and reports it; two bad
 * generations are a loud `CheckpointCorruptError` instead of a guess.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
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

/** A tool call a RUNNING run had started but not finished; the unit recovery judges for replay. */
export interface InFlightToolCall {
  toolCallId: string;
  toolName: string;
}

/**
 * The one paused run (#228). A work-tier budget stop or a question the companion asked both end the
 * run and leave this object behind; the lifecycle state is SUSPENDED while it exists.
 *
 * There is deliberately no expiry: a resident companion may wait days for its owner, and a pause
 * that timed out would silently drop work the user asked for. A question is retired when the owner
 * answers it (or when a new instruction supersedes the paused assignment), a budget request when the
 * owner approves or declines it. See `docs/engineering/4.0-issue-loop.md`'s round record for the
 * rules as reported.
 */
export interface Suspension {
  id: string;
  kind: 'budget' | 'question';
  assignmentId: string;
  createdAt: number;
  /** The run that suspended, so the pause is attributable in the trace. */
  runId?: string;
  /** Budget kind: the measured estimate the owner is asked to grant. */
  budget?: {
    /** Which cap the run hit, when the cage recorded it. */
    violation?: 'turn_budget' | 'token_budget';
    tokens: number;
    turns: number;
    tokensPerTurn: number;
    additionalTokens: number;
    additionalTurns: number;
    /** The arithmetic in one line, so the number is auditable instead of magic. */
    basis: string;
  };
  /** Question kind: what was asked and a short reference to what it is about. */
  question?: { text: string; contextRef?: string };
  /** Set when the owner's answer was delivered; cleared when the resumed run settles. */
  answeredAt?: number;
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
  inFlightToolCalls?: InFlightToolCall[];
  /**
   * Lines typed while RUNNING and not yet injected, FIFO. They are state, not memory (#210): the
   * run's context lives in the process, so a kill before the turn boundary would otherwise lose a
   * line the model never saw. Restored in order on the next start and drained at the next boundary.
   */
  pendingSteering?: string[];
  /** Follow-up lines waiting for the run to end, same contract as `pendingSteering`. */
  pendingFollowUps?: string[];
  /** Last attach/detach of a TUI, so "while you were away" has a window to read. */
  lastAttachAt?: number;
  lastDetachAt?: number;
  /**
   * Emergence candidates that arrived with nobody attached. Talking to an empty room is not
   * presence, so they are held here and reported on the next attach instead of spoken into the void.
   */
  awayQueue?: Array<{ id: string; text: string; reason: string; at: number }>;
  /** Today's cumulative token cost and its local date, so the footer's "本日" survives a restart. */
  costDayDate?: string;
  costDayTokens?: number;
  /**
   * The user-assigned task open across runs. Its `origin` is the ledger provenance the budget tier
   * reads: only `user_message` earns the work cage and only while the task is unfinished. A budget
   * stop fills `stoppedStep` / `nextStep`, which the next run gets in its prompt tail.
   */
  openAssignment?: {
    id: string;
    origin: 'user_message';
    text: string;
    startedAt: number;
    lastRunId?: string;
    stoppedAt?: number;
    stoppedStep?: string;
    nextStep?: string;
    /**
     * The conclusions the run itself wrote down when it ended unfinished (bounded; the closing text
     * of the last run, collapsed to one line). The next run gets it in the prompt tail, so a
     * continuation does not re-read the same sources to rediscover the same line numbers.
     */
    findings?: string;
    /**
     * The budget the owner granted at a pause (#228). Added to the work cage's limits for the
     * resumed run only; `budgets.json` stays the base cap, so an approval extends one continuation
     * and never edits the policy. Consumed when that run settles.
     */
    grant?: { tokens: number; turns: number };
    /**
     * Autonomous continuation attempts since the last progress or user input (#228). Only an
     * `emergence_due` wake increments it; a successful tool result or a user line resets it.
     */
    attempts?: number;
    /** The earliest instant an autonomous wake may continue this assignment again. */
    nextResumeAt?: number;
  };
  /** The one paused run, present exactly while the lifecycle state is SUSPENDED. */
  suspension?: Suspension;
  /**
   * Emergence's own ledger (#229). Counts and one-shot candidate keys live here so a restart cannot
   * repeat yesterday's surfacing; the day is Asia/Tokyo's, independent of the display time zone.
   */
  emergence?: {
    /** Asia/Tokyo local date the count belongs to. */
    day: string;
    count: number;
    lastAt?: number;
    /** Consumed candidate keys, oldest first. The shell keeps the newest 500. */
    consumed: string[];
  };
  /**
   * A restart was requested by the plugin surface, and the open assignment should continue once the
   * new process is up. Only a requested restart sets this: a kill does not, so the kill matrix's
   * "recover to IDLE, never replay" rule is untouched.
   */
  resumeAfterRestart?: { assignmentId: string; at: number; reason: 'plugins' };
  /**
   * `/pause`: while true the shell's ingest call points write nothing to the kernel. It is state, not
   * a UI toggle — a pause that a restart forgot would resume capturing behind the user's back, so it
   * lives in the checkpoint with everything else the next process must honour.
   */
  capturePaused?: boolean;
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

/** Where a recovered checkpoint came from, so the trace can name the damage instead of hiding it. */
export interface CheckpointFallback {
  /** Why the live file was rejected. */
  reason: string;
  /** The generation that was used instead (`checkpoint.json.prev`). */
  from: string;
  /** The live file, moved aside to `<path>.corrupt` so the next save cannot inherit it. */
  damaged: string;
}

const MAX_HISTORY = 200;

export function emptyCheckpoint(now = Date.now()): CheckpointState {
  return { version: 1, state: 'DORMANT', seq: 0, wakeIntents: [], runtime: {}, history: [], updatedAt: now };
}

export class CheckpointStore {
  readonly path: string;
  /** The previous generation, kept by hard link so publishing still never has a window with no file. */
  readonly previousPath: string;

  constructor(readonly dir: string) {
    this.path = join(dir, 'checkpoint.json');
    this.previousPath = `${this.path}.prev`;
  }

  load(): CheckpointState | undefined {
    if (!existsSync(this.path)) return undefined;
    return this.parse(readFileSync(this.path, 'utf8'));
  }

  /**
   * The recovery load: the live file, or the previous generation when the live one cannot be parsed.
   *
   * The atomic publish already means a kill can only leave a whole file, so damage here is damage
   * from outside (bit rot, a hand edit, a truncated copy). One generation of fallback is what keeps
   * "the checkpoint will not parse" from meaning "the resident never comes up"; if neither file is
   * usable the corruption is loud, and the caller's machine stays in DORMANT with nothing dispatched.
   */
  loadRecovered(): { state: CheckpointState; fallback?: CheckpointFallback } | undefined {
    if (!existsSync(this.path)) return undefined;
    let reason: string;
    try {
      return { state: this.parse(readFileSync(this.path, 'utf8')) };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (existsSync(this.previousPath)) {
      try {
        const state = this.parse(readFileSync(this.previousPath, 'utf8'));
        // Move the damaged file aside before returning: otherwise the next save would hard-link it
        // into `.prev` and poison the one generation that is known to be good.
        try {
          renameSync(this.path, `${this.path}.corrupt`);
        } catch {
          // Keeping the damaged file in place is safe; the next successful save replaces it.
        }
        return { state, fallback: { reason, from: this.previousPath, damaged: this.path } };
      } catch {
        // Both generations are unusable; fall through to the loud failure.
      }
    }
    throw new CheckpointCorruptError(`checkpoint_corrupt: ${this.path}: ${reason}`);
  }

  private parse(raw: string): CheckpointState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
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
      this.keepPrevious();
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

  /**
   * Keep exactly one previous generation, by hard link rather than copy: the old file's bytes are
   * already durable, and a link costs no data write on the hot path. It happens *before* the rename,
   * so the live path is never absent — a kill between the two leaves the old complete checkpoint
   * where `load()` expects it.
   *
   * Best effort by design: a filesystem without hard links loses the fallback generation, it does
   * not fail the save (durability of the new checkpoint is what the caller is waiting on).
   */
  private keepPrevious(): void {
    if (!existsSync(this.path)) return;
    try {
      rmSync(this.previousPath, { force: true });
      linkSync(this.path, this.previousPath);
    } catch {
      // See above: the fallback generation is a convenience, the publish is the contract.
    }
  }

  trimHistory(history: TransitionRecord[]): TransitionRecord[] {
    return history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;
  }
}

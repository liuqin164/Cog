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
import type { SessionDigestEntry } from 'cogmem';
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

export interface InboundMessage {
  id: string;
  text: string;
  textId?: string;
  channel: string;
  at: number;
  status: 'queued' | 'failed';
  error?: string;
}

/**
 * The one paused run (#228). A work-tier budget stop or a question the companion asked both end the
 * run and leave this object behind; the lifecycle state is SUSPENDED while it exists.
 *
 * There is deliberately no expiry: a resident companion may wait days for its owner, and a pause
 * that timed out would silently drop work the user asked for. A question is retired when the owner
 * answers it (or when a new instruction supersedes the paused assignment), a budget request when the
 * owner approves or declines it. The internal engineering archive holds the round record for the
 * rules as reported.
 */
export interface Suspension {
  id: string;
  kind: 'budget' | 'question';
  assignmentId: string;
  userText?: string;
  userTextId?: string;
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
  question?: { text: string; textId?: string; contextRef?: string };
  /** Set when the owner's answer was delivered; cleared when the resumed run settles. */
  answeredAt?: number;
}

export interface ShellRuntimeState {
  lastDreamDate?: string;
  dreamRetry?: { night: string; attempts: number; nextAt: number; gaveUp?: boolean };
  memoryModel?: { state: 'reachable' | 'unreachable' | 'degraded'; reason?: string; since: number; pendingBackfill?: boolean };
  lastSnapshotAt?: number;
  lastSnapshotFailureAt?: number;
  snapshotRetry?: { attempts: number; nextAt: number };
  lastInteractionAt?: number;
  declaredTools?: string[];
  /**
   * The tool calls a RUNNING run had started but not finished when the checkpoint was last written.
   * On recovery these are what a replay would have to be judged against; the shell refuses replay
   * for any whose policy is `never` (see `ToolDefinition.replay`).
   */
  inFlightToolCalls?: InFlightToolCall[];
  pendingSteering?: Array<{ text: string; textId?: string }>;
  pendingFollowUps?: Array<{ text: string; textId?: string }>;
  /**
   * Lines submitted while the run could not take them. They wait for the run to settle, then start
   * their own user run with the channel they arrived on. A failed item stays for a later resend.
   */
  inboundQueue?: InboundMessage[];
  /** Last attach/detach of a TUI, so "while you were away" has a window to read. */
  lastAttachAt?: number;
  lastDetachAt?: number;
  /**
   * Emergence candidates that arrived with nobody attached. Talking to an empty room is not
   * presence, so they are held here and reported on the next attach instead of spoken into the void.
   */
  awayQueue?: Array<{
    id: string;
    text: string;
    textId?: string;
    reason: string;
    at: number;
    source?: string;
    observedAt?: number;
    sourceRefs?: Array<{ eventId?: string; sourceId?: string; contentHash?: string }>;
    /** `quiet` waits for the window to close; `absence` waits for the next attach. */
    deferred?: 'quiet' | 'absence';
  }>;
  /** Today's cumulative token cost and its local date, so the footer's "本日" survives a restart. */
  costDayDate?: string;
  costDayTokens?: number;
  /**
   * The day counter's value when the current Night started. The night cap is a delta over the one
   * day counter, so a restart mid-night cannot refund the model spend it already made.
   */
  dreamNightDate?: string;
  dreamNightStartTokens?: number;
  /**
   * The user-assigned task open across runs. Its `origin` is the ledger provenance the budget tier
   * reads: only `user_message` earns the work cage and only while the task is unfinished. A budget
   * stop fills `stoppedStep` / `nextStep`, which the next run gets in its prompt tail.
   */
  openAssignment?: {
    id: string;
    origin: 'user_message';
    text: string;
    textId?: string;
    /** The newest user line attached to this task; `text` stays the task's original brief. */
    latestUserText?: string;
    latestUserTextId?: string;
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
    findingsId?: string;
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
  /**
   * A task that `declare_task end` closed (#263), waiting for the run's ledger row so its digest
   * stub can be built deterministically. The shell clears this as soon as the stub is written; a
   * restart between the declaration and the write retries it on the next assembly.
   */
  lastEndedTask?: {
    assignmentId: string;
    startedAt: number;
    endedAt: number;
    runId?: string;
    /** The turn the end declaration arrived in; `<runId>:0` when the tool supplied one. */
    turnId?: string;
    /**
     * What the model explicitly declared when it ended the task (#262). The shell builds the
     * procedure descriptor from this plus the task's captured `tool_call` rows; absent when the
     * model filled no domain/key, in which case the book stays unchanged rather than guessing.
     */
    procedure?: {
      domain: string;
      key: string;
      checklist: boolean;
    };
  };
  /**
   * The digest stubs finished tasks left behind (#263). Each is a `SessionDigest` entry built from
   * ledger rows, never a model summary; the newest are kept, and the list is bounded so a long
   * resident does not grow its checkpoint without limit.
   */
  taskStubs?: Array<SessionDigestEntry & { textId?: string }>;
  /**
   * Working-set items the kernel marked `protected` at task end (#255). A constraint is not task
   * material, so it stays in the lane verbatim even though the rest of the working set exits.
   */
  retainedConstraints?: Array<{ id: string; text: string; textId?: string }>;
  /** The one paused run, present exactly while the lifecycle state is SUSPENDED. */
  suspension?: Suspension;
  /**
   * Emergence's own ledger (#229). Counts and one-shot candidate keys live here so a restart cannot
   * repeat yesterday's surfacing; the day is the configured project time zone's (#285).
   */
  emergence?: {
    /** Configured local date the count belongs to. */
    day: string;
    count: number;
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

const RUNTIME_KEYS: Record<keyof ShellRuntimeState, true> = {
  lastDreamDate: true,
  dreamRetry: true,
  memoryModel: true,
  lastSnapshotAt: true,
  lastSnapshotFailureAt: true,
  snapshotRetry: true,
  lastInteractionAt: true,
  declaredTools: true,
  inFlightToolCalls: true,
  pendingSteering: true,
  pendingFollowUps: true,
  inboundQueue: true,
  lastAttachAt: true,
  lastDetachAt: true,
  awayQueue: true,
  costDayDate: true,
  costDayTokens: true,
  dreamNightDate: true,
  dreamNightStartTokens: true,
  openAssignment: true,
  lastEndedTask: true,
  taskStubs: true,
  retainedConstraints: true,
  suspension: true,
  emergence: true,
  resumeAfterRestart: true,
  capturePaused: true,
};

export interface RuntimeTextLedger {
  record(kind: string, text: string): string;
  read(eventId: string): string | undefined;
  has(eventId: string, text: string): boolean;
}

export function emptyCheckpoint(now = Date.now()): CheckpointState {
  return { version: 1, state: 'DORMANT', seq: 0, wakeIntents: [], runtime: {}, history: [], updatedAt: now };
}

export function forgetRuntimeText(runtime: ShellRuntimeState, ledger: RuntimeTextLedger): { runtime: ShellRuntimeState; cleared: number } {
  const gone = (eventId?: string): boolean => eventId !== undefined && ledger.read(eventId) === undefined;
  let cleared = 0;
  const next: ShellRuntimeState = { ...runtime };

  const assignment = runtime.openAssignment;
  if (assignment && gone(assignment.textId)) {
    next.openAssignment = undefined;
    cleared += 1;
  } else if (assignment) {
    let copy = assignment;
    if (gone(assignment.latestUserTextId)) {
      copy = { ...copy, latestUserText: undefined, latestUserTextId: undefined };
      cleared += 1;
    }
    if (gone(assignment.findingsId)) {
      copy = { ...copy, findings: undefined, findingsId: undefined };
      cleared += 1;
    }
    next.openAssignment = copy === assignment ? assignment : copy;
  }

  for (const key of ['awayQueue', 'taskStubs', 'retainedConstraints'] as const) {
    const entries = runtime[key];
    if (!entries) continue;
    const kept = entries.filter((entry) => !gone(entry.textId));
    cleared += entries.length - kept.length;
    next[key] = kept as never;
  }

  if (runtime.inboundQueue) {
    const kept = runtime.inboundQueue.filter((entry) => !gone(entry.textId));
    cleared += runtime.inboundQueue.length - kept.length;
    next.inboundQueue = kept.length > 0 ? kept : undefined;
  }

  for (const key of ['pendingSteering', 'pendingFollowUps'] as const) {
    const entries = runtime[key];
    if (!entries) continue;
    const kept = entries.filter((entry) => entry.textId !== undefined && !gone(entry.textId));
    cleared += entries.length - kept.length;
    next[key] = kept;
  }

  if (runtime.suspension) {
    let copy = runtime.suspension;
    if (gone(copy.userTextId)) {
      copy = { ...copy, userText: undefined, userTextId: undefined };
      cleared += 1;
    }
    if (copy.question && gone(copy.question.textId)) {
      copy = { ...copy, question: undefined };
      cleared += 1;
    }
    next.suspension = copy;
  }

  return { runtime: next, cleared };
}

export class CheckpointStore {
  readonly path: string;
  /** The previous generation, kept by hard link so publishing still never has a window with no file. */
  readonly previousPath: string;

  constructor(readonly dir: string, private readonly ledger?: RuntimeTextLedger) {
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
    return this.hydrate(value);
  }

  /** Atomic and durable: temp file, fsync, rename, fsync the directory. Throws on any failure. */
  save(state: CheckpointState): void {
    const temp = `${this.path}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(temp, `${JSON.stringify(this.persist(state), null, 2)}\n`, 'utf8');
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

  private textId(current: string | undefined, kind: string, text: string | undefined): string | undefined {
    if (!text || !this.ledger) return current;
    return current && this.ledger.has(current, text) ? current : this.ledger.record(kind, text);
  }

  private persist(state: CheckpointState): CheckpointState {
    if (!this.ledger) return state;
    const runtime = state.runtime;
    const copy = Object.fromEntries(
      (Object.keys(RUNTIME_KEYS) as Array<keyof ShellRuntimeState>).map((key) => [key, runtime[key]]),
    ) as ShellRuntimeState;

    const assignment = runtime.openAssignment;
    if (assignment) {
      assignment.textId = this.textId(assignment.textId, 'assignment.text', assignment.text);
      assignment.latestUserTextId = this.textId(assignment.latestUserTextId, 'assignment.latest', assignment.latestUserText);
      assignment.findingsId = this.textId(assignment.findingsId, 'assignment.findings', assignment.findings);
      const { text: _text, latestUserText: _latest, findings: _findings, ...rest } = assignment;
      copy.openAssignment = rest as ShellRuntimeState['openAssignment'];
    }

    if (runtime.awayQueue) {
      copy.awayQueue = runtime.awayQueue.map((entry) => {
        entry.textId = this.textId(entry.textId, 'away.text', entry.text);
        const { text: _text, ...rest } = entry;
        return rest as NonNullable<ShellRuntimeState['awayQueue']>[number];
      });
    }

    if (runtime.inboundQueue) {
      copy.inboundQueue = runtime.inboundQueue.map((entry) => {
        entry.textId = this.textId(entry.textId, 'inbound.text', entry.text);
        const { text: _text, ...rest } = entry;
        return rest as InboundMessage;
      });
    }

    if (runtime.taskStubs) {
      copy.taskStubs = runtime.taskStubs.map((stub) => {
        stub.textId = this.textId(stub.textId, 'task.stub', stub.text);
        const { text: _text, ...rest } = stub;
        return rest as SessionDigestEntry & { textId?: string };
      });
    }

    if (runtime.retainedConstraints) {
      copy.retainedConstraints = runtime.retainedConstraints.map((constraint) => {
        constraint.textId = this.textId(constraint.textId, 'constraint.text', constraint.text);
        const { text: _text, ...rest } = constraint;
        return rest as { id: string; text: string; textId?: string };
      });
    }

    for (const [key, kind] of [['pendingSteering', 'steering.text'], ['pendingFollowUps', 'followup.text']] as const) {
      const entries = runtime[key];
      if (!entries) continue;
      copy[key] = entries.map((entry) => {
        entry.textId = this.textId(entry.textId, kind, entry.text);
        const { text: _text, ...rest } = entry;
        return rest as { text: string; textId?: string };
      });
    }

    const suspension = runtime.suspension;
    if (suspension) {
      suspension.userTextId = this.textId(suspension.userTextId, 'suspension.user', suspension.userText);
      if (suspension.question) {
        suspension.question.textId = this.textId(suspension.question.textId, 'suspension.question', suspension.question.text);
      }
      const { userText: _userText, question, ...rest } = suspension;
      copy.suspension = {
        ...rest,
        ...(question
          ? (() => {
            const { text: _questionText, ...questionRest } = question;
            return { question: questionRest };
          })()
          : {}),
      } as Suspension;
    }

    return { ...state, runtime: copy };
  }

  private hydrate(state: CheckpointState): CheckpointState {
    if (!this.ledger) return state;
    const ledger = this.ledger;
    const runtime = state.runtime;

    const assignment = runtime.openAssignment;
    if (assignment) {
      const text = assignment.textId ? ledger.read(assignment.textId) : assignment.text;
      if (text === undefined) {
        runtime.openAssignment = undefined;
      } else {
        assignment.text = text;
        if (assignment.latestUserTextId) assignment.latestUserText = ledger.read(assignment.latestUserTextId);
        if (assignment.findingsId) assignment.findings = ledger.read(assignment.findingsId);
      }
    }

    if (runtime.awayQueue) {
      runtime.awayQueue = runtime.awayQueue.flatMap((entry) => {
        const text = entry.textId ? ledger.read(entry.textId) : entry.text;
        return text === undefined ? [] : [{ ...entry, text }];
      });
    }

    if (runtime.inboundQueue) {
      runtime.inboundQueue = runtime.inboundQueue.flatMap((entry) => {
        const text = entry.textId ? ledger.read(entry.textId) : entry.text;
        return text === undefined ? [] : [{ ...entry, text }];
      });
    }

    if (runtime.taskStubs) {
      runtime.taskStubs = runtime.taskStubs.flatMap((stub) => {
        const text = stub.textId ? ledger.read(stub.textId) : stub.text;
        return text === undefined ? [] : [{ ...stub, text }];
      });
    }

    if (runtime.retainedConstraints) {
      runtime.retainedConstraints = runtime.retainedConstraints.flatMap((constraint) => {
        const text = constraint.textId ? ledger.read(constraint.textId) : constraint.text;
        return text === undefined ? [] : [{ ...constraint, text }];
      });
    }

    for (const key of ['pendingSteering', 'pendingFollowUps'] as const) {
      const entries = runtime[key];
      if (!entries) continue;
      runtime[key] = (entries as unknown as Array<string | { text?: string; textId?: string }>).flatMap((entry) => {
        if (typeof entry === 'string') return [{ text: entry }];
        const text = entry.textId ? ledger.read(entry.textId) : entry.text;
        return text === undefined ? [] : [{ ...entry, text }];
      });
    }

    const suspension = runtime.suspension;
    if (suspension?.userTextId) suspension.userText = ledger.read(suspension.userTextId);
    if (suspension?.question?.textId) {
      const text = ledger.read(suspension.question.textId);
      if (text === undefined) suspension.question = undefined;
      else suspension.question.text = text;
    }

    return state;
  }
}

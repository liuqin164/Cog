import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { digestAnchors, type SessionContextItem, type SessionDigestEntry, type SessionToolCall, type SessionTurn } from 'cogmem';
import type { CompanionShell } from './app.ts';
import { SecretRedactor } from './kernel-host.ts';
import { currentPluginDossiers, type PluginDossier } from './plugins/self-install.ts';
import type { TraceRecord } from './trace.ts';

const MAX_TASK_STUB_QUOTE_CHARS = 240;
const MAX_TASK_STUBS = 20;
const TASK_STUB_RETRY_MS = 60 * 60_000;

export class ContextLanes {
  private readonly redactor = new SecretRedactor();
  private soulFailureTraced = false;
  private pluginDossiers?: PluginDossier[];

  constructor(private readonly shell: CompanionShell) {}

  /**
   * The system prompt is assembled from two sections, and the split is a contract, not a layout
   * choice. The **pinned zone** is the soul (verbatim, at its head), the identity and the rules: its
   * bytes must be identical from one request to the next, which is what F14's lane order starts with
   * (#191) and the half of it a provider-side prompt cache can hit. The **variable tail** is the only
   * place per-turn content may live; today that is the time context, which is why it is rebuilt from
   * the live clock on every call instead of reusing the block written at the last wake — a prompt
   * that froze "now" at boot kept telling the model it was still morning three hours later.
   *
   * Pi holds the same property structurally: named sections rendered in a fixed order, diffed so a
   * changed section travels as an update instead of the prompt being re-sent (`core/system-prompt.js`
   * `buildSystemPromptSections` / `diffSystemPromptSections`), and a tool list frozen so "the cached
   * prefix survives every tool change" (`pi-ai/dist/api/anthropic-messages.js:947-951`). The shell has
   * one seam and no mid-run prompt mutation, so the pinned zone is what plays that part.
   */
  systemPromptSections(): { pinned: string; tail: string } {
    const pinned = [
      this.soulText(),
      'You are a resident companion agent whose memory is Cogmem. The recall lane in this request is already assembled for the turn; look there first.',
      'Conversation capture is automatic: every user turn and every reply is already written to your memory. The cogmem CLI belongs to the operator, not to you. For one exact ledger row, use the `read` tool with `mem:<eventId>`, or the `memory` tool with action `read`; that is the in-process memory read.',
      'Your memory is one ledger with several lanes. The recall, digest, working-set and conversation lanes are all views of it: a fact from the conversation is a fact from your memory, not a missing or unsaved one.',
      'When you name a source, name the lane ("from our conversation earlier"). Never call a conversation-lane fact "not from long-term memory", and never offer to save what capture has already written. If no lane carries the answer, call `memory` with action `search`; action `recent` reads this session, and `read` opens a `mem:<eventId>` key. Say whether the search found the memory or not; never present a guess as a memory.',
      'You are present at all hours; when nothing needs you, you are quiet rather than chatty.',
      'You have four basic tools (read, write, edit, bash), plus `memory` for on-demand recall. Use them when the moment needs real work; otherwise just talk.',
      'To hand the user a shell command, call `propose_command` with the command and a one-line reason. It is only an offer: the command runs when the user confirms it, never before, so never say it already ran.',
      'A new user line continues the open task by default. Call `declare_task` with action "start" only when the newest line begins a different task, and with "end" when the open task is finished. Judge by meaning, never by a word.',
      'Never invent a memory. If no lane carries a fact, say so plainly and ask; never claim it was not stored.',
    ].filter(Boolean);
    const tail = [this.shell.clock ? this.shell.clock.timeContextBlock(this.shell.now()) : '', this.suspensionBlock()].filter(Boolean);
    return { pinned: pinned.join('\n\n'), tail: tail.join('\n\n') };
  }

  /**
   * The open assignment as the `working_set` lane's first open loop. A budget stop writes where it
   * stopped and what is next; the next run (user or autonomous wake) reads it verbatim, so the work
   * does not restart from the same file read.
   */
  private openAssignmentBlock(): string {
    const assignment = this.shell.machine.runtime.openAssignment;
    if (!assignment || this.shell.hideAssignmentContext) return '';
    return [
      '<open-assignment>',
      `user-assigned task: ${assignment.text}`,
      assignment.stoppedStep ? `stopped at: ${assignment.stoppedStep}` : '',
      assignment.nextStep ? `next: ${assignment.nextStep}` : '',
      assignment.findings ? `confirmed findings: ${assignment.findings}` : '',
      '</open-assignment>',
    ].filter(Boolean).join('\n');
  }

  /**
   * The resumed run's half of a question pause (#228): the answer is the run's user text, and this
   * block is what makes that answer answerable. It is rendered only while the object exists, which
   * is until the resumed run settles — the question object is gone from an idle shell.
   */
  private suspensionBlock(): string {
    const suspension = this.shell.machine.runtime.suspension;
    if (!suspension || suspension.kind !== 'question' || suspension.question === undefined) return '';
    return [
      '<pending-question>',
      `you asked: ${suspension.question.text}`,
      suspension.question.contextRef ? `about: ${suspension.question.contextRef}` : '',
      "the user's next line is the answer; continue the open task from it.",
      '</pending-question>',
    ].filter(Boolean).join('\n');
  }

  systemPrompt(): string {
    const { pinned, tail } = this.systemPromptSections();
    return [pinned, tail].filter(Boolean).join('\n\n');
  }

  /** The active model route's sweet spot, with the shell config as the built-in route's value. */
  targetTokens(): number {
    return this.shell.modelRouter?.targetTokens ?? this.shell.config.contextSweetSpot;
  }

  /** The stable pinned lane: the soul and the shell's rules, split into renderable paragraphs. */
  lanePinned(): string[] {
    return this.systemPromptSections().pinned.split('\n\n').filter(Boolean);
  }

  /** The compiled profile's current entries, one renderable line per entry. */
  laneProfile(): string[] {
    try {
      return this.shell.kernel.profile
        .entries({ projectId: this.shell.config.projectId })
        .map((entry) => `${entry.ledger}/${entry.key}: ${entry.value}`);
    } catch (error) {
      this.shell.trace.append('profile_lane_failed', { message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /** The open loops that must survive a restart, plus the dossiers this turn names or calls. */
  laneOpenLoops(query?: string, toolNames: readonly string[] = []): SessionContextItem[] {
    const items: SessionContextItem[] = [];
    const assignment = this.shell.machine.runtime.openAssignment;
    const assignmentText = this.openAssignmentBlock();
    if (assignment && assignmentText) {
      items.push({ id: `assignment:${assignment.id}`, text: assignmentText });
    }
    items.push(...this.lanePluginDossiers(query, toolNames));
    items.push(...this.laneProcedures());
    // A constraint the task-end exit retained is not task material (#255, #263). It was already
    // classified by the kernel's own markers during the last assembly; the shell only keeps the
    // text and re-marks it, so the next assembly's protection rule is unchanged.
    for (const constraint of this.shell.machine.runtime.retainedConstraints ?? []) {
      items.push({ id: constraint.id, text: constraint.text, protected: true });
    }
    for (const intent of this.shell.machine.wakeIntents) {
      if (intent.consumedAt) continue;
      items.push({
        id: `wake:${intent.id}`,
        text: `wake intent: ${intent.reason} (scheduled ${new Date(intent.at).toISOString()})`,
        protected: true,
      });
    }
    return items;
  }

  private lanePluginDossiers(query: string | undefined, toolNames: readonly string[]): SessionContextItem[] {
    const mentioned = (query ?? '').toLowerCase();
    const called = new Set(toolNames);
    this.pluginDossiers ??= currentPluginDossiers(this.shell.trace);
    const registered = new Set(this.shell.config.plugins);
    const matched = this.pluginDossiers
      .filter((dossier) => registered.has(dossier.sourcePath))
      .filter((dossier) => mentioned.includes(dossier.name.toLowerCase()) || dossier.tools.some((tool) => called.has(tool)));
    if (matched.length === 0) return [];
    const records = this.shell.trace.read();
    return matched.map((dossier) => ({ id: dossier.id, text: this.renderPluginDossier(dossier, records) }));
  }

  private renderPluginDossier(dossier: PluginDossier, records: readonly TraceRecord[]): string {
    const incidents = records
      .filter((record) => (record.kind === 'plugin_failed' && record.name === dossier.name)
        || (record.kind === 'plugin_health_failed' && (record.id === dossier.proposalId || record.name === dossier.name)))
      .map((record) => `incident: ${new Date(record.at).toISOString()} ${record.kind} ${String(record.message ?? record.reason ?? '')}`);
    return [
      `<plugin-dossier name="${dossier.name}">`,
      `purpose: ${dossier.purpose}`,
      `decision (llm_inference): ${dossier.decision.text}`,
      `interface: provide=[${dossier.permissions.provide.join(', ')}] inject=[${dossier.permissions.inject.join(', ')}] tools=[${dossier.tools.join(', ')}] commands=[${dossier.commands.join(', ')}]`,
      `permissions.data=[${dossier.permissions.data.join(', ')}]`,
      `limitations: ${dossier.limitations.join('; ') || '（未记录）'}`,
      `installed: ${new Date(dossier.installedAt).toISOString()} · proposal ${dossier.proposalId} · v${dossier.version}${dossier.supersedes ? ` supersedes ${dossier.supersedes}` : ''}`,
      `source: ${dossier.sourcePath} sha256=${dossier.sourceSha256} ${this.sourceState(dossier)}`,
      ...incidents,
      '</plugin-dossier>',
    ].join('\n');
  }

  private sourceState(dossier: PluginDossier): string {
    try {
      const current = createHash('sha256').update(readFileSync(dossier.sourcePath)).digest('hex');
      return current === dossier.sourceSha256 ? 'verified' : `mismatch current=${current}`;
    } catch {
      return 'missing';
    }
  }

  /**
   * The practice lane at the start of work (#261): the task's own description is what recalls a
   * practice, never a skill name. A `checklist` entry is carried whole and marked protected so the
   * lane's budget rule cannot fold it into a pointer; a `recall` entry is an ordinary working-set
   * item and may be downgraded. The book exits with the assignment at task end (#263).
   */
  laneProcedures(): SessionContextItem[] {
    const assignment = this.shell.machine.runtime.openAssignment;
    if (!assignment || this.shell.hideAssignmentContext) return [];
    try {
      const assembly = this.shell.backend.assembleTaskProcedures({
        projectId: this.shell.config.projectId,
        task: assignment.text,
      });
      return assembly.items
        .filter((item) => item.kind === 'procedure')
        .map((item) => {
          const anchor = item.sourceRefs[0]?.eventId;
          return {
            id: `procedure:${item.entryId}`,
            text: item.text,
            ...(item.mandatory ? { protected: true } : {}),
            ...(anchor === undefined ? {} : {
              sourceRefs: item.sourceRefs
                .map((ref) => ref.eventId)
                .filter((id): id is string => typeof id === 'string' && id !== ''),
              anchorEvent: anchor,
              sourceLocator: `read mem:${anchor}`,
            }),
          };
        });
    } catch (error) {
      this.shell.trace.append('procedure_lane_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  laneDigestStubs(): SessionDigestEntry[] {
    this.materializeTaskProcedure(false);
    this.materializeTaskEndStub(undefined, undefined, this.shell.machine.activeRunId);
    return [...(this.shell.machine.runtime.taskStubs ?? [])];
  }

  /**
   * The procedure book's producer (#262): a declared task end leaves one `task_event` whose
   * `metadata.procedure` the compiler reads. `domain` and `key` are the model's own end-time fill;
   * `steps` and `tools` are built only from the task's captured `tool_call` rows, in capture order.
   * A task that made no tool calls leaves no entry — an empty book beats a fabricated one.
   *
   * Called after capture has written the end run's rows (settle, or the next assembly after a
   * restart); the declaration is cleared once the row exists so a retry cannot write it twice.
   */
  materializeTaskProcedure(final: boolean): void {
    const pending = this.shell.machine.runtime.lastEndedTask;
    const declaration = pending?.procedure;
    if (!pending || !declaration) return;
    let calls: SessionToolCall[];
    try {
      calls = this.shell.backend.sessionToolCalls({
        projectId: this.shell.config.projectId,
        agentId: this.shell.config.agentId,
        sessionId: this.shell.config.sessionId,
        since: pending.startedAt,
      });
    } catch (error) {
      this.shell.trace.append('task_procedure_failed', {
        assignmentId: pending.assignmentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const evidence = procedureEvidenceOf(calls);
    if (!evidence) {
      // Before the run settles, capture has not written this run's tool rows yet: an empty read
      // here is "not yet", not "no calls". Only the settle pass may conclude there was no evidence.
      if (final) {
        this.shell.machine.updateRuntime({ lastEndedTask: { ...pending, procedure: undefined } });
        this.shell.trace.append('task_procedure_skipped', { assignmentId: pending.assignmentId, reason: 'no_trace_evidence' });
      }
      return;
    }
    // #279: the end declaration's own ledger row is the idempotency key. A kill between the
    // append below and the checkpoint clear leaves that row in the ledger, so a replay finds it
    // and writes nothing; compile still runs in case the kill landed before the compile.
    if (this.taskProcedureWritten(evidence.declarationEventId)) {
      try {
        this.shell.kernel.procedures.compile({ projectId: this.shell.config.projectId, now: this.shell.now() });
      } catch (error) {
        this.shell.trace.append('task_procedure_failed', {
          assignmentId: pending.assignmentId,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.shell.machine.updateRuntime({ lastEndedTask: { ...pending, procedure: undefined } });
      this.shell.trace.append('task_procedure_duplicate_skipped', {
        assignmentId: pending.assignmentId,
        declarationEventId: evidence.declarationEventId,
      });
      return;
    }
    try {
      this.shell.kernel.recordTaskEvent({
        projectId: this.shell.config.projectId,
        workspaceId: this.shell.config.projectId,
        threadId: this.shell.config.sessionId,
        sessionId: this.shell.config.sessionId,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        title: `${declaration.domain}/${declaration.key}`,
        content: `task completed: ${declaration.domain}/${declaration.key} (${evidence.steps.length} tool calls)`,
        occurredAt: this.shell.now(),
        sourceId: `${this.shell.config.agentId}:${this.shell.config.sessionId}`,
        metadata: {
          sourceAgent: this.shell.config.agentId,
          source: 'companion-shell',
          kind: 'task-procedure',
          procedure: {
            domain: declaration.domain,
            key: declaration.key,
            checklist: declaration.checklist,
            outcome: 'succeeded',
            steps: evidence.steps,
            tools: evidence.tools,
            declarationEventId: evidence.declarationEventId,
          },
        },
      });
      this.shell.kernel.procedures.compile({ projectId: this.shell.config.projectId, now: this.shell.now() });
    } catch (error) {
      this.shell.trace.append('task_procedure_failed', {
        assignmentId: pending.assignmentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.shell.machine.updateRuntime({ lastEndedTask: { ...pending, procedure: undefined } });
    this.shell.trace.append('task_procedure_written', {
      assignmentId: pending.assignmentId,
      domain: declaration.domain,
      key: declaration.key,
      steps: evidence.steps.length,
      tools: evidence.tools,
    });
  }

  /** Whether the same end declaration already produced its task_event (#279). */
  private taskProcedureWritten(declarationEventId: string): boolean {
    try {
      return this.shell.backend.taskProcedureRecorded({
        projectId: this.shell.config.projectId,
        declarationEventId,
      });
    } catch (error) {
      this.shell.trace.append('task_procedure_lookup_failed', {
        declarationEventId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  materializeTaskEndStub(turnId?: string, runId?: string, deferRunId?: string): void {
    const pending = this.shell.machine.runtime.lastEndedTask;
    if (!pending) return;
    if (deferRunId !== undefined && pending.runId === deferRunId) return;
    const resolvedTurnId = pending.turnId
      ?? (pending.runId !== undefined && pending.runId === runId ? turnId : undefined);
    if (!resolvedTurnId) {
      if (this.shell.now() - pending.endedAt > TASK_STUB_RETRY_MS) {
        this.shell.machine.updateRuntime({ lastEndedTask: undefined });
        this.shell.trace.append('task_stub_skipped', { assignmentId: pending.assignmentId, reason: 'no_turn_id' });
      }
      return;
    }
    let turns: SessionTurn[];
    try {
      turns = this.shell.backend.sessionTurns({
        projectId: this.shell.config.projectId,
        agentId: this.shell.config.agentId,
        sessionId: this.shell.config.sessionId,
      }).turns;
    } catch (error) {
      this.shell.trace.append('task_stub_failed', {
        assignmentId: pending.assignmentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const stub = buildTaskStub(turns, {
      startedAt: pending.startedAt,
      turnId: resolvedTurnId,
    });
    if (!stub) {
      if (this.shell.now() - pending.endedAt > TASK_STUB_RETRY_MS) {
        this.shell.machine.updateRuntime({ lastEndedTask: undefined });
        this.shell.trace.append('task_stub_skipped', { assignmentId: pending.assignmentId, reason: 'no_ledger_turn' });
      }
      return;
    }
    const byId = new Map<string, SessionDigestEntry>();
    for (const entry of [...(this.shell.machine.runtime.taskStubs ?? []), stub]) byId.set(entry.entryId, entry);
    const taskStubs = [...byId.values()].slice(-MAX_TASK_STUBS);
    this.shell.machine.updateRuntime({ taskStubs, lastEndedTask: undefined });
    this.shell.trace.append('task_stub_written', {
      assignmentId: pending.assignmentId,
      entryId: stub.entryId,
      sourceRefs: stub.sourceRefs,
      chars: stub.text.length,
    });
  }

  /**
   * The newest soul row, read where it is: it is the pinned zone's head, so it is injected verbatim,
   * and F17's editor has to reach the next request without a restart. A database with no row is not
   * a turn failure — the pinned zone is simply shorter. A real read failure is recorded once, so an
   * absent soul and a soul that failed to load stay distinguishable.
   */
  private soulText(): string {
    try {
      return this.shell.kernel.soul.read(this.shell.config.agentId)?.content ?? '';
    } catch (error) {
      // The read is retried every turn — a lock held for a moment must not cost the soul for the rest
      // of the process's life — but the trace entry is one-shot, or a database the installer never
      // wrote would file the same record on every turn forever.
      if (!this.soulFailureTraced) {
        this.soulFailureTraced = true;
        this.shell.trace.append('soul_read_failed', { message: error instanceof Error ? error.message : String(error) });
      }
      return '';
    }
  }

  /**
   * The durable prompt log. A restart has to be able to reconstruct the run.
   */
  recordPrompt(input: { runId: string; sessionId: string; text: string }): void {
    const marked = this.redactor.mark(input.text);
    this.shell.trace.append('run_prompt', {
      runId: input.runId,
      sessionId: input.sessionId,
      chars: input.text.length,
      text: marked.value,
      ...marked.metadata,
    });
  }

}

/**
 * The one digest stub a declared task end leaves (#263). Every fragment is an exact prefix of a
 * ledger row — the task's opening user line, the last conclusion before the end run, and the end
 * run's own closing line — never a model-written summary. The primary row is the conclusion, so
 * `read mem:<entryId's event>` opens the words that say what was done; the other rows are the
 * stub's `sourceRefs`. `turnId` names the end declaration's run; the ledger row for it is written
 * by capture before `settleAssignment` runs.
 */
function buildTaskStub(
  turns: readonly SessionTurn[],
  input: { startedAt: number; turnId: string },
): SessionDigestEntry | undefined {
  const taskTurns = turns.filter((turn) => turn.occurredAt >= input.startedAt);
  if (taskTurns.length === 0) return undefined;
  const currentUser = taskTurns.find((turn) => turn.turnId === input.turnId && turn.role === 'user');
  if (!currentUser) return undefined;
  const currentAssistant = taskTurns.find((turn) => turn.turnId === input.turnId && turn.role === 'assistant');
  const priorAssistant = [...taskTurns.slice(0, taskTurns.indexOf(currentUser))].reverse().find((turn) => turn.role === 'assistant');
  const opening = taskTurns.find((turn) => turn.role === 'user') ?? taskTurns[0]!;
  const closing = priorAssistant ?? currentAssistant ?? opening;
  const quotes: Array<{ label: string; turn: SessionTurn }> = [];
  const seen = new Set<string>();
  const add = (label: string, turn: SessionTurn | undefined): void => {
    if (!turn || seen.has(turn.eventId)) return;
    seen.add(turn.eventId);
    quotes.push({ label, turn });
  };
  add('任务', opening);
  add('做了什么', priorAssistant);
  add(priorAssistant ? '收束' : '做了什么', currentAssistant);
  const text = quotes
    .map((quote) => `${quote.label}：${exactLinePrefix(quote.turn.text, MAX_TASK_STUB_QUOTE_CHARS)}`)
    .join(' · ');
  return {
    entryId: `digest:${closing.eventId}`,
    kind: 'turn',
    sessionId: closing.sessionId,
    occurredAt: closing.occurredAt,
    speaker: closing.speaker,
    text,
    sourceRefs: [...new Set([closing.eventId, ...quotes.map((quote) => quote.turn.eventId)])],
    anchor: digestAnchors(text).length > 0,
  };
}

/**
 * The procedure's evidence, from the task's captured tool calls only (#262). One step per real
 * call, in order, cut at the end declaration's own row: a call made after the task was declared
 * over is not a step of it, and the boundary tool is never a step. No calls before the boundary
 * means no evidence — the caller writes nothing rather than an empty practice. The compiler's
 * frozen caps (`MAX_STEPS` 16, `MAX_TOOLS` 8) are applied here so the trace records what was kept.
 */
function procedureEvidenceOf(calls: readonly SessionToolCall[]): { steps: string[]; tools: string[]; declarationEventId: string } | undefined {
  const end = calls.findIndex((call) =>
    call.toolName === 'declare_task'
    && (call.input as { action?: unknown } | undefined)?.action === 'end');
  if (end < 0) return undefined;
  const ordered = calls.slice(0, end).filter((call) => call.toolName !== 'declare_task');
  if (ordered.length === 0) return undefined;
  const steps = ordered.slice(0, 16).map((call) => {
    const input = compactToolInput(call.input);
    return input ? `${call.toolName}: ${input}` : call.toolName;
  });
  const tools = [...new Set(ordered.map((call) => call.toolName))].slice(0, 8);
  return { steps, tools, declarationEventId: calls[end]!.eventId };
}

/** A tool call's input, one line and bounded: the step names what was called, not the whole file. */
function compactToolInput(input: unknown): string {
  if (input === undefined) return '';
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  if (!text) return '';
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 119)}…`;
}

/** The first non-empty line, cut to `limit`; the kept part is an exact prefix of the ledger row. */
function exactLinePrefix(text: string, limit: number): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? text;
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

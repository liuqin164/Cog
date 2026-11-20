import { randomUUID } from 'node:crypto';
import type { CompanionShell } from './app.ts';
import type { CommandReply } from './commands.ts';
import { executeProposal, type CommandProposal, type ProposalConfirmation } from './proposals.ts';

const MAX_RETAINED_CONSTRAINTS = 8;

export class ProposalsHandlers {
  /** The proposal that offers `/continue` for the current pause; Esc on it is the owner's refusal. */
  private suspensionProposalId?: string;

  constructor(private readonly shell: CompanionShell) {}

  // ---- Command proposals (spec §7, #165 round 22): the agent offers, the user decides. ----

  /**
   * The user's "Enter". This is the only caller of `executeProposal`, and the confirmation event it
   * builds is the user's key — there is no other way for a proposal to reach the dispatcher, which
   * reuses `runCommand` so a confirmed proposal and a typed `/pause` are the same execution. The
   * agent's side is the `propose_command` tool (`plugins/proposal.ts`), which only records.
   */
  async confirmProposal(id: string): Promise<{ ok: boolean; proposal?: CommandProposal; reason?: string; reply?: CommandReply }> {
    const proposal = this.shell.proposals.get(id);
    const confirmation: ProposalConfirmation | undefined = proposal
      ? { kind: 'user-confirm', proposalId: proposal.id, at: this.shell.now() }
      : undefined;
    const outcome = await executeProposal(proposal, confirmation, {
      dispatch: (command, args) => this.shell.runCommand(command, args),
      trace: this.shell.trace,
      now: this.shell.now,
    });
    if (outcome.ok && proposal) this.shell.proposals.settled(proposal);
    return {
      ok: outcome.ok,
      ...(proposal ? { proposal } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.reply ? { reply: outcome.reply } : {}),
    };
  }

  /** The user's "Esc": retire a pending proposal; it can never be confirmed after this. */
  discardProposal(id: string): CommandProposal | undefined {
    const proposal = this.shell.proposals.discard(id);
    // Esc on the budget offer is the owner's refusal (#228): the task closes as budget_exceeded and
    // the receipt says so, instead of leaving a pause nobody can see the end of.
    if (proposal && id === this.suspensionProposalId) {
      this.suspensionProposalId = undefined;
      this.rejectSuspended();
    }
    return proposal;
  }

  /** The pending offers, for tests and any face that wants the list rather than the transcript. */
  currentProposals(): CommandProposal[] {
    return [...this.shell.proposals.pending()];
  }

  // ---- The suspension faces (#228): one pause object, three exits (approve, refuse, supersede). ----

  /**
   * Offer the owner the one way to continue a budget pause. It reuses the command-proposal shape —
   * Enter confirms `/continue`, Esc refuses it — because that is the mechanism this shell already
   * has for "the agent asks, the owner decides". The offer is re-made after a restart: the pause is
   * durable, the in-memory proposal registry is not.
   */
  offerResume(suspensionId: string): void {
    const suspension = this.shell.machine.runtime.suspension;
    if (!suspension || suspension.id !== suspensionId || suspension.kind !== 'budget') return;
    const { proposal } = this.shell.proposals.propose({
      command: 'continue',
      args: suspension.id,
      reason: `预算到顶：再给 ${suspension.budget?.additionalTokens ?? 0} token / ${suspension.budget?.additionalTurns ?? 0} 回合就能继续（${suspension.budget?.basis ?? ''}）`,
    });
    this.suspensionProposalId = proposal.id;
  }

  /**
   * `/continue`: the owner approves the estimate. The grant is written onto the assignment (so it
   * survives a crash between approval and the run) and the pause is cleared in the same checkpoint
   * write; the run itself is dispatched from the next tick of the event loop, like the plugin
   * restart's resume, so the command's receipt reaches the socket first.
   */
  continueSuspended(): CommandReply {
    const suspension = this.shell.machine.runtime.suspension;
    if (this.shell.machine.state !== 'SUSPENDED' || !suspension) return { text: '现在没有挂起的 run，不需要续跑。', receipt: true };
    if (suspension.kind !== 'budget') return { text: '这次挂起在等一个回答，不是等预算：直接回复即可。', receipt: true };
    if (this.shell.statusFace.dailyBudgetExceeded()) this.shell.statusFace.announceDailyBudget('budget_approved');
    const assignment = this.shell.machine.runtime.openAssignment;
    if (assignment && assignment.id !== suspension.assignmentId) {
      this.shell.trace.append('suspension_resume_refused', { id: suspension.id, reason: 'assignment_mismatch' });
      return { text: '挂起对象与当前任务对不上，没有续跑（痕迹已记）。', receipt: true };
    }
    const grant = { tokens: suspension.budget?.additionalTokens ?? 0, turns: suspension.budget?.additionalTurns ?? 0 };
    this.suspensionProposalId = undefined;
    this.shell.machine.updateRuntime({
      ...(assignment ? { openAssignment: { ...assignment, grant, attempts: 0, nextResumeAt: undefined } } : {}),
      suspension: undefined,
    });
    this.shell.trace.append('suspension_approved', { id: suspension.id, assignmentId: assignment?.id ?? null, grant, basis: suspension.budget?.basis });
    setTimeout(() => {
      void this.resumeSuspendedRun(suspension.userText ?? '', grant).catch((error) =>
        this.shell.trace.append('suspension_resume_failed', { assignmentId: assignment?.id ?? null, message: error instanceof Error ? error.message : String(error) }),
      );
    }, 0);
    return { text: `已批准：追加 ${grant.tokens} token / ${grant.turns} 回合，原地续跑。`, receipt: true };
  }

  private async resumeSuspendedRun(userText: string, grant?: { tokens: number; turns: number }): Promise<void> {
    if (this.shell.machine.state !== 'SUSPENDED') {
      this.shell.trace.append('suspension_resume_skipped', { reason: `state:${this.shell.machine.state}` });
      return;
    }
    await this.shell.executeRun(userText, 'message_received', 'budget_approved', 'budget_approved', grant);
  }

  /**
   * The owner refused. The task closes exactly as an unattended budget stop used to (#228): the
   * assignment is gone, the trace keeps the refusal and the numbers it refused, and the lifecycle
   * returns to standby through the `budget_rejected` edge.
   */
  private rejectSuspended(): void {
    const suspension = this.shell.machine.runtime.suspension;
    if (this.shell.machine.state !== 'SUSPENDED' || !suspension) return;
    this.shell.trace.append('suspension_rejected', {
      id: suspension.id,
      assignmentId: suspension.assignmentId,
      kind: suspension.kind,
      additionalTokens: suspension.budget?.additionalTokens ?? null,
      closedAs: 'budget_exceeded',
    });
    this.shell.machine.updateRuntime({ suspension: undefined, openAssignment: undefined });
    void this.shell.machine.dispatch('budget_rejected', { reason: 'owner_rejected_budget' }).catch((error) =>
      this.shell.trace.append('suspension_reject_failed', { id: suspension.id, message: error instanceof Error ? error.message : String(error) }),
    );
  }

  /**
   * A new instruction while a budget pause waits: the pause is closed and the trace says how. The
   * assignment stays open (#246 A2): the new line attaches to it in `beginUserAssignment`, so the
   * stop's place and findings are still in the next prompt.
   */
  supersedeSuspension(reason: string): void {
    const suspension = this.shell.machine.runtime.suspension;
    if (!suspension) return;
    this.suspensionProposalId = undefined;
    this.shell.trace.append('suspension_superseded', {
      id: suspension.id,
      assignmentId: suspension.assignmentId,
      kind: suspension.kind,
      reason,
      closedAs: 'budget_exceeded',
    });
    this.shell.machine.updateRuntime({ suspension: undefined });
  }

  /**
   * `ask_user`'s one entry (#228). Only a work run may wait for the owner: an autonomous run has no
   * one to answer it and must not hold a pause open, so the tool refuses there and the model is told
   * to carry on. The question is process-local until the run settles; the checkpointed object is
   * written by `settleAssignment`.
   */
  askUser(input: { question: string; context?: string }): { ok: boolean; text: string } {
    const question = input.question.trim();
    if (question === '') return { ok: false, text: 'invalid_arguments: "question" must be a non-empty string' };
    if (this.shell.runTier !== 'work' || this.shell.machine.state !== 'RUNNING') {
      this.shell.trace.append('question_refused_autonomous', { chars: question.length });
      return { ok: false, text: 'ask_user_unavailable: 这次是自主 run，没有人在等你的问题；不要等，直接按现有信息做完或收尾。' };
    }
    const contextRef = input.context?.trim();
    this.shell.pendingQuestion = {
      text: question,
      ...(contextRef ? { contextRef } : {}),
    };
    this.shell.trace.append('question_registered', { chars: question.length, contextChars: contextRef?.length ?? 0 });
    return { ok: true, text: '已登记问题：这次 run 到此挂起，用户回答后原任务原地续跑。不要再调用工具，也不要假装已经得到回答。' };
  }

  /**
   * `declare_task`'s one entry (#246 A2). Whether a line starts a different task is a semantic
   * judgement, so the shell does not read keywords: the front model says so through this explicit
   * declaration, and the shell settles the old assignment the way a completed run does. The trace
   * record is the auditable shape C5/D3 will consume.
   */
  declareTask(input: { action?: string; runId?: string; domain?: string; key?: string; checklist?: boolean }): { ok: boolean; text: string } {
    const action = input.action;
    if (action !== 'start' && action !== 'end') {
      return { ok: false, text: 'invalid_arguments: "action" must be "start" or "end"' };
    }
    if (this.shell.runTier !== 'work' || this.shell.machine.state !== 'RUNNING') {
      this.shell.trace.append('assignment_declaration_refused', { action, runId: input.runId, reason: `tier:${this.shell.runTier}`, state: this.shell.machine.state });
      return { ok: false, text: 'declare_task_unavailable: 只有用户在场的 work run 才能声明任务边界；自主 run 不要调用。' };
    }
    const previous = this.shell.machine.runtime.openAssignment;
    if (action === 'end') {
      if (!previous) {
        this.shell.trace.append('assignment_declaration_refused', { action, runId: input.runId, reason: 'no_open_assignment' });
        return { ok: false, text: 'declare_task_refused: 现在没有 open assignment，无需声明结束。' };
      }
      // #263: the working set exits as a lane, not item by item. The assignment is the shell's
      // working-set material; a protected item inside it is a constraint and stays (#255). The
      // stub is written once the run's ledger row exists (at settle, or the next assembly after a
      // restart), so it quotes the row rather than the model's memory of it.
      const workingItem = this.shell.lastLaneAssembly
        ?.lanes.find((lane) => lane.lane === 'working_set')
        ?.items.find((item) => item.id === `assignment:${previous.id}`);
      const retained = workingItem?.protected === true
        ? [...(this.shell.machine.runtime.retainedConstraints ?? []), { id: `constraint:${previous.id}`, text: workingItem.text }]
            .slice(-MAX_RETAINED_CONSTRAINTS)
        : this.shell.machine.runtime.retainedConstraints;
      // #262: domain and key are the model's explicit fill at the end; steps and tools come from
      // the task's captured tool calls, never from this input. Missing either means no entry.
      const domain = input.domain?.trim() ?? '';
      const key = input.key?.trim() ?? '';
      const procedure = domain !== '' && key !== ''
        ? { domain, key, checklist: input.checklist === true }
        : undefined;
      this.shell.machine.updateRuntime({
        openAssignment: undefined,
        lastEndedTask: {
          assignmentId: previous.id,
          startedAt: previous.startedAt,
          endedAt: this.shell.now(),
          ...(input.runId ? { runId: input.runId, turnId: `${input.runId}:0` } : {}),
          ...(procedure ? { procedure } : {}),
        },
        ...(retained === undefined ? {} : { retainedConstraints: retained }),
      });
      this.shell.trace.append('assignment_declared', {
        action,
        runId: input.runId,
        previousAssignmentId: previous.id,
        assignmentId: null,
        textChars: previous.text.length,
        protectedRetained: workingItem?.protected === true,
        procedure: procedure ? `${procedure.domain}/${procedure.key}` : null,
      });
      return {
        ok: true,
        text: procedure
          ? '已声明任务结束：open assignment 已收束，本 run 剩余部分不再把它当待办；做法条目将由本任务的真实工具轨迹生成。'
          : '已声明任务结束：open assignment 已收束，本 run 剩余部分不再把它当待办。未填 domain/key，本次不写入做法册。',
      };
    }
    const brief = this.shell.currentRunUserText.trim().slice(0, 500);
    const assignment = {
      id: `assignment-${this.shell.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      origin: 'user_message' as const,
      text: brief,
      latestUserText: brief,
      startedAt: this.shell.now(),
    };
    this.shell.machine.updateRuntime({ openAssignment: assignment });
    this.shell.trace.append('assignment_declared', {
      action,
      runId: input.runId,
      previousAssignmentId: previous?.id ?? null,
      assignmentId: assignment.id,
      textChars: brief.length,
    });
    return { ok: true, text: '已声明新任务：旧 assignment 已收束，新任务以最新用户消息为简报；后续只围绕它继续。' };
  }

}

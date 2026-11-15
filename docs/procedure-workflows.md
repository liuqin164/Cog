# Procedure workflow contract (v1)

A practice that has been done often enough to be boring can stop being a model decision. This face
is the execution layer over F15's procedure book (#228, item 4): an `established` own practice with
three further successful executions may be written as a deterministic workflow — a fixed sequence of
tool calls with literal arguments — rehearsed without side effects, and then executed without the
model choosing each step.

The code is `src/procedure/ProcedureWorkflows.ts`, reached as `MemoryKernel.workflows`. The shell's
half is `shell/src/plugins/workflows.ts`; the page is `/observatory/workflows`. This document is held
by `__tests__/procedure-workflows.contract.test.ts`, which reads the frozen tables below and fails
when code and contract disagree. Version: `WORKFLOW_CONTRACT_VERSION = 1`.

## What this face does not do

- **It does not replace the procedure entry.** The entry stays the source of truth and is never
  edited. A workflow is one execution form of the practice, not a second copy of it. The workflow
  book writes only `PROCEDURE_WORKFLOW_*` rows on `procedure-workflow:<entryId>`.
- **It does not compile or recall.** `ProcedureCompiler`'s semantics, entry rows, grades and recall
  are untouched.
- **It has no branch.** A step is exactly `{ tool, args, success }`. There is nowhere to put an `if`,
  a loop, or a step that depends on text the model computed at run time. A practice that needs a
  judgement stays on the model side.
- **It does not perform the rehearsal.** The kernel owns the verdict, not the tools. The shell walks
  the draft against its real registry with every side effect suppressed, then records the verdict.
- **It does not add storage.** Every row is a `memory_events` row. No table, no column, no migration.

## Eligibility (frozen)

Promotion is proposed, never automatic.

| Condition | Why |
|---|---|
| `grade` is `established` | A tentative practice has not survived enough tasks to freeze. |
| `origin` is `experience` | An imported guide and the owner's correction are not own attempts; a correction is the owner's word, not a procedure to execute. |
| `support.successes` ≥ `PROCEDURE_ESTABLISHED_SUCCESSES + WORKFLOW_PROMOTION_EXTRA_SUCCESSES` (2 + 3 = 5) | Three successes after establishment is the point where the steps have survived enough independent tasks to be worth freezing. |
| No pending or active proposal for the entry | One draft at a time. |
| The draft hash was not vetoed or demoted | A refused draft stays refused; a materially different draft may be proposed. |

## Statuses (frozen)

| Status | Means |
|---|---|
| `proposed` | A draft exists and has not been activated. It does not execute. |
| `active` | The draft passed its dry-run and executes deterministically. |
| `vetoed` | The owner refused this draft. It never activates and never executes. |
| `downgraded` | Consecutive execution failures reached the threshold. It no longer executes, and revocation is proposed in the same row. |

## Success criteria (frozen)

| Type | Means |
|---|---|
| `not_error` | The tool result's `isError` is false. |
| `output_contains` | The tool result is not an error and its output contains the literal `text`. |

`output_contains` is a real-execution criterion. A rehearsal cannot know the world's answer, so a
dry-run records the step as unverified rather than pretending it passed or failed.

## Template slots (frozen)

An argument is a literal string, number or boolean, or a string containing these slots. Nothing else
is resolvable.

| Slot | Value |
|---|---|
| `task` | The run's user text. |
| `workspace` | The shell's workspace root. |

An unknown slot, an unclosed `{{`, or a non-literal argument is refused with `workflow_invalid_steps`.

## The face (frozen)

| Method | Writes | Does |
|---|---|---|
| `propose` | `PROCEDURE_WORKFLOW_PROPOSED` | Validate eligibility and the draft, then record it as `proposed`. |
| `dryRun` | `PROCEDURE_WORKFLOW_DRY_RUN` | Record the shell's rehearsal verdict for the current proposal. |
| `activate` | `PROCEDURE_WORKFLOW_ACTIVATED` | Activate only when the current version's dry-run passed. |
| `veto` | `PROCEDURE_WORKFLOW_VETOED` | The owner's veto, naming the owner's turn as evidence. |
| `recordExecution` | `PROCEDURE_WORKFLOW_EXECUTED` (+ `PROCEDURE_WORKFLOW_DEMOTED`) | Record one execution; consecutive failures demote at the threshold and propose revocation. |
| `match` | — | The active workflow whose domain the task hits. |
| `list` | — | The current workflow per entry, newest version first. |
| `audit` | — | Every workflow row for the project, oldest first. |

Adding a method is additive and does not bump the constant. Removing or renaming one does.

## Book events (frozen)

| Type | Written when | Payload |
|---|---|---|
| `PROCEDURE_WORKFLOW_PROPOSED` | A draft passes validation and eligibility. | The workflow row, `status: proposed`. |
| `PROCEDURE_WORKFLOW_DRY_RUN` | The shell records a rehearsal verdict. | The row with `dryRun: { passed, reason?, at }`. |
| `PROCEDURE_WORKFLOW_ACTIVATED` | A passing draft becomes active. | The row with `status: active`, `activatedAt`. |
| `PROCEDURE_WORKFLOW_VETOED` | The owner vetoes a proposed or active draft. | The row with `status: vetoed`, `vetoedAt`, `vetoEventId`. |
| `PROCEDURE_WORKFLOW_EXECUTED` | One execution finishes, succeeded or failed. | The row with `executions`, `consecutiveFailures`, `lastOutcome`, `lastExecutionRefs`. |
| `PROCEDURE_WORKFLOW_DEMOTED` | Consecutive failures reach the threshold. | The same row with `status: downgraded`, `demotedAt`, `revocationProposedAt`. |

## Thresholds (frozen)

| Constant | Value | Means |
|---|---|---|
| `WORKFLOW_PROMOTION_EXTRA_SUCCESSES` | 3 | Successes after establishment before a proposal is eligible. |
| `WORKFLOW_FAILURE_DEMOTION_THRESHOLD` | 2 | Consecutive failed executions before demotion and revocation. A success resets the streak. |

## Execution (shell side)

The shell registers three model-facing tools:

- `list_workflows` presents established practices and the current workflow per entry.
- `propose_workflow` proposes a draft, rehearses it, and activates it only if the rehearsal passed.
  A failed rehearsal leaves the draft `proposed` and returns the reason; the procedure entry is
  unchanged.
- `veto_workflow` records the owner's refusal against the owner's latest turn.

Every step goes through `executeToolCall`, the same pipeline the model's calls take. The cage's
`beforeToolCall` whitelist therefore sees workflow steps exactly as it sees model steps, and the
dry-run's invoker calls `rehearse` instead of `execute`. A tool without a `rehearse` half cannot be
dry-run, so a draft that names one cannot be promoted.

An active workflow is matched by task text at the start of a run. It executes as a normal run on the
same bus and ledger. If a step fails, the workflow run stops at that step, the failure is recorded
against the workflow, and the task falls back to the model in a new run with the failed step named;
the model is told which steps already succeeded and not to repeat them. The procedure entry and the
workflow row are not rewritten by the fallback.

## Errors (frozen)

| Code | When |
|---|---|
| `project_id_required` | A call names no project. |
| `workflow_entry_required` | A call names no procedure entry. |
| `workflow_entry_unknown` | The entry does not exist in the project. |
| `workflow_not_established` | The entry is still tentative. |
| `workflow_not_promotable` | The entry is imported or a correction, not an own practice. |
| `workflow_not_enough_executions` | The entry has not reached the five-success threshold. |
| `workflow_steps_required` | A proposal has no steps. |
| `workflow_invalid_steps` | A step has a branch field, a bad slot, a non-literal argument, a bad criterion, or the draft is too long. |
| `workflow_already_active` | The entry already has an active workflow. |
| `workflow_proposal_pending` | The entry already has a pending proposal. |
| `workflow_version_refused` | This exact draft was vetoed or demoted. |
| `workflow_not_proposed` | A dry-run or activation names no current proposal. |
| `workflow_dry_run_required` | Activation has no rehearsal verdict. |
| `workflow_dry_run_failed` | Activation's rehearsal did not pass. |
| `workflow_not_active` | An execution is recorded against a workflow that is not active. |
| `workflow_evidence_required` | A veto names no owner turn. |
| `invalid_workflow_evidence` | The veto's turn does not exist in the project. |
| `workflow_task_required` | A match names no task text. |

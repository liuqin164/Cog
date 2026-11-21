# Surfacing feedback contract (v1)

Surfacing is only half a loop if the owner's reaction goes nowhere. This face makes the reaction a
first-class ledger event — `engaged`, `ignored`, `stopped` or `snoozed` — and applies fixed,
deterministic modulation to the **proactive** channel. It calls no model, holds no timer and adds no
table: the reaction rows are the state, the history and the audit.

The code is `src/surfacing/SurfacingFeedback.ts`, reached as `MemoryKernel.surfacingFeedback` and
through `KernelAgentMemoryBackend.recordSurfacingFeedback` / `.surfacingFeedbackState` /
`.resumeSurfacingType`. It is held to this document by
`__tests__/surfacing-feedback.contract.test.ts`, which reads the frozen tables below and fails when
code and contract disagree. Version: `SURFACING_FEEDBACK_CONTRACT_VERSION = 1`.

## What this face does not do

- **No model call.** The rule is arithmetic over the feedback rows. A model may read the result
  offline; nothing here asks one whether a candidate was ignored.
- **No shell decision.** The shell reports what the owner did (the reaction and the candidate id);
  it does not decide the level, the cooldown or the stop.
- **No write face on the observatory.** Reading the state is a kernel query. Recording a reaction
  and restarting a type are owner actions on the kernel host API, not HTTP routes; the observatory
  stays read-only.
- **No new source of truth.** Every delivery, reaction and resume is a `memory_events` row on
  `surfacing-feedback:<projectId>`. There is no table, no column and no migration, and the state is
  replayed from those rows, so two readers agree.
- **No asked-channel modulation.** Only the proactive channel is a candidate the companion chose
  to raise. An asked answer is the owner's question being served; feedback does not throttle it.
- **No automatic restart.** A stopped type stays stopped until the owner explicitly resumes it,
  however much time passes.

## Types (frozen)

The type dimension is F6's source dimension. The type is parsed from the candidate id
(`surfacing:<type>:<sourceId>`), so the reaction cannot disagree with what was surfaced.

| Type | Means |
|---|---|
| `wake-intention` | A pending wake intention (F2). |
| `prospective-memory` | A confirmed or deferred prospective memory (F2). |
| `profile` | A current profile entry (F5). |
| `procedure` | A current procedure entry (F15). |
| `commitment` | An arrived commitment (F16). |
| `ledger` | A raw turn from the ledger. |

A topic-level dimension is additive later; v1 does not add one.

## Outcomes (frozen)

| Outcome | Means |
|---|---|
| `engaged` | The owner picked the candidate up: replied, adopted it, or acted on it. |
| `ignored` | The candidate was passed over. |
| `stopped` | The owner explicitly asked this type to stop surfacing. |
| `snoozed` | The owner explicitly deferred the candidate; it is not an ignore. |

## Event types (frozen)

| Event type | Written when |
|---|---|
| `SURFACING_DELIVERED` | A candidate is spoken on the proactive channel; its content is carried for reply matching. |
| `SURFACING_FEEDBACK_RECORDED` | One owner reaction. |
| `SURFACING_TYPE_RESUMED` | The owner explicitly restarts a stopped type. |

`pending` replays these rows oldest first and returns every delivery that no later
`SURFACING_FEEDBACK_RECORDED` row for the same candidate has resolved.

## Feedback event fields (frozen)

| Field | Means |
|---|---|
| `eventId` | The ledger row's id. |
| `projectId` | The project the candidate belonged to. |
| `candidateId` | The F6 candidate id the owner reacted to. |
| `type` | The candidate id's type, recorded explicitly. |
| `outcome` | One of the four outcomes above. |
| `sourceRefs` | The candidate's source refs, carried so the reaction is replayable. |
| `occurredAt` | The injected instant of the reaction. |

## Resume event fields (frozen)

| Field | Means |
|---|---|
| `eventId` | The ledger row's id. |
| `projectId` | The project whose type is restarted. |
| `type` | The type being restarted. |
| `occurredAt` | The injected instant of the resume. |

## Audit entry fields (frozen)

`audit` returns every delivery, feedback and resume row, oldest first, in this shape. `candidateId`
is absent only on a resume row; `outcome` is absent on delivery and resume rows.

| Field | Means |
|---|---|
| `eventId` | The ledger row's id. |
| `eventType` | `SURFACING_DELIVERED`, `SURFACING_FEEDBACK_RECORDED` or `SURFACING_TYPE_RESUMED`. |
| `type` | The type the row names. |
| `candidateId` | The candidate a reaction names. |
| `outcome` | The reaction. |
| `sourceRefs` | The candidate's refs a reaction carried. |
| `occurredAt` | The row's injected instant. |

## Rules (frozen)

These are the whole rule and every parameter. `state()` returns this same table, so there is no
hidden constant.

| Parameter | Value | Means |
|---|---|---|
| `ignoredThreshold` | `3` | Consecutive ignores that raise the level to 1. |
| `maxLevel` | `3` | The highest level; the cooldown stops doubling here. |
| `baseCooldownMs` | `21600000` | Six hours: the level-1 cooldown, doubled per level. |
| `ignoreAfterMs` | `86400000` | One day: a delivered candidate with later owner activity becomes `ignored` after this window without a targeted reply. |

For one type:

- `level = min(floor(consecutiveIgnored / ignoredThreshold), maxLevel)`;
- `cooldownUntil = lastIgnoredAt + baseCooldownMs × 2^(level - 1)` when `level > 0`, else `null`.

## Modulation rule (frozen)

The rule is read only on the `proactive` channel:

| Condition | Decision |
|---|---|
| The type is stopped. | `stopped` — no candidate of that type surfaces. |
| `level > 0` and `now < cooldownUntil`. | `throttled` — no candidate of that type surfaces until the cooldown ends. |
| Otherwise. | `none` — the type surfaces as F6 returned it. |

The counts change only on a reaction:

- `ignored` increments `ignoredCount` and `consecutiveIgnored`, and sets `lastIgnoredAt`;
- `engaged` increments `engagedCount`, resets `consecutiveIgnored` to zero and clears the cooldown,
  so frequency can recover — the loop is not a one-way ratchet;
- `stopped` sets `stopped` and `stoppedAt`; the type stays stopped until a resume row;
- `snoozed` is recorded for audit and resolves the pending candidate, but changes no count, level or
  cooldown;
- a resume clears the stop, `consecutiveIgnored`, `lastIgnoredAt` and the cooldown.

`ignored` is only written when the delivery is followed by owner activity and then `ignoreAfterMs`
passes with no reply that names the candidate's content. A reply names it when the reply and the
delivered content share a non-filler word or a two-character CJK unit. An unrelated message never
counts as engaged and never resets an ignore streak.

Counts do not decay with time. Only an engaged reaction or a resume resets them, so a type that was
ignored three times last month still starts at level 1.

## State fields (frozen)

| Field | Means |
|---|---|
| `projectId` | The project the state was read for. |
| `now` | The instant the state was computed for. |
| `rules` | The frozen rules table above. |
| `types` | Every type, in the order of the type table, zeroed when it has no feedback. |
| `stoppedTypes` | The types currently stopped. |

## Type state fields (frozen)

| Field | Means |
|---|---|
| `type` | One of the six types. |
| `consecutiveIgnored` | Ignores since the last engaged reaction or resume. |
| `level` | The frozen level formula's result. |
| `ignoredCount` | Total ignores, for audit. |
| `engagedCount` | Total engaged reactions, for audit. |
| `stopped` | Whether the type is stopped. |
| `stoppedAt` | The instant of the stop, or `null`. |
| `lastIgnoredAt` | The instant of the last ignore, or `null`. |
| `cooldownUntil` | The instant the current cooldown ends, or `null` at level 0. |

## Observability (#239)

The observatory's health page reads the gate without changing it: feedback outcomes come from the
`SURFACING_FEEDBACK_RECORDED` rows in `memory_events`, while candidate, per-gate withheld, excluded,
attempted, surfaced and failed counts come from the shell's `emergence_decision` /
`emergence_consumed` / `emergence_accumulated` / `emergence_run` rows in `shell-events.jsonl` and
its rotated `.1` generation. Trace rows carry the shell's project id. `surfaced` counts only runs
whose summary ended in `run_complete`; a consumed candidate whose run errored is `runFailed`, not a
delivered surface. The same block returns the current priors — `SURFACING_FEEDBACK_RULES`, the
channel policy and the gate names — so a reader can tell whether the gate is still applying fixed
rules rather than a learned modulation. The observer writes no feedback row, adds no event and does
not change the rules above.

## Trace integration (frozen)

F6's candidate decision trace gains one `modulation` step, appended after `occasion`. Its outcome
is `none`, `throttled`, `stopped` or `not-applicable` (the asked channel). A candidate the
modulation withholds is returned on F6's `withheld` face with that step and its reason; it never
disappears silently. On `proactive` the step's detail carries `type`, `channel`, `level`,
`consecutiveIgnored`, `cooldownUntil` and `stoppedAt`; on `asked` it carries `type`, `channel` and
`applied: false`, because the channel is not modulated.

## API (frozen)

| Method | Does |
|---|---|
| `record` | Record one reaction as a ledger row. |
| `state` | Derive every type's counts, level, cooldown and stop from the ledger. |
| `resume` | The owner restarts a stopped type; appends a resume row. |
| `audit` | Every delivery, feedback and resume row for the project, oldest first. |
| `deliver` | Append a delivery row with the candidate's content and source refs. |
| `pending` | Every delivered candidate with no later resolving feedback row. |

Adding a method is additive. Removing or renaming one, or changing a field, type, outcome, rule or
error meaning, is a breaking change and bumps `SURFACING_FEEDBACK_CONTRACT_VERSION`.

## Errors (frozen)

| Code | When |
|---|---|
| `project_id_required` | A call names no project. |
| `surfacing_candidate_id_required` | A reaction names no candidate. |
| `invalid_surfacing_feedback_type` | The candidate id is not `surfacing:<frozen type>:…`, or a resume names an unknown type. |
| `invalid_surfacing_feedback_outcome` | The outcome is not `engaged`, `ignored` or `stopped`. |
| `invalid_surfacing_feedback_now` | `now` is not finite. |
| `invalid_surfacing_feedback_source_refs` | `sourceRefs` is present but not an array. |

## Scope ceiling

The state is computed on demand from the project's delivery and feedback rows; there is no timer,
no queue and no cached level. One proactive query reads the ledger once, paged at 500 rows up to
4,000 — a project beyond that bound sees the newest 4,000 rows, not a silently widened read.

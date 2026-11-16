# Procedure compilation contract (v1)

A companion learns a job by doing it. This face is the third compiled book (F15 of #192): **"how
this project's work actually got done"** — the steps, the tools chosen, the owner's corrections and
the imported guides — compiled from that project's own attempts, recalled by the task description,
and never by a skill's name. The profile book compiles the person, the session book compiles the
scene, this book compiles the craft.

The code is `src/procedure/ProcedureCompiler.ts`, reached as `MemoryKernel.procedures` and through
`KernelAgentMemoryBackend.assembleTaskProcedures`. It is held to this document by
`__tests__/procedure-compilation.contract.test.ts`, which reads the frozen tables below and fails
when code and contract disagree. Version: `PROCEDURE_CONTRACT_VERSION = 2`.

## What this face does not do

- **No skill catalogue and no skill injection.** Recall is by task text. A capability's code is
  installed by its own installer and is not memory; only the written guide enters here, through the
  #143 import channel's `imported` marker.
- **No model is required on the hot path.** Compilation is deterministic: it reads structured
  descriptors, never free text. When the host attaches an embedding provider, `recall` may use its
  synchronous query hook to rank entries by meaning; without one, recall is the cue-matched lexical
  read it always was.
- **No new storage.** Every version of an entry is a `memory_events` row on
  `procedure-entry:<entryId>`; a recompile leaves a `PROCEDURE_BOOK_RECOMPILED` receipt. No table,
  no column, no migration.
- **No rewrite of the evidence.** Steps are quoted as recorded. A correction is quoted as the owner
  wrote it; the compiler never paraphrases a step.

## Evidence (frozen)

One descriptor shape serves an own attempt and an imported guide. A row without a `domain` and a
`key` is not procedural evidence and is ignored.

| Evidence | Row | Descriptor | Compiles as |
|---|---|---|---|
| Own attempt | `task_event` with `metadata.procedure` | `{ domain, key, title?, steps?, tools?, checklist?, outcome? }` | An `experience` entry. `outcome` is `succeeded` (the default) or `failed`. |
| Imported guide | any `RAW_EVENT_RECORDED` row with `metadata.imported: true` and `metadata.procedure` | the same descriptor | An `imported` entry. It is read, never attempted, so its support count stays zero. |
| User correction | a `user` turn with `metadata.procedureCorrection: { domain, key }`; the turn's text is the correction | — | Replaces the practice it names, at once, and then grades it `established`. |

The `domain` is the task domain ("发布", "security review"); the `key` is the practice's identity
inside it. One entry exists per (domain, key, own-or-imported): an imported guide and an own
practice for the same key coexist, and recall ranks the own practice first. A correction to an
imported-only key becomes its own entry rather than editing the book that was read.

## Grades (frozen)

Support count is confidence.

| Grade | When |
|---|---|
| `tentative` | One success, any failure, or imported material. A practice that failed its latest attempt stays tentative until a success follows. |
| `established` | `PROCEDURE_ESTABLISHED_SUCCESSES` (2) or more successes, or a user correction. |

Failures are recorded in `support.failures` and keep the entry; a disproved practice is evidence for
the next compile to revise, not a row to delete.

## Origins (frozen)

Lowest recall weight first.

| Origin | Means |
|---|---|
| `imported` | A guide read through #143. Recallable, compiled, outranked by an own practice. |
| `experience` | This project's own successful attempts. |
| `correction` | The owner's word, which replaces the practice. Highest weight. |

## Delivery tiers (frozen)

| Tier | Policy | Means |
|---|---|---|
| `recall` | downgradable | May be left out when the caller's budget is tight. |
| `checklist` | mandatory | Its domain is hit by the task, so it is delivered whole — never dropped, never excerpted. |

The policy table is `PROCEDURE_DELIVERY_POLICY`. It is the existing tiered-delivery shape the
surfacing face uses for sensitivity: a frozen table maps a grade to what may happen to it. A
release checklist or a safety procedure is marked `checklist: true` in its descriptor.

## The face (frozen)

| Method | Writes | Does |
|---|---|---|
| `compile` | entry versions + a book receipt | Derive entries from the evidence and append a version per changed entry. Idempotent. |
| `entries` | — | The newest version per entry, one per (domain, key, origin class); `stale` rows are included for review. |
| `recall` | — | Entries matched against the task description and ranked by the frozen score (or by query similarity when an embedding provider is attached); checklist entries whose domain is hit are always returned. |
| `assembleTask` | — | The start-of-work projection: procedures by task plus the owner's preferences on the same task, fitted to `targetTokens` unless a checklist entry says otherwise. |
| `audit` | — | Every procedure row for the project, oldest first. |

Adding a method is an additive change and does not bump the constant. Removing or renaming one does.

## Entry fields (frozen)

| Field | Means |
|---|---|
| `entryId` | Stable id of (project, domain, key, own-or-imported); a version never gets a new one. |
| `domain` | The task domain. |
| `key` | The practice's identity within the domain. |
| `title` | What the practice is for. |
| `steps` | The ordered steps, quoted from the evidence; a correction replaces them. |
| `tools` | The successful attempts' tool choices, in first-use order. |
| `grade` | `tentative` or `established`. |
| `origin` | `imported`, `experience` or `correction`. |
| `delivery` | `recall` or `checklist`. |
| `support` | `{ successes, failures, lastOutcome? }`. |
| `sourceRefs` | The raw events this version was compiled from; never empty. |
| `recordedAt` | When the latest evidence behind this version was recorded — the decay clock. |
| `compiledAt` | When this version was written. |
| `version` | 1 for the first version, +1 per later one. |
| `status` | `current`, `superseded`, `stale` when the claim it was derived from was corrected, or `retired` when a recompile no longer derives the key. |

## Recall ranking

Without an embedding provider, `recall` keeps the v1 rule: an entry is a candidate when its task
text shares a cue with `domain key title steps tools` (or when the task has no cues), and entries
are ordered by the frozen score above. `PROCEDURE_CONTRACT_VERSION = 2` adds one optional lane:

When the host attaches an embedding provider that exposes a synchronous query hook, `recall`
embeds the task and the newest `PROCEDURE_SEMANTIC_POOL` (100) current entries' `domain key title
steps tools` text, plus every cue-matched entry, ranks by cosine similarity, and still puts
mandatory checklist entries first. The frozen score is then the offline ranking, not the online
one. A provider without the synchronous hook falls back to the v1 rule, and a failed embedding
never removes an entry from the lexical path.

## Book events (frozen)

| Type | Written when | Payload |
|---|---|---|
| `PROCEDURE_ENTRY_COMPILED` | A compile derives a value that changed. | `entryId`, `projectId`, `domain`, `key`, `title`, `steps`, `tools`, `grade`, `origin`, `delivery`, `support`, `sourceRefs`, `recordedAt`, `compiledAt`, `version` |
| `PROCEDURE_ENTRY_RETIRED` | A full recompile no longer derives the key. | The same, carrying the value the entry had. |
| `PROCEDURE_BOOK_RECOMPILED` | A compile finishes. | `projectId`, `entries`, `written`, `compiledAt` |

## Correction propagation (#242)

The owner's correction is one act, not a profile-only edit. A `PROFILE_ENTRY_CORRECTED` row names the
value it replaced (`previousValue`) and the evidence that used to support it (`previousSourceRefs`).
On the next `compile`, an entry whose text or source evidence is about that replaced claim and whose
latest evidence is older than the correction is written with `status: stale`. A newer experience
after the correction wins and the entry returns to `current`; the old value is never presented as
current in between.

`entries` and `audit` show the stale row; `recall` and `assembleTask` omit it, so the old steps cannot
be handed to a model as the plan. The stale status is a version in the same ledger, not an edit of
history.

## Recall (frozen)

A recall score is `originWeight × gradeWeight × supportWeight × 2^(-age / PROCEDURE_DECAY_HALF_LIFE_MS)`:
`originWeight` is 3/2/1 for `correction`/`experience`/`imported`, `gradeWeight` is 1 for
`established` and 0.6 for `tentative`, `supportWeight` is `1 + min(successes, 3) × 0.1`, and the
half-life is 90 days. Checklist entries whose domain the task hits sort first and are appended even
when the limit would cut them.

`assembleTask` also reads the owner's preferences through `MemoryKernel.profile`'s own recall — the
preference ledger is not copied into a second book. Preference items are ordinary, downgradable
items; a checklist procedure is not.

## Errors (frozen)

| Code | When |
|---|---|
| `project_id_required` | A call names no project. |
| `procedure_task_required` | A recall or assembly names no task description. |
| `invalid_limit` | A recall limit is not a positive integer. |
| `invalid_target_tokens` | The assembly budget is not a positive integer. |

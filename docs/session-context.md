# Session context contract (v1)

A conversation is a ledger, and the context window is a view of it (#191). The kernel does not
summarise-and-drop when the window fills; it projects the session onto a fixed lane order and a
target bandwidth every turn, and the text it leaves out stays one call away. This face is the
kernel's half of that: the digest, the session recall, and the budget controller. A shell decides
what the pinned, profile and working-set lanes contain.

The code is `src/session/`, reached as `MemoryKernel.sessionContext` and — the host API — as
`KernelAgentMemoryBackend.sessionDigest` / `.recallSession` / `.assembleSessionContext`. It is held
to this document by `__tests__/session-context.contract.test.ts`, which reads the frozen tables
below and fails when code and contract disagree. Version: `SESSION_CONTEXT_CONTRACT_VERSION = 1`.

## The three primitives

1. **Digest.** A turn that slides out of the verbatim tail becomes an entry in a compiled document.
   The mechanical builder is pure rule: it quotes the ledger row and attaches its `sourceRefs`; it
   never calls a model. The deep builder is declared as `SessionDeepCompiler` and runs at the
   DREAMING boundary; no caller wires one this round.
2. **Recall.** The session ledger, paged newest first by time, topic or keyword. The text is the
   row's own text. The scope is the agent's captured session, so another agent's turns never enter
   the page.
3. **Assembly.** One turn's context, fitted to `targetTokens` (the caller reads that number from the
   model configuration; it is not a kernel constant). Lanes are rendered in a fixed order; over
   budget, the lowest-priority lane becomes a pointer to text the caller can still browse. Every
   downgrade is recorded. The unit is the assembler's character-class estimate (#318): ASCII costs
   0.25 token/char and every other code point 0.64, measured against `auto/deepseek-v4.1-flash` on
   the sweet-spot corpus. It is an estimate of provider tokens, not a tokenizer. The old
   `ceil(chars / 4)` 6,000 was ~13,600 provider tokens on that corpus; the built-in route's 10,800
   is the new-unit value that keeps the same measured provider-token budget.
   The digest is a **rotating window** over the newest `SESSION_DIGEST_MAX_TURNS` (512) turns
   (#322), not monotonic growth over the whole session. Older turns leave the per-turn view and stay
   in the ledger: `recall` still pages and searches them. The choice is mechanical rotation rather
   than a model-written summary: it costs no model call on the hot path and keeps the anchor
   discipline by construction. Its price is that a fact older than the window is reached by
   `recall`, not by the digest lane; `SessionDigest.truncated` says when that happened.
   The shell assembles once per turn and reuses the result for the turn's later provider calls:
   only a ledger `global_seq` advance invalidates it, and only the working set's auto-expansion may
   be recomputed from new model text. The recall lane therefore stays present in every call without
   being recomputed (#351).

## What this face does not do

It does not write conversation rows: the write face is `ConversationCaptureService` (#157), and the
digest reads its lane. It does not delete or rewrite a ledger row. It does not call a model on the
hot path. It does not decide when the shell should speak; F6 does that.

## Lanes (frozen)

Rendered in this order, every turn. The priority column is the fill order: higher wins when the
budget is tight. A `stable` lane's rendered bytes are the provider's cache prefix and must not change
between assemblies at the same budget.

| Lane | Priority | Stable | On budget pressure |
|---|---|---|---|
| `pinned` | 60 | yes | trimmed last, item by item; never paraphrased |
| `profile` | 50 | yes | trimmed after the other lanes are pointers |
| `digest` | 10 | no | becomes a browse-only pointer |
| `working_set` | 20 | no | becomes a browse-only pointer |
| `recall` | 45 | no | becomes a browse-only pointer last |
| `tail` | 40 | no | becomes a browse-only pointer |

The render order and the fill order are deliberately different. `tail` renders last because new
turns append there, but it outranks the digest and the working set: the recent verbatim words are
the continuity anchor. `recall` is sacrificed last because it is the lane the product exists for;
the digest is sacrificed first because it only grows. `pinned` and `profile` lead both lists because
they are the prefix a provider can cache.

After the downgrade pass, freed budget is **backfilled** (#316): a lane that became a pointer is
given back its newest items, highest-priority lane first, until the assembly is within `targetTokens`
again. A partly restored lane reports `status: "included"`, keeps the pointer for the items that did
not fit in its text, and records a `trimmed` decision whose `browseIds` name them. The result is a
request that stays near the bandwidth it was given instead of collapsing to the pointer's size.

## Constraints never fold (#255)

A correction, a promise, an intention or a prohibition is never summarised, downgraded or trimmed
out of the context. The kernel marks these items `protected` from markers it already keeps, not from
a word list in the shell:

- a turn named by a `COMMITMENT_OPENED` or `INTENTION_OPENED` row's `sourceRefs`;
- a correction turn: the `PROFILE_ENTRY_CORRECTED` row's `correctionEventId`, and a turn the episode
  classifier linked as `corrects_previous` / `rejects_assistant_proposal`;
- a prohibition the kernel's existing importance classifier rates `permanent` (the same
  `ImportanceSignalDetector` ingestion uses, e.g. 「绝对不能」);
- any item the caller marks `protected: true`, and any id the caller passes in `protectedIds`.

When a lane over budget carries a protected item, the lane is **trimmed to its protected items**
instead of becoming a browse-only stub: the constraint stays verbatim and the lane's other ids stay
in `browseIds`. The decision trace records `action: "trimmed"` for that lane. If the protected items
alone exceed `targetTokens`, they still stay; the target is a bandwidth goal, not a licence to drop
a constraint. A lane with no protected item keeps the ordinary behaviour — the whole lane becomes a
pointer — so the whitelist does not turn folding off.

The pinned lane's first item is the current soul version, read verbatim from `MemoryKernel.soul`
(F17, #194). It is not compiled, paraphrased or trimmed; at one version its bytes are identical from
one assembly to the next, and a saved version is effective on the next turn. The soul's own contract
is [docs/soul-storage.md](soul-storage.md); this face only consumes its read side.

The recall lane renders inside the same `<COGMEM_RECALL_CONTEXT>` envelope as the host recall
block, under the `[recall]` header. Each item keeps the kernel's `anchorEvent` (`evt-…`),
`sourceLocator` and `whyMatched` fields, so the model can drill down to the ledger row instead of
repeating a summary. An item with no resolvable event id prints no key rather than a fabricated one.

A lane downgraded to its browse-only pointer renders the same `evt-…` keys for the ids it left
behind, one `anchorEvent=` line each, so `read mem:<eventId>` still resolves the text when the lane
itself no longer fits. The key list keeps the newest 20 — the trace's existing limit — and the
header keeps the lane's full item count. A lane-local id is resolved through the item's own
`anchorEvent` or `sourceRefs` first: `procedure:<entryId>` prints its ledger row's key, while an
`assignment:` or `wake:` item that carries no ledger row prints none rather than a fabricated one.

## Auto-expansion (#253)

A recall item is a **stub** when it carries `originalText` — the ledger text the model does not see
because `text` is a compiled projection of it. When the request's own words name the stub, the
assembly expands that original into `working_set` before the provider call. This is a cost
optimisation (it removes a drill-down round trip), not a correctness fallback: the stub and its key
stay in the recall lane either way, and nothing is written to the ledger.

The match is deterministic and reads only what the stub itself carries:

- its keys: `anchorEvent`, `sourceLocator`, and every `sourceRefs` entry (`evt-…`);
- its entity words: the kernel's verbatim anchors (`digestAnchors`) — quoted spans, numbers with a
  separator or several digits, and names introduced by 叫/名叫/名字是 — at least two characters
  long.

Both sides are normalized the way the fold/drill experiment normalized them (#254): NFKC,
lower-case, no whitespace. No keyword list is kept: the anchor shapes are content-bearing on their
own, so no stopword list is needed either. A single digit is dropped by the length floor, and a
quoted span matches only as a whole, so an ordinary word that grazes it does not fire.

The trigger is `recentText`: the newest user message plus the latest model output the request
carries. An original already rendered in another lane is not expanded again, and a `protected` item
is never expanded — a constraint is already verbatim in its lane (#255).

An expansion is an ordinary `working_set` item, so the lane's budget and downgrade semantics apply.
It is the first thing the controller gives back when the lane is over budget: the expansion is
trimmed before an open loop or a protected item can leave the lane, and the trimmed stub's id stays
in `browseIds`. `SessionContextAssembly.autoExpanded` lists the stub ids that survived into the
request — the count is its length — and the shell carries it into the `context_assembled` trace
(#268 reads it).

## The practice lane at task start (#261)

While an assignment is open, the shell asks the procedure book for practices recalled by that
assignment's own text and adds them to `working_set` as `procedure:<entryId>` items. This is the
same `assembleTaskProcedures` read the book publishes, so an attached embedding provider is the
recall path; the lane does not add a lexical matcher of its own. A `checklist` entry is delivered
whole and marked `protected`, which is what makes it non-downgradable under budget; a `recall` entry
is an ordinary item and the lane's fold rule may replace it with its id in `browseIds`. The items
carry the entry's ledger `sourceRefs` and `anchorEvent`, so `read mem:<eventId>` opens the evidence.
The lane ends with the assignment at an explicit task end (#263); the book's producer is
[docs/procedure-compilation.md](procedure-compilation.md).

## Task-exit stubs (#263)

An explicit task end (`declare_task` with `action: "end"`, #246) is the only exit signal. Without
that declaration the `working_set` lane is unchanged: a new user line still attaches to the open
assignment by default.

At the end, the task's working-set material leaves the lane and the digest lane gains one **task
stub**. The stub is a `SessionDigestEntry` built by the caller from the task's own ledger rows and
passed to `assembleSessionContext` as `digestStubs`; it is never written by a model. Its `text` is
the first non-empty line of each quoted row, cut to a bounded prefix, joined with fixed labels (the
task's opening user line, the last conclusion before the end run, and the end run's closing line),
its `sourceRefs` are those rows, and its `entryId` is `digest:<primary eventId>`. The primary row is
the conclusion, so `read mem:<eventId>` opens the words that say what was done; the quoted rows are
the anchor list.
The digest lane renders the stub's `anchorEvent=<eventId>` line, so the key is visible without
turning the lane into a browse-only pointer.

The stub is a lane-level exit, not a fold. A fold replaces an item inside a lane with a pointer
(C2); this removes the task's working-set material and leaves the stub in a different lane. The two
mechanisms are not substitutes.

Constraints survive the exit (#255). A working-set item the kernel marked `protected` — the open
assignment's text when the kernel's permanent-importance classifier rates it a prohibition, or any
item the caller marked — stays in `working_set` verbatim. A stub whose quoted text contains such a
constraint is itself marked `protected` by the same rule, so budget pressure trims around it rather
than folding it.

## The whole request (#319)

The six lanes fit the material the assembler builds; they do not see the tool results the model
appends afterwards. Those results are part of the request the provider is charged for, so the agent
loop fits them at the request boundary: the whole request is bounded to the route's target, and
inside it tool output may take at most `TOOL_OUTPUT_TOKEN_LIMIT` (4,000 in the character-class unit),
one result at most `TOOL_RESULT_TOKEN_LIMIT` (2,000), and the newest results are kept first when both caps cannot be
met. An oversized result keeps its head and gains a deterministic stub naming the original length and
its `read` key when the call has one (`mem:<eventId>`, a workspace path, or the bash output file);
older results collapse to that stub. The transcript and the append-only projection log keep the full
text: this is a request re-assembly, not deletion and not a second fold mechanism.

`context_assembled` reports `totalTokens`, `toolOutputTokens` and the `toolOutput` account separately;
`/context` prints the tool-output line and the stated whole-request budget beside the lane budget.

## Digest entry fields (frozen)

| Field | Means |
|---|---|
| `entryId` | Stable id derived from the ledger event (`digest:<eventId>`). |
| `kind` | `turn` for the mechanical builder; `deep` is reserved for the DREAMING compiler. |
| `sessionId` | The session the entry belongs to. |
| `occurredAt` | The turn's instant, from the ledger. |
| `speaker` | One of the frozen conversation speakers. |
| `text` | The ledger row's exact text. Never a summary, never a re-rendering. |
| `sourceRefs` | The ledger event id(s) the entry quotes. |
| `anchor` | True when `text` contains a number, a quoted span or a named person. |

## Verbatim anchors

A decision, a number or a name may appear in the digest only as the exact text the ledger holds.
The mechanical builder satisfies this by construction: `text` is the row's text, not a rewrite.
`digestAnchors(text)` names the risky fragments (numbers with separators, quoted spans, and a person
introduced by 叫/名叫/名字是) so a reader and the contract test can compare them against the source
turn. A deep entry that paraphrases an anchor is a contract violation, not a quality preference.

## Recall modes (frozen)

| Mode | Filter | Notes |
|---|---|---|
| `time` | none | The cursor is the only filter; newest first. |
| `topic` | the session's episode `topic_path` contains the query | The episode index is the topic index. |
| `keyword` | the row's text contains the query, case-insensitively | Substring, not FTS: the acceptance is a literal word, including CJK. |

A page is at most 200 items; the default is 20. `nextCursor` is opaque to the caller and absent on
the last page. `sourceRefs` on every item is its ledger event id.

## Decision trace fields (frozen)

One entry per lane the controller changed. The returned array is authoritative; the kernel also
appends a `session.context.assemble` row to `trace_events` when the array is non-empty, so the
decision is readable after the turn.

| Field | Means |
|---|---|
| `lane` | The lane that changed. |
| `action` | `downgraded` (text replaced by a pointer) or `trimmed` (an item removed). |
| `reason` | Always `budget_exceeded` this round. |
| `tokensBefore` | The lane's estimate before the change. |
| `tokensAfter` | The lane's estimate after the change. |
| `omittedItems` | How many items left the lane. |
| `browseIds` | The ids the caller can still fetch (bounded to 20 in the trace row). |

## Errors (frozen)

| Code | When |
|---|---|
| `project_id_required` | The call names no project. |
| `agent_id_required` | The call names no identity. |
| `session_id_required` | The call names no session. |
| `invalid_recall_mode` | The mode is not one of the frozen three; the message names the set. |
| `recall_query_required` | `topic` or `keyword` was asked without a query. |
| `invalid_limit` | A page limit that is not a positive integer. |
| `invalid_cursor` | A cursor that is not the `occurredAt:globalSeq` pair this face issued. |
| `invalid_target_tokens` | The target bandwidth is not a positive integer. |
| `invalid_tail_turns` | The verbatim tail size is not a non-negative integer. |

## The kill-side acceptance

The ledger survives a process kill; the in-memory context does not. Waking up means rebuilding the
view, not replaying the transcript: the digest locates the session, `recall` walks back to the exact
words, and the assembly puts the pinned/profile/working-set/open-loop material back around them.
The acceptance is that the rebuilt context can answer three questions — what we were doing, where we
were stuck, what comes next — with `sourceRefs` a reader can check. The F2 wake intentions and F6
candidates that were pending at the kill are re-read from their own services and enter the
`working_set` lane as open loops. F16's commitment book is compiled each tick (#193); its due
promises arrive through the surfacing path, not the `working_set` lane.

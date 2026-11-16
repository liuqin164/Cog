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
   downgrade is recorded. The unit is the assembler's own `ceil(chars / 4)` estimate, not the
   provider's token count; #258 measured about 2.2 provider tokens per unit on a Chinese corpus.
   The built-in route's 6,000 is provisional pending that curve's review.

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
| `digest` | 30 | no | becomes a browse-only pointer |
| `working_set` | 20 | no | becomes a browse-only pointer |
| `recall` | 10 | no | becomes a browse-only pointer |
| `tail` | 40 | no | becomes a browse-only pointer |

The render order and the fill order are deliberately different. `tail` renders last because new
turns append there, but it outranks the digest and the recall lane: the recent verbatim words are
the continuity anchor. `pinned` and `profile` lead both lists because they are the prefix a provider
can cache.

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
itself no longer fits. The key list is bounded to 20 — the trace's existing limit — and the header
keeps the lane's full item count.

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
`working_set` lane as open loops. The F16 commitment ledger is not landed; the open-loop port is the
place it will enter.

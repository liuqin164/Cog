# Fold drill-down experiment (#254 B4)

One command from the repository root:

```bash
bun eval/fold-drill/run.ts
```

It runs the same 24 tasks through three arms on the mg route
`auto/deepseek-v4.1-flash` and writes `results.md` / `results.json` next to
this file. `--dry-run` validates the corpus and prints its shape without
calling the model; `--report-only` re-renders `results.md` from an existing
`results.json`; `--limit N` runs a prefix for a smoke test; `--model`,
`--base-url` and `--out-dir` are the other knobs. `MG_BASE_URL`, `MG_API_KEY`
and `MG_MODEL` are read from the environment.

The gateway must be up (`GET /models` at `127.0.0.1:3425/v1` by default). No
scratch tree, model cache or database is written; the per-call trace is kept in
`results.json`.

## Corpus

`corpus.ts` holds 24 tasks, six of each detail type: number, name, constraint
and step. Every task plants one target detail early (turn 2), two same-type
distractors at turns 11 and 20, and asks for the target after 24 turns. The
question and the target detail are one-to-one; the two distractors make a blind
pick a 1-in-3 guess.

The 19/5 auto-expansion split is deliberate: 19 questions name a stub entity
term and expand deterministically; five refer to the detail by the task's
setting or a pronoun, so the deterministic rule does not fire. The split is what
tests the auto-expansion trigger, not just the expansion itself.

Filler selection is `SHA-256(task.id)` and the task order is fixed. There is no
RNG and the model is called with `temperature: 0`.

## Stubs and drill action

A folded detail uses the kernel `SessionDigest` shape: `entryId` is the key, the
text is an exact prefix quote of the ledger turn, and `sourceRefs` points at the
turn. The value is only in the omitted suffix. For example:

```
- digest:f01-t02 · sourceRefs: f01-t02 · 原文引文：“关于上传失败的处理，团队最终定下的重试上限是…”
```

The folded arms expose one tool, `read_memory({ key })`; its result is the
original ledger turn. Every model call, tool call, key and target hit is in the
trace. The auto arm expands a stub into an `<auto-expanded>` block when the
question contains the stub's key or one of its entity terms.

## Scoring

The model is told to end with one line, `答案：<value>`. Correctness reads that
line: a number must equal the expected number, otherwise all token groups in
`checks` must hit (allowing the listed synonyms).

Hallucination is the fixed ticket rule: a detail value in the answer that does
not occur anywhere in the task ledger. The checker extracts numbers, names from
the corpus name pool, day/time tokens, and step action families (for step
tasks). It does not see Chinese numerals (`三次`) or names outside the pool; that
limit is stated in `results.md`.

## Arms

- `full` — the whole transcript, no tools.
- `folded_key` — the three detail turns become digest stubs; the model may call
  `read_memory`.
- `folded_auto` — the same folded context, plus the deterministic expansion
  described above; unexpanded stubs remain readable.

## What it does not do

No product code is touched, no kernel row is written and no live database is
opened. The stub is an exact-prefix quote, not a model-written summary, so the
zero-hallucination result does not validate summary stubs. The corpus is
synthetic and small; at three stubs and ~1k characters the folded arm can cost
more billed prompt tokens than the full transcript, which is a warning about
selectivity, not a long-context cost model. Cache economics and the context
sweet spot belong to #259 and #258.

## Back-reference family (#472)

`bun eval/fold-drill/backref.ts` runs the deterministic kernel only: four
next-day follow-ups (昨天/上次/后来/刚才) are asked twice, once against an empty
project and once against a seeded prior turn. It prints the two counts and fails
unless every with-context probe hits and every without-context probe misses.

## #294: real scale and the fold-enable threshold (2026-11-17)

`--corpus real` reruns the three-arm design at the scale #294 names: eight
tasks, **246 turns and six tool outputs of ~9k characters each** (≈2.5k provider
tokens per output, 58.6k characters per task). Each output is a config dump from
a near-identically named service; only one carries the target value, and the
stub is the dump's first line, which names the service but not the value.

Two commands:

```bash
bun eval/fold-drill/run.ts --corpus real --arms full,folded_key --out-dir eval/fold-drill/real
bun eval/fold-drill/run.ts --corpus sweep --arms full,folded_key --out-dir eval/fold-drill/real/sweep
```

`full` carries the whole transcript in one call; `folded_key` folds all six tool
outputs to digest stubs and lets the model drill (the drill returns the whole
output). At this scale:

| arm | correct | hallucinated | avg prompt tokens | avg model calls | avg tool calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| full | 8/8 | 0 | 30,140 | 1.00 | 0.00 |
| folded_key | 8/8 | 0 | 27,989 | 2.00 | 3.75 |

Folding saved **7.1%** of prompt tokens and cost nothing in accuracy. It saved
so little because the model read 3.75 of the 6 blocks: every drill returns a
whole ~2.5k-token output, and every round re-bills the growing context. That is
the real behaviour of "fold the transcript, drill the original", not a summary
stub.

The sweep grows one task from 1 to 16 folded outputs (240 turns each):

| folded blocks | full prompt tokens | folded prompt tokens | drills | delta |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 9,667 | 16,127 | 1 | +67% |
| 2 | 13,762 | 20,409 | 2 | +48% |
| 4 | 21,952 | 28,848 | 4 | +31% |
| 8 | 38,338 | 25,145 | 3 | −34% |
| 16 | 71,114 | 25,861 | 3 | −64% |

**Fold-enable threshold: fold only when the transcript would exceed ~30,000
provider prompt tokens** (the measured crossover sits between 22k at 4 blocks
and 38k at 8). Below it, the stub, the extra round and the drilled original cost
31–67% more than simply carrying the transcript; above it, the folded prompt
stays roughly flat because only the needed blocks are read. Accuracy was 100%
in both arms at every size, so this is a cost/capacity threshold, not a
correctness one — consistent with #256's ruling that folding is a capacity
measure, not a money saver.

Bound: one model, one sample per cell, synthetic corpora. At 16 outputs
(152k characters, ~71k provider tokens) the full transcript still fits the
model's 1M window, so this sweep locates the *cost* crossover, not the point
where the context stops fitting. Cache economics are #259's.

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

# Associative recall (#355)

Does a memory come back when the cue never names it? This measures that on synthetic
work/life facts, against naive vector top-k on the same corpus and the same `k`.

## Run

```bash
# local bge cache: .cogmem/assoc/models/Xenova/bge-base-zh-v1.5
bun eval/associative/run.ts

# LongMemEval, deterministic sample
bun eval/associative/longmemeval.ts \
  --data /path/to/longmemeval_s_cleaned.json --limit 20 --k 5
```

`run.ts` writes `results.json` / `results.md`; `longmemeval.ts` writes
`longmemeval-results.json` / `longmemeval-results.md`. `--out-dir`, `--cache-dir`,
`--keep` are the other knobs.

## Corpus

`corpus.ts` has 40 synthetic facts: 16 targets and 24 distractors. There are 24
cues: 16 positive (the target should be recalled) and 8 negative (nothing in the
corpus is relevant). Every positive cue is checked at startup: it must not contain
any of the target's `forbidden` key terms, and each forbidden term must occur in
the target text.

Each cue runs against a fresh copy of the seeded database, so a previous cue
cannot be recalled as context. The seed order is a fixed SHA-256 shuffle.

## Arms

- **companion** — a real `CompanionShell` with the local `Xenova/bge-base-zh-v1.5`
  provider. Facts are written through `backend.rememberTurnWithResult()` and the cue
  is sent through `shell.submit()`. The arm reads the
  `<COGMEM_RECALL_CONTEXT>` block that the session-context plugin assembles into the
  model request, not a direct vector-store call.
- **vector top-k** — the same fact texts embedded with the same model (`embedBatch`,
  no query prefix), the cue embedded with the model's retrieval prefix, cosine
  ranking, `k = 3` (the shell's default recall limit).

## Metrics

- **hit rate** — positive cues whose target is in the produced list.
- **precision** — relevant returned items / all returned items. Only the scenario's
  designated target counts as relevant.
- **false-positive ratio** — mean over all cues of (returned items that are not the
  target) / returned items. A negative cue's every returned item is a false positive.
- **negative surfaced** — negative cues that returned at least one item.
- **tokens/cue** — `sessionTokens()` of the returned memory texts joined by newlines,
  excluding the lane envelope and instructions.
- **latency** — companion: `submit()` start to the model request carrying the
  assembled lane; vector: query embedding plus cosine ranking. p50/p95 across cues.

## LongMemEval

The adapter ingests each haystack session as one ledger event in a fresh project,
recalls `k = 5` sessions with `KernelAgentMemoryBackend.recall()`, and (unless
`--no-answer`) asks the shell's configured model route (`auto/deepseek-v4.1-flash`
by default) to answer from the recalled text. The judge prompt is the official
LongMemEval `evaluate_qa.py` prompt for each question type, asked through the same
route; the observed routed model is recorded in the JSON. Sampling is deterministic:
sort by `question_id`, take every `floor(n / limit)`-th question.

Dataset: `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`
(`longmemeval_s_cleaned.json`). The adapter is session-level, not the official
full-history long-context harness, so its accuracy is not comparable to published
LongMemEval long-context numbers. Retrieval is measured at session granularity
against `answer_session_ids`.

## Limits

Synthetic Chinese facts, 40 memories, 24 cues; a first measurement, not a general
retrieval benchmark. The vector arm is deliberately naive (cosine, no rerank, no
recency). The companion arm measured the assembled turn lane, not whether the model
then chose to mention the item in its reply.

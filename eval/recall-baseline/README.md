# Recall baseline (#250 A6)

One command, from the repository root:

```bash
bun eval/recall-baseline/run.ts
```

It writes a fresh scratch kernel, measures the same 30 paraphrase queries through
three arms, and writes `results.md` / `results.json` next to this file. `--keep`
leaves the scratch database under `.cogmem/recall-baseline/run-*`; `--out-dir`,
`--model` and `--cache-dir` are the other knobs. `--keep` is only for inspecting
a run; the default removes the scratch tree.

The #343 ablation reuses this corpus to measure the legacy compiled lane on and off:
`bun eval/recall-ablation/run.ts` (see `eval/recall-ablation/README.md`).

## Corpus

`corpus.ts` holds 20 memory targets and 10 practice targets, each with a Chinese
rewrite. The rewrite must be a real paraphrase: `keyTerms` are the words a
literal matcher would use, and `run.ts` refuses to run if any of them appears in
the query or is missing from the target.

The split is 20/10 because `ProcedureCompiler.recall` caps a page at
`PROCEDURE_RECALL_MAX` (10); a larger procedure pool could not be ranked end to
end. The 10-item procedure pool means a random ranker already gets 10% at rank 1
and 50% at top 5; the report prints those chance levels beside the table.

Memory seeds are written through `KernelAgentMemoryBackend.rememberTurn()` and
practice seeds through `KernelMemory.recordTaskEvent()` + `procedures.compile()`.
No SQL inserts the corpus. The write order is a fixed SHA-256 shuffle, so recency
is not aligned with the query list. The rule-only write path deduplicates by
cosine on its deterministic embedding, so `run.ts` also checks that no pair of
memory targets reaches the 0.98 threshold (and that each turn produced a distinct
neuron id).

## Arms

- `rule_only` — the real shell path: `KernelAgentMemoryBackend.recall()` for
  memories and `ProcedureCompiler.recall()` for practices. No model is
  configured, so `semanticIndex` is false.
- `fts_trigram` — SQLite FTS5 `tokenize='trigram'` over the same target texts.
  The query is an OR of its character trigrams, ranked by `bm25()`. It is not a
  phrase query: a phrase would require the whole paraphrase to appear contiguously.
- `embedding` — local vectors, cosine rank. The model is
  `Xenova/bge-base-zh-v1.5` (the ONNX port of `BAAI/bge-base-zh-v1.5`), 102M
  parameters, 768 dimensions, quantized ONNX. Queries get the model card's
  instruction prefix `为这个句子生成表示以用于检索相关文章：`; documents are
  embedded as written.

All arms index the same text: the user statement for memories, and
`domain key title steps tools` for practices (the text the procedure compiler
itself searches).

## Embedding model and memory

The model is downloaded once from
`https://huggingface.co/Xenova/bge-base-zh-v1.5` into
`.cogmem/recall-baseline/models/` (gitignored). The quantized file is
`model_quantized.onnx`, about 98 MiB; the whole cache is about 99 MiB.

The embedding arm runs in its own process, because the point includes its
resident set. The child is bounded twice: `ulimit -v 16 GiB` for address space
(8 GiB intermittently failed to initialize the ONNX backend in this environment)
and a 2 GiB RSS watchdog polled by the parent. It reports RSS at four
checkpoints and peak RSS from `/proc/self/status` (`VmHWM`). The measured peak on
this corpus is in `results.md`.

## What it does not do

No product code is touched and no embedding is wired into recall. The memory arm
is called with `limit: 20` to expose ranks beyond the shell's default `limit: 3`;
the procedure arm cannot exceed 10. The corpus is synthetic and small; it is a
baseline for the paraphrase failure mode, not a general retrieval benchmark.

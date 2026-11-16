# Cache economics of fold strategies (#259 C4)

One command from the repository root:

```bash
bun eval/cache-econ/run.ts
```

It runs four synthetic working sessions through three projection arms on the
current model route and writes `results.md` / `results.json` next to this file.
`--dry-run` prints the corpus shape and the fold schedule without calling the
model; `--report-only` re-renders `results.md` from an existing `results.json`;
`--sessions N`, `--window N`, `--batch N`, `--model`, `--base-url` and
`--out-dir` are the knobs. `MG_BASE_URL`, `MG_API_KEY` and `MG_MODEL` are read
from the environment.

## Arms

- `no_fold` — the whole ledger is resent each turn.
- `per_turn` — every turn folds one more pair older than the window into the
  digest, so the digest message changes every turn.
- `boundary` — old pairs are folded in one batch only when the completed-pair
  count reaches a batch boundary, so the digest is stable between boundaries.

The last `window` pairs stay verbatim in the folded arms. The digest is one
user message at the front of the projection, followed by the recent pairs. That
is deliberate: a changed digest invalidates every prompt token after it, which
is the cost the experiment is measuring.

## Corpus

Four sessions, one per detail type (number, name, constraint, step). Each is 23
user/assistant pairs plus a final question. The target detail is in pair 2, two
same-type distractors are in pairs 12 and 21, and the rest are filler
paragraphs built from the #254 filler pool. The no-fold projection at the final
question is about 24k characters, the C3 provisional 6,000 shell tokens; the
provider's count is roughly 13k prompt tokens. The assistant replies are
scripted and identical across arms, so only the projection differs.

The fold stub is the kernel `SessionDigest` shape: entryId (key), an exact
prefix quote of the pair's user turn, and sourceRefs. The value is only in the
omitted suffix. Folded arms expose `read_memory`; the final answer is scored by
the #254 checker.

## Cost

The gateway's `/v1/models` pricing is read at run time. Each call's prompt is
split by the provider's own report: `prompt_tokens_details.cached_tokens`,
`prompt_cache_hit_tokens` or `cached_tokens` is the cache hit; the rest is the
miss. Cost is `miss × prompt price + hit × cache-read price + completion ×
completion price`. A provider that reports no cache field is recorded as
all-miss, never as zero cost.

## What it does not measure

The ledger is a replay: the model's replay replies are discarded and the
scripted replies are what the next turn sees. A live agent appends its own
replies, which changes the prefix and can change cache behaviour. The digest is
append-only and deterministic; a fold that rewrites the digest each turn would
invalidate more prefix than `per_turn` does here. One model route and four
synthetic sessions make this a direction and a mechanism, not a universal price
list.

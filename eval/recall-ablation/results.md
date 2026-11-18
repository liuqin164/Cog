# Recall ablation — #343

- base commit at run: `eeff6b96`
- run at: 2026-11-18T20:58:11.367Z
- bun: 1.3.14 · linux/arm64

## Protocol

- Corpus: `eval/recall-baseline/corpus.ts` — 20 memory targets and 10 practice targets.
- Memory seeds are written through `KernelAgentMemoryBackend.rememberTurnWithResult()`; practice seeds through `MemoryKernel.recordTaskEvent()` + `procedures.compile()`. No SQL inserts the corpus.
- After #343 every arm measures the same raw-ledger + Atlas + binding-graph path. `raw_atlas` states those two lanes, `raw_atlas_compiled` states them explicitly with the retired token, and `all_current` omits the policy.
- Each arm is warmed once, then measured over 5 passes of all 30 queries. Ranks are asserted stable across passes.
- No product code is changed. The scratch database and temporary files live under `.cogmem/`, which is gitignored.

## Results

| arm | memory @1 (n=20) | memory @5 | procedure @1 (n=10) | procedure @5 | all @1 (n=30) | all @5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all_current | 30.0% | 40.0% | 20.0% | 20.0% | 26.7% | 33.3% |
| raw_atlas_compiled | 30.0% | 40.0% | 20.0% | 20.0% | 26.7% | 33.3% |
| raw_atlas | 30.0% | 40.0% | 20.0% | 20.0% | 26.7% | 33.3% |

## Latency

| arm | recall p50 | recall p95 | samples | procedure p50 | procedure p95 | samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all_current | 20.59 ms | 75.91 ms | 100 | 0.70 ms | 8.96 ms | 50 |
| raw_atlas_compiled | 15.14 ms | 25.09 ms | 100 | 0.62 ms | 0.88 ms | 50 |
| raw_atlas | 14.65 ms | 22.65 ms | 100 | 0.58 ms | 0.70 ms | 50 |

## Write cost

- per-turn write p50: 10.2 ms · p95: 49.9 ms · n=20
- ledger rows by type (memory project):

| event type | rows |
| --- | ---: |
| BELIEF_UPSERTED | 1 |
| RAW_EVENT_RECORDED | 20 |

## Lane evidence

| arm | recallMode (queries) |
| --- | --- |
| all_current | raw_ledger_fallback × 120 |
| raw_atlas_compiled | raw_ledger_fallback × 120 |
| raw_atlas | raw_ledger_fallback × 120 |

## Controls

- `raw_atlas_compiled` ranks equal `all_current`: yes.
- Profile entries compiled from this corpus: 0. The lane-policy arm also disables profile (`withProfileItems` is gated by `compiled`), so a zero makes that confound measurable rather than assumed.

## Reading

- The compiled lane was deleted (#343), so the arms differ only by policy spelling; all-corpus recall@5 moved +0.0 points (33.3% → 33.3%).
- The deletion was decided by Ryu in #343; this run is the post-deletion regression measurement.

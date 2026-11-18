# Recall ablation — #343

- base commit at run: `eb7d61e5`
- run at: 2026-11-18T01:44:55.788Z
- bun: 1.3.14 · linux/arm64

## Protocol

- Corpus: `eval/recall-baseline/corpus.ts` — 20 memory targets and 10 practice targets.
- Memory seeds are written through `KernelAgentMemoryBackend.rememberTurnWithResult()`; practice seeds through `MemoryKernel.recordTaskEvent()` + `procedures.compile()`. No SQL inserts the corpus.
- `raw_atlas` uses `retrievalPolicy.allowedLanes = [graph, raw_source]`; `raw_atlas_compiled` states all three lanes; `all_current` omits the policy, which is the current `recall()` path.
- Each arm is warmed once, then measured over 5 passes of all 30 queries. Ranks are asserted stable across passes.
- No product code is changed. The scratch database and temporary files live under `.cogmem/`, which is gitignored.

## Results

| arm | memory @1 (n=20) | memory @5 | procedure @1 (n=10) | procedure @5 | all @1 (n=30) | all @5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all_current | 10.0% | 30.0% | 20.0% | 20.0% | 13.3% | 26.7% |
| raw_atlas_compiled | 10.0% | 30.0% | 20.0% | 20.0% | 13.3% | 26.7% |
| raw_atlas | 30.0% | 40.0% | 20.0% | 20.0% | 26.7% | 33.3% |

## Latency

| arm | recall p50 | recall p95 | samples | procedure p50 | procedure p95 | samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all_current | 119.61 ms | 181.87 ms | 100 | 0.63 ms | 0.80 ms | 50 |
| raw_atlas_compiled | 128.17 ms | 189.06 ms | 100 | 0.60 ms | 0.90 ms | 50 |
| raw_atlas | 21.52 ms | 60.72 ms | 100 | 0.61 ms | 0.90 ms | 50 |

## Write cost

- per-turn write p50: 56.8 ms · p95: 86.3 ms · n=20
- ledger rows by type (memory project):

| event type | rows |
| --- | ---: |
| BELIEF_UPSERTED | 1 |
| COGNITIVE_GRAPH_COMPILED | 20 |
| INGESTED | 20 |
| RAW_EVENT_RECORDED | 20 |
| TOPOLOGY_COMPILED | 20 |

## Lane evidence

| arm | recallMode (queries) |
| --- | --- |
| all_current | universe_navigation × 120 |
| raw_atlas_compiled | universe_navigation × 120 |
| raw_atlas | raw_ledger_fallback × 120 |

## Controls

- `raw_atlas_compiled` ranks equal `all_current`: yes.
- Profile entries compiled from this corpus: 0. The lane-policy arm also disables profile (`withProfileItems` is gated by `compiled`), so a zero makes that confound measurable rather than assumed.

## Reading

- Turning the compiled lane off moved all-corpus recall@5 by +6.7 points (26.7% → 33.3%).
- This is a measurement, not a keep/delete decision. The decision belongs to Ryu in #343 after these numbers land.

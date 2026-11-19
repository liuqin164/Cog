# Recall ablation — #343

One command, from the repository root:

```bash
bun eval/recall-ablation/run.ts
```

It writes `results.md` / `results.json` next to this file. `--keep` leaves the scratch database
under `.cogmem/recall-ablation/run-*`; `--out-dir` writes the report elsewhere. The corpus is the
same 30 paraphrase tasks as `eval/recall-baseline/` (20 memory, 10 practice), and no product code
is changed.

## Arms

| arm | lanes | what it is |
| --- | --- | --- |
| `raw_atlas` | `graph` + `raw_source` | raw ledger, Atlas and the binding graph |
| `raw_atlas_compiled` | the same lanes stated explicitly | retirement check: a capsule that still names `compiled` must not revive a second lane |
| `all_current` | no policy | exactly what `KernelAgentMemoryBackend.recall()` does today |

After #343 the compiled neuron/topology/cognitive-graph lane no longer exists. The switch is still
the product's own `retrievalPolicy.allowedLanes`, the same field a strategy capsule sets;
`raw_atlas_compiled` must produce the same ranks as `all_current`, and the script fails if it does
not.

## What the run measures

- recall@1 and recall@5 for memory, practice and the combined 30-item corpus;
- p50/p95 latency per recall over five measured passes, after one warm-up pass;
- per-turn write p50/p95 and the ledger rows by event type (the triple write is visible there);
- the `recallMode` distribution per arm, so a reader can see which lane answered.

## Caveats

- The corpus is synthetic and small. It measures the paraphrase failure mode, not general retrieval.
- The lane policy gates `withProfileItems` on `compiled` as well, so `raw_atlas` also turns off the
  profile lane. The script reports the number of profile entries compiled from this corpus (0), so
  the confound is measured rather than assumed.
- Latency is this machine's; compare arms within one run, not across machines.
- This is a measurement, not a keep/delete decision. That decision belongs to Ryu in #343.

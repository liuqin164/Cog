# Compile-window miss evaluation — #381

One command from the repository root:

```bash
TMPDIR="$PWD/.cogmem/tmp" bun eval/window-miss/run.ts
```

It writes `results.md` / `results.json` next to this file. `--base-url`, `--model`, `--ledger`,
`--only <probe substring>`, `--out-dir`, `--keep` and `--report-only` are the knobs.
`MG_BASE_URL`, `MG_API_KEY` and `MG_MODEL` are read from the environment.

## Question

The Dream curator sees one fixed episode window: the raw events linked to one sealed episode,
each truncated to 1,200 characters, with no tools and no lookups. Cross-episode deduplication,
conflict resolution and procedure lessons need both halves of a relation. This eval measures how
much of the miss is caused by the window and how much is the model not detecting a relation that
is already visible.

## Arms

- **window** — each probe window is sent to the real `MemoryKernel.runDreamCurator` candidate path
  separately, with `dreamMode: 'normal'`, then all candidates are governed with
  `promoteDreamCandidates()`.
- **wide** — the same events from every window of that probe are sent in one curator call, with
  the same model route, prompt, mode and governance. Only visibility changes.

No frame is regenerated. The thing under test is the candidate/conflict/dedupe layer; frames are
episode-local by construction.

## Probes

`corpus.ts` has eight scorecard probes and two ledger probes.

- Four duplicate probes repeat the same scorecard statement in two windows.
- Four conflict probes put the old value in one window and the new value in another. Three take the
  old value from `eval/dream-scorecard/corpus.ts`; the new value is a one-line update.
- One ledger duplicate probe replays the same Pi-plugin request from two archived companion
  episodes.
- One ledger procedure probe puts the installation attempt, the environment-variable root cause
  and the native-only decision in three different episodes.

The real ledger is the archived companion ledger at
`~/.cogmem/companion-archive-20261116/memory.sqlite`, opened read-only. No live process or live
data directory is touched. `WINDOW_MISS_LEDGER` or `--ledger` points at another copy.

## Scoring

Each expectation names candidate types and gold term groups. A candidate or final durable row
hits when every group has at least one term. A conflict hit must also carry evidence from at least
two windows, unless a final summary row names both values.

For duplicates, the count is surviving durable rows (beliefs/facts) when governance produced any,
otherwise matching candidates. More than one surviving copy is a miss.

Each expectation is one of:

- **handled** — the window arm already finds it.
- **window_miss** — the window arm misses it and the wide arm finds it.
- **model_miss** — the wide arm misses it too; full visibility did not help.

The decision rule is written into the code and report before the run:
**Conclusion B when window-caused misses are at least 2 and at least 20% of evaluated items.**
Otherwise Conclusion A.

## Bounds

- One sample per cell on `auto/deepseek-v4.1-flash`; output is stochastic.
- The scorecard probes are synthetic and small; the ledger is one companion session with five
  episodes. This is a mechanism measurement, not a population estimate.
- The ledger replay records raw events into a fresh kernel instead of reopening the archived
  episode tables. Curator input, model route, prompt and governance are real; frame generation and
  episode assembly are not exercised.

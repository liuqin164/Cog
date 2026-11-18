# Continuity scorecard — #346

One command, from the repository root:

```bash
bun eval/continuity/run.ts
```

It drives the real `CompanionShell` through `shell/test/helpers.ts` (`makeShell` +
`ScriptedProvider`) and writes `results.md` / `results.json` next to this file. No real model is
called. The default exits non-zero when a scenario fails; `--report-only` exits 0 for a baseline
run, `--keep` leaves the temp directories.

## Scenarios

| scenario | what it measures | maps to |
| --- | --- | --- |
| 30-day long session | 600 turns (30 days x 20), every request within the 6,000-token target, recall lane present in at least 90% of turns | #316 |
| forget | a seeded fact is recallable, `/forget` empties recall and leaves zero hits in every file under the data directory | #332 / #331 |
| night catch-up | process asleep across 02:00-05:00, restarted at 06:00: one Dream, one `dream_catchup` trace, one snapshot | #327 |
| emergence feedback | one due promise surfaces once; after three ignored surfacings the fourth waits or is suppressed | #330 |
| budget pause and resume | a work run stops at the cage, `/continue` resumes the same assignment from its checkpointed stop | #228 |
| SIGKILL recovery | a real SIGKILL during a run; the next process still has the open assignment and away queue | #331 |

## Baseline (unfixed head, 2026-11-18)

`results.md` is the baseline. It is red on four scenarios and green on two:

- red: 30-day long session (`recall_lane_included` 238/600 = 39.7%, `min_budget_utilization` 10.4%);
- red: forget (`post_forget_disk_hits` 4 files: `checkpoint.json`, `checkpoint.json.prev`,
  `memory.sqlite`, `shell-events.jsonl`);
- red: night catch-up (0 Dream, 0 `dream_catchup`, 0 snapshots);
- red: emergence feedback (4 surfacings after three ignored ones);
- green: budget pause and resume;
- green: SIGKILL recovery.

The red scenarios are the point of the early landing: #316/#327 (and the two measured side findings)
must be re-run against the fixed head and the table compared. Do not tune a threshold to make a red
green.

## Caveats

- The 600-turn scenario takes about 246 seconds on this ARM64 box (~0.4 s/turn). The ticket's 60-second
  target is not met; the full 30x20 protocol is kept because the cliff is the measurement.
- The forget query is a light paraphrase ("我以前的住址是哪里？") because the product's recall lane is
  lexical without an embedding model; it hits before forget, which is what makes the post-forget
  emptiness meaningful.
- The SIGKILL fixture seeds the away queue through the shell's own `enqueueAway` + checkpoint write,
  not through a full absence/emergence cycle. The scenario asks whether the checkpoint keeps it.
- This suite is not wired to a nightly workflow in this round; it is a runnable scorecard. The
  ticket's next step is the nightly run, then a hard gate once stable.

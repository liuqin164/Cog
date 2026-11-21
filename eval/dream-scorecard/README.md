# Dream work scorecard — #378

One command, from the repository root:

```bash
bun eval/dream-scorecard/run.ts
```

It writes `results.md` / `results.json` next to this file. The default calls the memory model at
`http://127.0.0.1:3425/v1` with `auto/deepseek-v4.1-flash`; `MG_BASE_URL`, `MG_MODEL`,
`MG_API_KEY`, `--base-url`, `--model`, `--out-dir`, `--keep`, `--class-only` and `--compile-only`
are the knobs. `--report-only` re-renders `results.md` from `results.json` without calling a model.

## What runs

- **Classification** — each corpus item is one user/assistant pair, written through
  `KernelAgentMemoryBackend.rememberTurnWithResult({ ingestMode: 'raw_then_dream' })`, then sent
  through `MemoryKernel.runDreamCurator()` with only that pair's raw event IDs. This is the real
  `DreamCuratorWorker` path: deterministic extraction, then the memory-model candidate call. The
  candidates are governed with `promoteDreamCandidates()`.
- **Compile** — each scenario is a multi-day event stream written through
  `appendEpisodeMessage()`, sealed, and drained by `runDreamTick()`. That is the same nightly
  worker path that writes frames and candidates; frames are read with `getMemoryFrame()` and
  candidates are governed with `promoteDreamCandidates()`.

No product code is touched and no prompt is reimplemented in the eval.

## Corpus

`corpus.ts` has 26 classification items, 6 long-tail probes, and 4 compile scenarios: three with 4 turns and `reschedule` with 8.

Classification covers the six roles: rule, soul, commitment, intention, experience, ordinary.
The four confusion pairs are `rule_vs_one_off`, `commitment_vs_intention`,
`soul_vs_preference`, and `correction_vs_new_fact`. The two correction items are reported
separately and excluded from six-class accuracy. The six `long-tail` probes put the rule,
negation, or condition after a long neutral head; they are reported as a group and excluded from
the six-role metric.

Compile scenarios are `launch` (release rules, a commitment, an intention), `incident` (an
experience, a correction, a soul statement), and `travel` (an intention, a preference, a rule, an
experience). `reschedule` adds four Chinese time updates (old value stated on day one, new value on
day two) and asks each old value's topic after the night drain. Each scenario has four gold points
checked against the frame and candidate text.

## Class mapping

The six roles are the ticket's labels; the current Dream worker has no native bucket for two of
them. The scorecard uses the closest real artifact and says so instead of inventing a classifier:

| role | closest real artifact |
| --- | --- |
| rule | `boundary`, or deterministic `preferences` with `project_constraint` / `operating_*` |
| soul | `user_preference`, or deterministic `preferences` with `user_preference` |
| commitment | `long_term_goal`, or deterministic `preferences` with `long_term_goal` |
| intention | `temporal_fact_update` |
| experience | `project_memory` |
| ordinary | `topic_summary` / `summary`, and the default when no role candidate exists |

`soul` and `commitment` are therefore proxies: the production prompt has no soul or commitment
bucket, so a low score for those rows is a statement about the current candidate vocabulary, not
about a hidden classifier.

## Metrics

- **Classification accuracy** — scored items only, six roles; per-role precision/recall and the
  three largest off-diagonal confusions. Pair accuracy and correction detection are separate.
- **Group probes** — per-group hit counts for items excluded from six-role accuracy.
- **Frame pass rate** — episodes whose night output has a frame with
  `sourceAuthority: 'processor'`, over episodes drained.
- **Fallback need** — episodes with no processor frame, over episodes drained. The nightly path
  fails an invalid frame instead of calling `deterministicFrameFallback`, so the scorecard reports
  the need rate as the closest measurable proxy.
- **Gold points** — each point is a set of alternative term groups; a point hits when every group
  appears in the combined frame and candidate text for that scenario.
- **Candidate ratios** — final queue after CPU governance: promoted, rejected, and suppressed
  (`needs_confirmation` + `superseded`).
- **Confidence calibration** — model candidates bucketed at the governance thresholds
  (`0.60/0.72/0.74/0.86/0.90/0.95`) by self-reported confidence, with the promoted share per
  bucket; deterministic candidates are reported as one separate bucket. Buckets count every
  candidate, including the ones governance routes to `needs_confirmation` before promotion.
- **Chinese temporal updates** — for each old/new pair, `recall()` asks the topic after the night
  drain. Old retired means the old value is absent from every recalled item; hit requires the old
  value absent and the new value present.
- **Cost** — provider calls and prompt/completion tokens from `ModelRegistry` usage hooks. The
  compile row is one night's drain.

## Baseline (2026-11-22, head 37e1cf8b)

`results.md` is the generated baseline. Classification: **21/24 (87.5%)**. Group probes: long-tail **6/6**.

| role | precision | recall | support |
| --- | --- | --- | --- |
| rule | 80.0% | 100.0% | 4 |
| soul | 75.0% | 75.0% | 4 |
| commitment | 100.0% | 100.0% | 4 |
| intention | 100.0% | 100.0% | 4 |
| experience | 80.0% | 100.0% | 4 |
| ordinary | 100.0% | 50.0% | 4 |

Worst three error categories: **soul → rule (1)**, **ordinary → soul (1)**, **ordinary → experience (1)**. Confusion pairs scored 2/2, 1/2, 2/2, 1/2. Correction detection was 2/2
with 0/1 new-fact false positives.

Compile: **20/20 frames passed on the first pass**, **0/20 fallback need**, **16/16 gold points**.
Final candidate queue: 108 candidates, 87 promoted (80.6%), 0 rejected (0%), 21 suppressed
(19.4%). One night (20 episodes): **40 calls, 67,566 input tokens, 91,820 output tokens**
(159,386 total). The whole scorecard: 72 calls, 222,939 tokens.

Confidence calibration: model survival is not monotonic in self-reported confidence —
**0.74–<0.86: 94.7%**, **0.86–<0.90: 55.6%**, **0.90–<0.95: 44.4%**, **>=0.95: 4.2%**. The
highest-confidence bucket has the lowest survival. Deterministic candidates: 227/230 (98.7%%).

Chinese temporal updates: old value retired **0/4**, new value present **4/4**, hit **0/4**. All
four old values remained recallable after the update, so the current Chinese path does not retire
the old value.

The baseline's actionable signals are the inverted confidence calibration, Chinese time updates
that never retire the old value, and `preferenceCategory` treating the `别` inside `特别` as a
negative constraint (the `soul-family` item was classified as rule).

## Limits

- One run on one model snapshot; candidate and frame output are stochastic. Re-run before treating
  a small delta as real.
- The classification corpus is synthetic Chinese, one turn per item. It measures classification,
  not recall quality.
- The compile stream is also synthetic; the episode assembler currently makes one episode per turn,
  so these frames are shorter than a long real conversation.
- Profile and procedure compilers are not part of the night path measured here. Their inputs are
  represented by the candidate artifacts (`user_preference` / `boundary` for profile-like intake,
  `failure_lesson` for procedure-like lessons) only where the Dream worker produced them.

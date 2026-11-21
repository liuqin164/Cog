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

`corpus.ts` has 26 classification items and 3 compile scenarios (4 turns each).

Classification covers the six roles: rule, soul, commitment, intention, experience, ordinary.
The four confusion pairs are `rule_vs_one_off`, `commitment_vs_intention`,
`soul_vs_preference`, and `correction_vs_new_fact`. The two correction items are reported
separately and excluded from six-class accuracy.

Compile scenarios are `launch` (release rules, a commitment, an intention), `incident` (an
experience, a correction, a soul statement), and `travel` (an intention, a preference, a rule, an
experience). Each has four gold points checked against the frame and candidate text.

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
- **Frame pass rate** — episodes whose night output has a frame with
  `sourceAuthority: 'processor'`, over episodes drained.
- **Fallback need** — episodes with no processor frame, over episodes drained. The nightly path
  fails an invalid frame instead of calling `deterministicFrameFallback`, so the scorecard reports
  the need rate as the closest measurable proxy.
- **Gold points** — each point is a set of alternative term groups; a point hits when every group
  appears in the combined frame and candidate text for that scenario.
- **Candidate ratios** — final queue after CPU governance: promoted, rejected, and suppressed
  (`needs_confirmation` + `superseded`).
- **Cost** — provider calls and prompt/completion tokens from `ModelRegistry` usage hooks. The
  compile row is one night's drain.

## Baseline (2026-11-21, head 4f8f4527)

`results.md` is the generated baseline. Classification: **11/24 (45.8%)**.

| role | precision | recall | support |
| --- | --- | --- | --- |
| rule | 80.0% | 100.0% | 4 |
| soul | 75.0% | 75.0% | 4 |
| commitment | 0.0% | 0.0% | 4 |
| intention | 22.2% | 50.0% | 4 |
| experience | 33.3% | 25.0% | 4 |
| ordinary | 100.0% | 25.0% | 4 |

Worst three error categories: **commitment → intention (3)**, **experience → intention (3)**,
**intention → commitment (2)**. All four confusion pairs scored 1/2. Correction detection was
2/2 with 0/1 new-fact false positives.

Compile: **12/12 frames passed on the first pass**, **0/12 fallback need**, **12/12 gold points**.
Final candidate queue: 78 candidates, 58 promoted (74.4%), 0 rejected (0%), 20 suppressed
(25.6%). One night (12 episodes): **24 calls, 27,047 input tokens, 83,103 output tokens**
(110,150 total; 2 calls and about 9.2k tokens per episode).

The baseline's actionable signals are the missing commitment bucket, `temporal_fact_update`
absorbing experiences and commitments, and `preferenceCategory` treating the `别` inside `特别`
as a negative constraint (the `soul-family` item was classified as rule).

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

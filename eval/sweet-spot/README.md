# Context sweet spot (#258 C3)

One command, from the repository root:

```bash
bun eval/sweet-spot/run.ts
```

It runs the same 20 tasks at four `targetTokens` bands (6k/12k/24k/48k) against the
model the shell is actually configured with (`MG_MODEL`, default
`auto/deepseek-v4.1-flash`) and writes `results.md` / `results.json` next to this
file. `--tasks N`, `--bands 6000,48000`, `--model`, `--base-url`, `--seed` and
`--out-dir` are the knobs. The default seed is 258.

Nothing opens a kernel or the live companion database, and the run creates no
scratch directory: the two result files are the only output.

## Measured result (2026-11-16)

Run on head `07c3ec2d`, model `auto/deepseek-v4.1-flash`, seed 258:

| targetTokens | provider prompt tokens | task success | fact recall | mean latency | total cost |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 6,000 | 13,355 | 20/20 | 100/100 | 4,825 ms | $0.0420 |
| 12,000 | 26,595 | 20/20 | 100/100 | 4,967 ms | $0.0816 |
| 24,000 | 53,078 | 20/20 | 100/100 | 6,526 ms | $0.1615 |
| 48,000 | 106,032 | 20/20 | 100/100 | 8,376 ms | $0.3202 |

No attention knee in 6k–48k. Prompt tokens grow 7.9× and cost 7.6× from
6k to 48k for no measured accuracy gain. The shell's chars/4 unit is about
2.2× smaller than the provider's count on this Chinese corpus, so 6k shell
tokens are ~13.4k provider tokens.

On this batch, 6k is the measured optimum and the route value stays at 6,000
pending E6's second model and a coverage arm (does 6k keep the useful lane?).
See `results.md` for the full table and `results.json` for every call.

## Corpus

20 tasks, five facts each (100 facts). Each task names one project and asks for
the codes of five of its attributes in order. Every answer is a short code such
as `KA-10`; grading extracts the target-shaped codes and requires exactly five,
in the asked order. A fact counts as found if its code appears anywhere in the
answer, so the report separates task success from partial recall.

## What one band is

`targetTokens` is the shell assembler's unit, not the provider's: the assembler
fits a lane to `ceil(chars / 4)`. A band therefore means `targetTokens * 4`
characters of context. The report prints the provider's `usage.prompt_tokens`
beside the shell estimate, because Chinese text costs more provider tokens than
the chars/4 estimate assumes.

The context is one `<recall-context>` block. The five target lines sit at fixed
relative depths (10/30/50/70/90%) at every band, so depth is not a function of
the band. Everything else is a distractor.

## Distractors and the target

A distractor shares at most one cue with a target:

- the target entity with a different attribute,
- a different entity with a target attribute, or
- neither cue.

No distractor is the target entity+attribute pair, so each question has exactly
one correct answer. Entries carry no dates, so recency cannot be used as a
shortcut. The distractor order is a fixed SHA-256 shuffle keyed by the seed, the
task id and the band.

## Random baseline

A uniform guess over the codes present is about `1/K` per fact (K grows with the
band) and `1/(K·(K−1)·…·(K−4))` for all five in order, effectively zero. This is
short-answer extraction, not multiple choice, so there is no 25% floor.

## Cost

Cost comes from the gateway's `/v1/models` pricing at run time: prompt tokens ×
prompt price + completion tokens × completion price. If the gateway reports no
pricing, the cost column is `—` rather than an estimate.

## What this does not measure

- It holds the target present at every band. The shell's six-lane assembler can
  drop a whole low-priority lane when the total exceeds `targetTokens`; that
  product behaviour (the "too small drops useful content" failure) is a
  separate arm and is not reproduced here.
- It measures one model. E6 asks for at least two models before a per-model
  route value is final.
- `temperature: 0` reduces but does not remove provider nondeterminism.

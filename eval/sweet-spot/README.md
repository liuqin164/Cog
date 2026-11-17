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

## #293: the discriminating corpus (2026-11-17)

The 20-task corpus above scores 20/20 at every band, so it prices context but
cannot show a knee. `--corpus hard` swaps in eight tasks in the four shapes #293
names, with one exact code as the answer and the same strict grader:

- `multihop` (2): the first hop names a person, the second names that person's
  attribute; a same-attribute decoy on another entity and a same-entity decoy
  on another attribute sit beside each hop.
- `similar` (2): codes and entity names differ by one character or one digit
  (`DW-31` / `DW-32` / `DW-13` / `DW-310`, `赤霄` / `赤霄东` / `赤霄南`).
- `longtool` (2): one tool result of ~9k characters (≈2.5k provider tokens) per
  task, target buried mid-dump among five near-identical service dumps.
- `session` (2): 200+ turns of chat; 832 turns at 6k, 6,650 at 48k, with the
  target at 1.5% depth and decoys at 45% and 80%.

Run: `bun eval/sweet-spot/run.ts --corpus hard --out-dir eval/sweet-spot/hard`.

| targetTokens | prompt tokens (provider) | task success | cost total |
| ---: | ---: | ---: | ---: |
| 6,000 | 13,629 | 8/8 | $0.0168 |
| 12,000 | 27,770 | 8/8 | $0.0339 |
| 24,000 | 56,055 | 8/8 | $0.0678 |
| 48,000 | 99,400 | 8/8 | $0.1197 |

Every shape is 2/2 at every band, including the two-hop and near-duplicate
ones. This is the ticket's second branch, not a knee: **raising the budget from
6k to 48k still buys no accuracy on a corpus built to discriminate**, while
prompt tokens grow 7.3× and cost 7.1×. The boundary is unchanged and now has
harder evidence behind it: 6k stays the provisional route value for this model;
the open question is still coverage, not attention.

Limits that bound the claim: one model, eight tasks per band, one sample per
cell. The context is one recall lane with the target always present, so this is
retrieval under load, not the shell's six-lane drop behaviour. One 48k call
(`se02`) reported 8,187 prompt tokens for a 192k-character context, which is
implausible and looks like gateway-side truncation; a recheck at the same band
reported 113,976 and answered correctly, so the cell is a usage-accounting
outlier, not a long-context success.

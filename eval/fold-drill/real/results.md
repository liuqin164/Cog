# Fold drill-down at real scale — #294

- base commit at run: `f74b3b2b51f4`
- run at: 2026-11-17T06:20:10.971Z
- model: `auto/deepseek-v4.1-flash` through `http://127.0.0.1:3425/v1`
- tasks: 8 per arm (2 number, 2 name, 2 constraint, 2 step)
- arms: full, folded_key
- temperature: 0; task order fixed; one command: `bun eval/fold-drill/run.ts --corpus real`

## Corpus

- 8 tasks, 246.0 turns / 58633 chars on average.
- Each task has one target detail and two same-type distractors; all three are folded in the folded arms.
- Auto-expansion trigger: 8 tasks hit a stub entity term, 0 do not.
- Random baseline: one target among three same-kind stubs, so a blind pick is 33.3%; a random string matches no answer.

## Results

| arm | n | target drill | any drill | correct | hallucinated | avg context chars | avg prompt tokens (billed) | avg model calls | avg tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 8 | 0.0% | 0.0% | 100.0% | 0.0% | 62713 | 30140 | 1.00 | 0.00 |
| folded_key | 8 | 100.0% | 100.0% | 100.0% | 0.0% | 9525 | 27989 | 2.00 | 3.75 |

## By detail type

| type | arm | n | target drill | correct | hallucinated |
| --- | --- | ---: | ---: | ---: | ---: |
| number | full | 2 | 0.0% | 100.0% | 0.0% |
| number | folded_key | 2 | 100.0% | 100.0% | 0.0% |
| name | full | 2 | 0.0% | 100.0% | 0.0% |
| name | folded_key | 2 | 100.0% | 100.0% | 0.0% |
| constraint | full | 2 | 0.0% | 100.0% | 0.0% |
| constraint | folded_key | 2 | 100.0% | 100.0% | 0.0% |
| step | full | 2 | 0.0% | 100.0% | 0.0% |
| step | folded_key | 2 | 100.0% | 100.0% | 0.0% |

## Per task (the scale points)

| task | scale | folded blocks | context chars | arm | prompt tokens (billed) | model calls | tool calls | correct |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| r01 | real | 6 | 62693 | full | 30139 | 1 | 0 | yes |
| r01 | real | 6 | 9520 | folded_key | 37294 | 2 | 6 | yes |
| r02 | real | 6 | 62693 | full | 30117 | 1 | 0 | yes |
| r02 | real | 6 | 9548 | folded_key | 24919 | 2 | 3 | yes |
| c01 | real | 6 | 62719 | full | 30133 | 1 | 0 | yes |
| c01 | real | 6 | 9527 | folded_key | 37243 | 2 | 6 | yes |
| c02 | real | 6 | 62734 | full | 30127 | 1 | 0 | yes |
| c02 | real | 6 | 9524 | folded_key | 16654 | 2 | 1 | yes |
| n01 | real | 6 | 62645 | full | 30124 | 1 | 0 | yes |
| n01 | real | 6 | 9513 | folded_key | 37267 | 2 | 6 | yes |
| n02 | real | 6 | 62683 | full | 30128 | 1 | 0 | yes |
| n02 | real | 6 | 9531 | folded_key | 24831 | 2 | 3 | yes |
| s01 | real | 6 | 62750 | full | 30178 | 1 | 0 | yes |
| s01 | real | 6 | 9522 | folded_key | 20795 | 2 | 2 | yes |
| s02 | real | 6 | 62790 | full | 30177 | 1 | 0 | yes |
| s02 | real | 6 | 9518 | folded_key | 24911 | 2 | 3 | yes |

## Conclusion

Passive keys hold at this scale: the folded+key arm stays within 10 points of the full transcript and drills the target when it needs to.

## Fold-enable threshold

- At this scale (6 tool outputs, ~30140 full prompt tokens) folding saved **7.1%**: 30140 → 27989 tokens, because the model read 3.75 of 6 blocks and every round re-bills the context.
- The block-count sweep in `sweep/` locates the crossover; the threshold rule is stated there.

## Reading

- Passive key: 8/8 target drills. Of those runs, 1 read 1, 1 read 2, 3 read 3 stubs. Trigger-hit tasks averaged 3.75 reads; trigger-miss tasks averaged 0.00.
- Cost: average billed prompt tokens were 30140 (full) and 27989 (folded+key).
- Hallucination: 0/16 runs. The model either read the original or had it auto-expanded, so this does not test hallucination from model-written summaries.

## Failures

- none

## What this measures, and what it does not

- The harness supplies the fold, the key and the drill action. It measures the model + context shape, not the product pipeline.
- The folded stub is the kernel `SessionDigest` shape: entryId (key), an exact prefix quote of the ledger turn, and sourceRefs. The value is only in the omitted suffix.
- Correctness is read from the required `答案：<value>` line. Hallucination is a detail value in the answer that does not occur in the task ledger: numbers, the corpus name pool, day/time tokens, and step action families. Chinese numerals and names outside the pool are not detected.
- The corpus is synthetic but at the ticket scale: 240 turns and tool outputs of ~9k characters (roughly 2.5k provider tokens) per folded detail. Every cell is one model, temperature 0, one sample.

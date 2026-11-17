# Fold threshold sweep — #294

- base commit at run: `f74b3b2b51f4`
- run at: 2026-11-17T06:24:03.060Z
- model: `auto/deepseek-v4.1-flash` through `http://127.0.0.1:3425/v1`
- tasks: 5 per arm (5 number, 0 name, 0 constraint, 0 step)
- arms: full, folded_key
- temperature: 0; task order fixed; one command: `bun eval/fold-drill/run.ts --corpus sweep`

## Corpus

- 5 tasks, 246.2 turns / 60416 chars on average.
- Each task has one target detail and two same-type distractors; all three are folded in the folded arms.
- Auto-expansion trigger: 5 tasks hit a stub entity term, 0 do not.
- Random baseline: one target among three same-kind stubs, so a blind pick is 33.3%; a random string matches no answer.

## Results

| arm | n | target drill | any drill | correct | hallucinated | avg context chars | avg prompt tokens (billed) | avg model calls | avg tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 5 | 0.0% | 0.0% | 100.0% | 0.0% | 64500 | 30967 | 1.00 | 0.00 |
| folded_key | 5 | 100.0% | 100.0% | 100.0% | 0.0% | 9544 | 23278 | 2.00 | 2.60 |

## By detail type

| type | arm | n | target drill | correct | hallucinated |
| --- | --- | ---: | ---: | ---: | ---: |
| number | full | 5 | 0.0% | 100.0% | 0.0% |
| number | folded_key | 5 | 100.0% | 100.0% | 0.0% |
| name | full | 0 | n/a | n/a | n/a |
| name | folded_key | 0 | n/a | n/a | n/a |
| constraint | full | 0 | n/a | n/a | n/a |
| constraint | folded_key | 0 | n/a | n/a | n/a |
| step | full | 0 | n/a | n/a | n/a |
| step | folded_key | 0 | n/a | n/a | n/a |

## Per task (the scale points)

| task | scale | folded blocks | context chars | arm | prompt tokens (billed) | model calls | tool calls | correct |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| r01-sweep-1 | 1 block | 1 | 17909 | full | 9667 | 1 | 0 | yes |
| r01-sweep-1 | 1 block | 1 | 9055 | folded_key | 16127 | 2 | 1 | yes |
| r01-sweep-2 | 2 blocks | 2 | 26869 | full | 13762 | 1 | 0 | yes |
| r01-sweep-2 | 2 blocks | 2 | 9149 | folded_key | 20409 | 2 | 2 | yes |
| r01-sweep-4 | 4 blocks | 4 | 44795 | full | 21952 | 1 | 0 | yes |
| r01-sweep-4 | 4 blocks | 4 | 9336 | folded_key | 28848 | 2 | 4 | yes |
| r01-sweep-8 | 8 blocks | 8 | 80614 | full | 38338 | 1 | 0 | yes |
| r01-sweep-8 | 8 blocks | 8 | 9708 | folded_key | 25145 | 2 | 3 | yes |
| r01-sweep-16 | 16 blocks | 16 | 152312 | full | 71114 | 1 | 0 | yes |
| r01-sweep-16 | 16 blocks | 16 | 10474 | folded_key | 25861 | 2 | 3 | yes |

## Conclusion

Passive keys hold at this scale: the folded+key arm stays within 10 points of the full transcript and drills the target when it needs to.

## Fold-enable threshold

- The crossover sits between **21952** provider prompt tokens (4 blocks, folded 28848) and **38338** (8 blocks, folded 25145).
- Recommended enable threshold: **fold only when the transcript would exceed ~30,000 provider prompt tokens**. Below it, the stub, the extra round and the drilled original cost more than the full transcript.
- Above the crossover the folded prompt is roughly flat (25145–25861 tokens) because the model drills only the blocks it needs; the saving grows with how much is folded and not read.
- Accuracy was unaffected at every point: 5/5 points had both arms correct, so this is a cost/capacity threshold, not a correctness one.

## Reading

- Passive key: 5/5 target drills. Of those runs, 1 read 1, 1 read 2, 2 read 3 stubs. Trigger-hit tasks averaged 2.60 reads; trigger-miss tasks averaged 0.00.
- Cost: average billed prompt tokens were 30967 (full) and 23278 (folded+key).
- Hallucination: 0/10 runs. The model either read the original or had it auto-expanded, so this does not test hallucination from model-written summaries.

## Failures

- none

## What this measures, and what it does not

- The harness supplies the fold, the key and the drill action. It measures the model + context shape, not the product pipeline.
- The folded stub is the kernel `SessionDigest` shape: entryId (key), an exact prefix quote of the ledger turn, and sourceRefs. The value is only in the omitted suffix.
- Correctness is read from the required `答案：<value>` line. Hallucination is a detail value in the answer that does not occur in the task ledger: numbers, the corpus name pool, day/time tokens, and step action families. Chinese numerals and names outside the pool are not detected.
- The corpus is synthetic but at the ticket scale: 240 turns and tool outputs of ~9k characters (roughly 2.5k provider tokens) per folded detail. Every cell is one model, temperature 0, one sample.

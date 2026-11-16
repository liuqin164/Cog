# Fold drill-down experiment — #254 B4

- base commit at run: `284cd1a3cecf`
- run at: 2026-11-16T09:45:03.996Z
- model: `auto/deepseek-v4.1-flash` through `http://127.0.0.1:3425/v1`
- tasks: 24 per arm (6 number, 6 name, 6 constraint, 6 step)
- temperature: 0; task order fixed; one command: `bun eval/fold-drill/run.ts`

## Corpus

- 24 tasks, 24.0 turns / 665 chars on average.
- Each task has one target detail and two same-type distractors; all three are folded in the folded arms.
- Auto-expansion trigger: 19 tasks hit a stub entity term, 5 do not.
- Random baseline: one target among three same-kind stubs, so a blind pick is 33.3%; a random string matches no answer.

## Results

| arm | n | target drill | any drill | correct | hallucinated | avg context chars | avg prompt tokens (billed) | avg model calls | avg tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 24 | 0.0% | 0.0% | 100.0% | 0.0% | 1026 | 691 | 1.00 | 0.00 |
| folded_key | 24 | 100.0% | 100.0% | 100.0% | 0.0% | 1094 | 2198 | 2.00 | 1.75 |
| folded_auto | 24 | 20.8% | 20.8% | 95.8% | 0.0% | 1178 | 1317 | 1.21 | 0.42 |

## By detail type

| type | arm | n | target drill | correct | hallucinated |
| --- | --- | ---: | ---: | ---: | ---: |
| number | full | 6 | 0.0% | 100.0% | 0.0% |
| number | folded_key | 6 | 100.0% | 100.0% | 0.0% |
| number | folded_auto | 6 | 16.7% | 100.0% | 0.0% |
| name | full | 6 | 0.0% | 100.0% | 0.0% |
| name | folded_key | 6 | 100.0% | 100.0% | 0.0% |
| name | folded_auto | 6 | 33.3% | 100.0% | 0.0% |
| constraint | full | 6 | 0.0% | 100.0% | 0.0% |
| constraint | folded_key | 6 | 100.0% | 100.0% | 0.0% |
| constraint | folded_auto | 6 | 16.7% | 100.0% | 0.0% |
| step | full | 6 | 0.0% | 100.0% | 0.0% |
| step | folded_key | 6 | 100.0% | 100.0% | 0.0% |
| step | folded_auto | 6 | 16.7% | 83.3% | 0.0% |

## Auto-expansion trigger split

| arm | group | n | target drill | correct | hallucinated |
| --- | --- | ---: | ---: | ---: | ---: |
| full | trigger_hit | 19 | 0.0% | 100.0% | 0.0% |
| full | trigger_miss | 5 | 0.0% | 100.0% | 0.0% |
| folded_key | trigger_hit | 19 | 100.0% | 100.0% | 0.0% |
| folded_key | trigger_miss | 5 | 100.0% | 100.0% | 0.0% |
| folded_auto | trigger_hit | 19 | 0.0% | 94.7% | 0.0% |
| folded_auto | trigger_miss | 5 | 100.0% | 100.0% | 0.0% |

## Conclusion

Passive keys hold: the folded+key arm stays within 10 points of the full arm and drills the target in at least 80% of runs. Auto-expansion is not required for correctness on this corpus; it only removes drill calls on trigger-hit tasks, so treat it as a cost optimization rather than a safety gate.

## Reading

- Passive key: 24/24 target drills. Of those runs, 14 read 1, 2 read 2, 8 read 3 stubs. Trigger-hit tasks averaged 1.42 reads; trigger-miss tasks averaged 3.00.
- Auto-expand: trigger-hit runs drilled the target 0/19; trigger-miss runs 5/5. Correctness was 18/19 on hits and 5/5 on misses.
- Cost: average billed prompt tokens were 691 (full), 2198 (folded+key) and 1317 (folded+auto). At three stubs and ~1k characters, folding is not a token saving; the model reads most stubs.
- Hallucination: 0/72 runs. The model either read the original or had it auto-expanded, so this does not test hallucination from model-written summaries.

## Failures

- `f23` (step, folded_auto) — expected: 先导出快照，再删除过期分区 — answer: 先导出快照 — wrong

## What this measures, and what it does not

- The harness supplies the fold, the key and the drill action. It measures the model + context shape, not the product pipeline.
- The folded stub is the kernel `SessionDigest` shape: entryId (key), an exact prefix quote of the ledger turn, and sourceRefs. The value is only in the omitted suffix.
- Correctness is read from the required `答案：<value>` line. Hallucination is a detail value in the answer that does not occur in the task ledger: numbers, the corpus name pool, day/time tokens, and step action families. Chinese numerals and names outside the pool are not detected.
- The corpus is synthetic and small; this is a scope decision input, not a general long-context benchmark. The model is not deterministic even at temperature 0, so a re-run can move counts.

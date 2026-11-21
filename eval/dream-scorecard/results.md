# Dream work scorecard — #378

- head: `37e1cf8b`
- model: `auto/deepseek-v4.1-flash` at `http://127.0.0.1:3425/v1`
- generated: 2026-11-21T20:31:58.647Z

## Classification

Scored items: 21/24 (87.5%). Correction probes: 2 (excluded from six-class accuracy).

| role | precision | recall | support |
| --- | --- | --- | --- |
| rule | 80.0% | 100.0% | 4 |
| soul | 75.0% | 75.0% | 4 |
| commitment | 100.0% | 100.0% | 4 |
| intention | 100.0% | 100.0% | 4 |
| experience | 80.0% | 100.0% | 4 |
| ordinary | 100.0% | 50.0% | 4 |

Worst three error categories:

- soul → rule: 1
- ordinary → soul: 1
- ordinary → experience: 1

Confusion pairs:

| pair | correct | total | accuracy |
| --- | --- | --- | --- |
| rule_vs_one_off | 2 | 2 | 100.0% |
| soul_vs_preference | 1 | 2 | 50.0% |
| commitment_vs_intention | 2 | 2 | 100.0% |
| correction_vs_new_fact | 1 | 2 | 50.0% |

Correction detection: 2/2; new-fact false positives: 0/1.
Group probes: long-tail 6/6.

## Compile

| scenario | episodes | frame pass | processor errors | fallback need | gold points | candidates | promoted | rejected | suppressed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| launch | 4 | 4/4 | 0 | 0/4 | 4/4 | 21 | 17 | 0 | 4 |
| incident | 4 | 4/4 | 0 | 0/4 | 4/4 | 23 | 20 | 0 | 3 |
| travel | 4 | 4/4 | 0 | 0/4 | 4/4 | 22 | 18 | 0 | 4 |
| reschedule | 8 | 8/8 | 0 | 0/8 | 4/4 | 42 | 32 | 0 | 10 |

Totals: episodes 20, processed 20, failed 0, frame pass 20/20 (100.0%), processor errors 0, fallback need 0/20 (0.0%), gold 16/16 (100.0%).

## Chinese temporal updates

| case | query | old value | new value | old retired | new present | hit | recall items |
| --- | --- | --- | --- | --- | --- | --- | --- |
| review-time | 评审会定在什么时候？ | 两点 | 三点 | no | yes | no | 5 |
| dinner-time | 客户饭局定在什么时候？ | 七点 | 十二点 | no | yes | no | 6 |
| release-time | 发布窗口定在什么时候？ | 八点 | 十一点 | no | yes | no | 8 |
| gym-time | 健身课定在什么时候？ | 十点 | 六点半 | no | yes | no | 6 |

Old value retired: 0/4; new value present: 4/4; hit (old retired and new present): 0/4.

## Confidence calibration

| bucket | candidates | promoted | survival |
| --- | --- | --- | --- |
| <0.60 | 1 | 0 | 0.0% |
| 0.60–<0.72 | 8 | 3 | 37.5% |
| 0.72–<0.74 | 4 | 1 | 25.0% |
| 0.74–<0.86 | 19 | 18 | 94.7% |
| 0.86–<0.90 | 9 | 5 | 55.6% |
| 0.90–<0.95 | 18 | 8 | 44.4% |
| >=0.95 | 24 | 1 | 4.2% |
| deterministic (all) | 230 | 227 | 98.7% |

Model candidates: 36/83 promoted (43.4%). Deterministic candidates: 227/230 promoted (98.7%).

## Cost

| phase | calls | input tokens | output tokens |
| --- | --- | --- | --- |
| classification | 32 | 38495 | 25058 |
| compile | 40 | 67566 | 91820 |
| total | 72 | 106061 | 116878 |

Fallback need is the share of episodes with no processor frame; the nightly path fails those episodes rather than invoking `deterministicFrameFallback`, so this is the closest measurable proxy. Suppressed = `needs_confirmation` + `superseded` after CPU governance.

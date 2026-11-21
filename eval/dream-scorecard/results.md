# Dream work scorecard — #378

- head: `c5d6bb4a`
- model: `auto/deepseek-v4.1-flash` at `http://127.0.0.1:3425/v1`
- generated: 2026-11-21T17:37:54.615Z

## Classification

Scored items: 14/24 (58.3%). Correction probes: 2 (excluded from six-class accuracy).

| role | precision | recall | support |
| --- | --- | --- | --- |
| rule | 80.0% | 100.0% | 4 |
| soul | 75.0% | 75.0% | 4 |
| commitment | 0.0% | 0.0% | 4 |
| intention | 33.3% | 50.0% | 4 |
| experience | 75.0% | 75.0% | 4 |
| ordinary | 66.7% | 50.0% | 4 |

Worst three error categories:

- commitment → intention: 3
- intention → commitment: 2
- soul → rule: 1

Confusion pairs:

| pair | correct | total | accuracy |
| --- | --- | --- | --- |
| rule_vs_one_off | 2 | 2 | 100.0% |
| soul_vs_preference | 1 | 2 | 50.0% |
| commitment_vs_intention | 1 | 2 | 50.0% |
| correction_vs_new_fact | 1 | 2 | 50.0% |

Correction detection: 2/2; new-fact false positives: 0/1.

## Compile

| scenario | episodes | frame pass | processor errors | fallback need | gold points | candidates | promoted | rejected | suppressed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| launch | 4 | 4/4 | 0 | 0/4 | 4/4 | 25 | 23 | 0 | 2 |
| incident | 4 | 4/4 | 0 | 0/4 | 4/4 | 30 | 25 | 0 | 5 |
| travel | 4 | 4/4 | 0 | 0/4 | 4/4 | 17 | 16 | 0 | 1 |
| reschedule | 8 | 6/8 | 0 | 2/8 | 4/4 | 48 | 31 | 0 | 17 |

Totals: episodes 20, processed 18, failed 2, frame pass 18/20 (90.0%), processor errors 0, fallback need 2/20 (10.0%), gold 16/16 (100.0%).

## Chinese temporal updates

| case | query | old value | new value | old retired | new present | hit | recall items |
| --- | --- | --- | --- | --- | --- | --- | --- |
| review-time | 评审会定在什么时候？ | 两点 | 三点 | no | yes | no | 5 |
| dinner-time | 客户饭局定在什么时候？ | 七点 | 十二点 | no | yes | no | 5 |
| release-time | 发布窗口定在什么时候？ | 八点 | 十一点 | no | yes | no | 5 |
| gym-time | 健身课定在什么时候？ | 十点 | 六点半 | no | yes | no | 5 |

Old value retired: 0/4; new value present: 4/4; hit (old retired and new present): 0/4.

## Confidence calibration

| bucket | candidates | promoted | survival |
| --- | --- | --- | --- |
| <0.60 | 0 | 0 | n/a |
| 0.60–<0.72 | 5 | 2 | 40.0% |
| 0.72–<0.74 | 2 | 1 | 50.0% |
| 0.74–<0.86 | 29 | 24 | 82.8% |
| 0.86–<0.90 | 15 | 11 | 73.3% |
| 0.90–<0.95 | 29 | 17 | 58.6% |
| >=0.95 | 20 | 5 | 25.0% |
| deterministic (all) | 194 | 185 | 95.4% |

Model candidates: 60/100 promoted (60.0%). Deterministic candidates: 185/194 promoted (95.4%).

## Cost

| phase | calls | input tokens | output tokens |
| --- | --- | --- | --- |
| classification | 26 | 22725 | 35843 |
| compile | 40 | 64018 | 101719 |
| total | 66 | 86743 | 137562 |

Fallback need is the share of episodes with no processor frame; the nightly path fails those episodes rather than invoking `deterministicFrameFallback`, so this is the closest measurable proxy. Suppressed = `needs_confirmation` + `superseded` after CPU governance.

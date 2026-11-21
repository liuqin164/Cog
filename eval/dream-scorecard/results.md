# Dream work scorecard — #378

- head: `4f8f4527`
- model: `auto/deepseek-v4.1-flash` at `http://127.0.0.1:3425/v1`
- generated: 2026-11-21T13:44:08.821Z

## Classification

Scored items: 11/24 (45.8%). Correction probes: 2 (excluded from six-class accuracy).

| role | precision | recall | support |
| --- | --- | --- | --- |
| rule | 80.0% | 100.0% | 4 |
| soul | 75.0% | 75.0% | 4 |
| commitment | 0.0% | 0.0% | 4 |
| intention | 22.2% | 50.0% | 4 |
| experience | 33.3% | 25.0% | 4 |
| ordinary | 100.0% | 25.0% | 4 |

Worst three error categories:

- commitment → intention: 3
- experience → intention: 3
- intention → commitment: 2

Confusion pairs:

| pair | correct | total | accuracy |
| --- | --- | --- | --- |
| rule_vs_one_off | 1 | 2 | 50.0% |
| soul_vs_preference | 1 | 2 | 50.0% |
| commitment_vs_intention | 1 | 2 | 50.0% |
| correction_vs_new_fact | 1 | 2 | 50.0% |

Correction detection: 2/2; new-fact false positives: 0/1.

## Compile

| scenario | episodes | frame pass | fallback need | gold points | candidates | promoted | rejected | suppressed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| launch | 4 | 4/4 | 0/4 | 4/4 | 20 | 18 | 0 | 2 |
| incident | 4 | 4/4 | 0/4 | 4/4 | 32 | 20 | 0 | 12 |
| travel | 4 | 4/4 | 0/4 | 4/4 | 26 | 20 | 0 | 6 |

Totals: episodes 12, processed 12, failed 0, frame pass 12/12 (100.0%), fallback need 0/12 (0.0%), gold 12/12 (100.0%).

## Cost

| phase | calls | input tokens | output tokens |
| --- | --- | --- | --- |
| classification | 26 | 22728 | 33004 |
| compile | 24 | 27047 | 83103 |
| total | 50 | 49775 | 116107 |

Fallback need is the share of episodes with no processor frame; the nightly path fails those episodes rather than invoking `deterministicFrameFallback`, so this is the closest measurable proxy. Suppressed = `needs_confirmation` + `superseded` after CPU governance.

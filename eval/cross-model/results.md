# Cross-model retest — #269 E6

- first model: `auto/deepseek-v4.1-flash` (B4 head `284cd1a3cecf`, C3 head `07c3ec2d`)
- second model: `workbuddy-ai/glm-5.3-flash` (B4 head `a09a226e9345`, C3 head `a09a226e`)
- second-model B4 run: 2026-11-16T12:27:43.568Z; C3 run: 2026-11-16T12:28:12.029Z
- second model is non-DeepSeek (GLM family), reachable at the mg gateway, tool-capable, and priced by `/v1/models`.
- D5: no rerunnable object; the D group has not landed. Re-run when it does.

## B4 fold/drill

| arm | model | target drill | any drill | correct | hallucinated | avg prompt tokens | avg model calls | avg tool calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | DeepSeek | 0.0% | 0.0% | 100.0% | 0.0% | 691 | 1.00 | 0.00 |
| full | GLM | 0.0% | 0.0% | 95.8% | 8.3% | 719 | 1.00 | 0.00 |
| folded_key | DeepSeek | 100.0% | 100.0% | 100.0% | 0.0% | 2198 | 2.00 | 1.75 |
| folded_key | GLM | 100.0% | 100.0% | 100.0% | 0.0% | 1913 | 2.00 | 1.13 |
| folded_auto | DeepSeek | 20.8% | 20.8% | 95.8% | 0.0% | 1317 | 1.21 | 0.42 |
| folded_auto | GLM | 29.2% | 29.2% | 95.8% | 0.0% | 1266 | 1.29 | 0.38 |

### B4 difference

| arm | target drill Δ (pp) | correct Δ (pp) | prompt token ratio |
| --- | ---: | ---: | ---: |
| full | +0.0 | -4.2 | 1.04× |
| folded_key | +0.0 | +0.0 | 0.87× |
| folded_auto | +8.3 | +0.0 | 0.96× |

## C3 sweet spot

| targetTokens | model | task success | fact recall | prompt tokens | latency mean | latency p95 | cost total | errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6000 | DeepSeek | 20/20 (100.0%) | 100.0% | 13355 | 4825 ms | 9310 ms | $0.0420 | 0 |
| 6000 | GLM | 20/20 (100.0%) | 100.0% | 14929 | 2608 ms | 6149 ms | $0.0360 | 0 |
| 12000 | DeepSeek | 20/20 (100.0%) | 100.0% | 26595 | 4967 ms | 10776 ms | $0.0816 | 0 |
| 12000 | GLM | 20/20 (100.0%) | 100.0% | 28919 | 2976 ms | 4342 ms | $0.0694 | 0 |
| 24000 | DeepSeek | 20/20 (100.0%) | 100.0% | 53078 | 6526 ms | 11866 ms | $0.1615 | 0 |
| 24000 | GLM | 20/20 (100.0%) | 100.0% | 58103 | 4932 ms | 6137 ms | $0.1392 | 0 |
| 48000 | DeepSeek | 20/20 (100.0%) | 100.0% | 106032 | 8376 ms | 16338 ms | $0.3202 | 0 |
| 48000 | GLM | 20/20 (100.0%) | 100.0% | 117488 | 9434 ms | 23280 ms | $0.2812 | 0 |

### C3 difference

| targetTokens | success Δ (pp) | recall Δ (pp) | prompt token ratio | latency ratio | cost ratio |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 6000 | +0.0 | +0.0 | 1.12× | 0.54× | 0.86× |
| 12000 | +0.0 | +0.0 | 1.09× | 0.60× | 0.85× |
| 24000 | +0.0 | +0.0 | 1.09× | 0.76× | 0.86× |
| 48000 | +0.0 | +0.0 | 1.11× | 1.13× | 0.88× |

## Conclusion

- B4 passive key: folded_key drills the target 100.0% on DeepSeek and 100.0% on GLM (+0.0 pp). Auto-expansion drills 20.8% and 29.2% respectively.
- B4 where it differs: the full arm drops 4.2 pp on GLM because one constraint task (f16) answers the surrounding constraint instead of the asked time; folded_key recovers it by reading the original, so the gap is not in the passive-key path. GLM's two full-arm hallucination flags are the task-id digits 8 and 21 in the reply prose, not invented detail values; the answer lines are correct. Folded_key uses fewer tool calls on GLM (1.13 vs 1.75) and 13% fewer prompt tokens.
- C3: success is flat across 6k–48k on DeepSeek and flat on GLM. Both models show no attention knee, so 6,000 remains the measured optimum on accuracy for both. The token, latency and cost multipliers differ, so keep the route value per model rather than averaging the curves.
- C3 where it differs: accuracy and recall are identical at every band (0.0 pp). GLM counts 9–12% more prompt tokens on the same contexts, is 0.54–0.76× as slow at 6k–24k but 1.13× at 48k, and costs 0.85–0.88× because its list price is lower. The route value is therefore a per-model number even when the accuracy conclusion agrees.
- D5: no rerunnable object; the D group has not landed. Re-run when it does; no number is reported here.

## Limitations

- One second model, one run per cell, temperature 0. Provider nondeterminism can move individual tasks.
- C3 cost is list-price prompt tokens from the harness; it does not apply the cache-read price. #259 covers cache-aware cost on the first model.
- B4 and C3 use the same synthetic corpora as the first-model runs; the second model only changes the `--model` argument.
- The GLM route reports real pricing; a route with no pricing would leave the cost column `—`.

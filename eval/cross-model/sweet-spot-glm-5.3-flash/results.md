# Context sweet spot — #258 C3

- base commit at run: `a09a226e`
- run at: 2026-11-16T12:28:12.029Z
- model: `workbuddy-ai/glm-5.3-flash`
- endpoint: `http://127.0.0.1:3425/v1`
- seed: 258
- tasks: 20 × 5 facts

## What a band means

`targetTokens` is the shell assembler's own unit: it fits a lane to `ceil(chars / 4)`. Each context here is one `<recall-context>` block built to `targetTokens * 4` characters, so the table shows both that shell estimate and the provider's `usage.prompt_tokens`. The five target lines sit at 10/30/50/70/90% depth; the rest are distractors.

A distractor shares at most one cue with a target: the target entity with another attribute, another entity with a target attribute, or neither. No distractor is the target entity+attribute pair, so every question has exactly one correct answer. No dates are attached, so recency cannot be used as a shortcut.

## Results

| targetTokens | context chars | context tokens (chars/4) | prompt tokens (provider) | task success | fact recall | latency mean | latency p95 | cost total | cost/call | errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6000 | 24007 | 6002 | 14929 (14345–15719) | 20/20 (100%) | 100% | 2608 ms | 6149 ms | $0.0360 | $0.0018 | 0 |
| 12000 | 48006 | 12002 | 28919 (27756–30488) | 20/20 (100%) | 100% | 2976 ms | 4342 ms | $0.0694 | $0.0035 | 0 |
| 24000 | 96012 | 24003 | 58103 (55788–61235) | 20/20 (100%) | 100% | 4932 ms | 6137 ms | $0.1392 | $0.0070 | 0 |
| 48000 | 192012 | 48003 | 117488 (112858–123742) | 20/20 (100%) | 100% | 9434 ms | 23280 ms | $0.2812 | $0.0141 | 0 |

Pricing from the gateway's `/v1/models` at run time: prompt $0.12/M, completion $0.42/M.

## Per task

| task | 6000 | 12000 | 24000 | 48000 |
| --- | ---: | ---: | ---: | ---: |
| t01 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t02 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t03 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t04 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t05 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t06 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t07 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t08 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t09 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t10 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t11 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t12 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t13 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t14 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t15 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t16 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t17 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t18 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t19 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |
| t20 | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ | 5/5 ✓ |

## Failures

None.

## Random baseline

A uniform guess over the codes present would have roughly `1/944` chance per fact at the smallest band (the pool grows with fill), and `1/(K·(K−1)·…·(K−4))` for all five in order — effectively zero. The task is extraction, not multiple choice, so success is not inflated by a 25% guess rate.

## Reading

- Task success is flat at 100% across all 4 bands; no knee appears between 6000 and 48000.
- Mean provider prompt tokens grow from 14929 to 117488 (7.9×); total cost grows from $0.0360 to $0.2812 for 20 tasks.
- Mean latency moves from 2608 ms to 9434 ms; at n=20 per band this is a point estimate, not a significance test.

## Conclusion

- No attention knee in 6000–48000: 20/20 tasks and 100% of facts at every band.
- From 6000 to 48000, provider prompt tokens grow 7.9×, total cost 7.8×, and mean latency 3.6×.
- The shell's chars/4 unit undercounts this Chinese corpus by 2.5×: 6000 shell tokens are 14929 provider prompt tokens.
- On this evidence, raising `targetTokens` above 6000 buys no accuracy. Keep 6000 as the provisional route value for `workbuddy-ai/glm-5.3-flash`; the open question is coverage (does 6000 keep the useful lane?), not attention.
- E6 still needs a second model before the per-model value is final, and this experiment always includes the target, so it cannot show that a small budget keeps the useful lane.

## Limitations

- The context is one recall lane sized to the band. The shell's six-lane assembler may drop a whole low-priority lane when the total exceeds `targetTokens`; that product behaviour is not reproduced here, and the target is always present.
- One model only (`auto/deepseek-v4.1-flash`). E6 asks for at least two models before the per-model route value is final.
- `temperature: 0` reduces but does not remove provider nondeterminism; re-running can move individual tasks.
- The band unit is the shell's `chars/4` estimate. Provider tokens are shown separately; do not read the two columns as the same unit.

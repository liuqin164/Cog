# Context sweet spot — #258 C3

- base commit at run: `07c3ec2d`
- run at: 2026-11-16T10:17:26.147Z
- model: `auto/deepseek-v4.1-flash`
- endpoint: `http://127.0.0.1:3425/v1`
- seed: 258
- tasks: 20 × 5 facts

## What a band means

`targetTokens` is the shell assembler's own unit: it fits a lane to `ceil(chars / 4)`. Each context here is one `<recall-context>` block built to `targetTokens * 4` characters, so the table shows both that shell estimate and the provider's `usage.prompt_tokens`. The five target lines sit at 10/30/50/70/90% depth; the rest are distractors.

A distractor shares at most one cue with a target: the target entity with another attribute, another entity with a target attribute, or neither. No distractor is the target entity+attribute pair, so every question has exactly one correct answer. No dates are attached, so recency cannot be used as a shortcut.

## Results

| targetTokens | context chars | context tokens (chars/4) | prompt tokens (provider) | task success | fact recall | latency mean | latency p95 | cost total | cost/call | errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6000 | 24007 | 6002 | 13355 (12759–14097) | 20/20 (100%) | 100% | 4825 ms | 9310 ms | $0.0420 | $0.0021 | 0 |
| 12000 | 48006 | 12002 | 26595 (25416–28072) | 20/20 (100%) | 100% | 4967 ms | 10776 ms | $0.0816 | $0.0041 | 0 |
| 24000 | 96012 | 24003 | 53078 (50732–56027) | 20/20 (100%) | 100% | 6526 ms | 11866 ms | $0.1615 | $0.0081 | 0 |
| 48000 | 192012 | 48003 | 106032 (101351–111925) | 20/20 (100%) | 100% | 8376 ms | 16338 ms | $0.3202 | $0.0160 | 0 |

Pricing from the gateway's `/v1/models` at run time: prompt $0.15/M, completion $0.60/M.

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
- Mean provider prompt tokens grow from 13355 to 106032 (7.9×); total cost grows from $0.0420 to $0.3202 for 20 tasks.
- Mean latency moves from 4825 ms to 8376 ms; at n=20 per band this is a point estimate, not a significance test.

## Conclusion

- No attention knee in 6000–48000: 20/20 tasks and 100% of facts at every band.
- From 6000 to 48000, provider prompt tokens grow 7.9×, total cost 7.6×, and mean latency 1.7×.
- The shell's chars/4 unit undercounts this Chinese corpus by 2.2×: 6000 shell tokens are 13355 provider prompt tokens.
- On this evidence, raising `targetTokens` above 6000 buys no accuracy. Keep 6000 as the provisional route value for `auto/deepseek-v4.1-flash`; the open question is coverage (does 6000 keep the useful lane?), not attention.
- E6 still needs a second model before the per-model value is final, and this experiment always includes the target, so it cannot show that a small budget keeps the useful lane.

## Limitations

- The context is one recall lane sized to the band. The shell's six-lane assembler may drop a whole low-priority lane when the total exceeds `targetTokens`; that product behaviour is not reproduced here, and the target is always present.
- One model only (`auto/deepseek-v4.1-flash`). E6 asks for at least two models before the per-model route value is final.
- `temperature: 0` reduces but does not remove provider nondeterminism; re-running can move individual tasks.
- The band unit is the shell's `chars/4` estimate. Provider tokens are shown separately; do not read the two columns as the same unit.

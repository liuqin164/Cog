# Context sweet spot, discriminating corpus — #293

- base commit at run: `f74b3b2b`
- run at: 2026-11-17T06:09:43.143Z
- model: `auto/deepseek-v4.1-flash`
- endpoint: `http://127.0.0.1:3425/v1`
- seed: 258
- tasks: 8 × 1 target code (multihop, similar, longtool, session)

## What a band means

`targetTokens` is the shell assembler's own unit: it fits a lane to `ceil(chars / 4)`. Each context here is one `<recall-context>` block built to `targetTokens * 4` characters, so the table shows both that shell estimate and the provider's `usage.prompt_tokens`. The anchors sit at fixed relative depths per shape: the session target at 1.5%, the long-tool block mid-dump, the hop lines at 8% and 55%; the rest is filler.

The four hard shapes are two-hop chains (the first hop names the second entity), near-duplicate codes and entity names, one multi-thousand-token tool output per task, and 200+ turn sessions with the target near the start. Each question still has exactly one correct code, so a wrong-but-near code counts as a failure.

## Results

| targetTokens | context chars | context tokens (chars/4) | prompt tokens (provider) | task success | fact recall | latency mean | latency p95 | cost total | cost/call | errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6000 | 24017 | 6005 | 13629 (12977–14347) | 8/8 (100%) | 100% | 4040 ms | 9865 ms | $0.0168 | $0.0021 | 0 |
| 12000 | 48013 | 12004 | 27770 (25838–30834) | 8/8 (100%) | 100% | 4423 ms | 7930 ms | $0.0339 | $0.0042 | 0 |
| 24000 | 96015 | 24004 | 56055 (51562–64054) | 8/8 (100%) | 100% | 6354 ms | 15323 ms | $0.0678 | $0.0085 | 0 |
| 48000 | 192011 | 48003 | 99400 (8187–130494) | 8/8 (100%) | 100% | 8496 ms | 19371 ms | $0.1197 | $0.0150 | 0 |

### By shape

| shape | 6000 | 12000 | 24000 | 48000 |
| --- | ---: | ---: | ---: | ---: |
| multihop | 2/2 | 2/2 | 2/2 | 2/2 |
| similar | 2/2 | 2/2 | 2/2 | 2/2 |
| longtool | 2/2 | 2/2 | 2/2 | 2/2 |
| session | 2/2 | 2/2 | 2/2 | 2/2 |

Pricing from the gateway's `/v1/models` at run time: prompt $0.15/M, completion $0.60/M.

## Per task

| task | 6000 | 12000 | 24000 | 48000 |
| --- | ---: | ---: | ---: | ---: |
| mh01 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |
| mh02 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |
| sm01 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |
| sm02 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |
| lt01 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |
| lt02 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |
| se01 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |
| se02 | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ | 1/1 ✓ |

## Failures

None.

## Random baseline

A uniform guess over the codes present would have roughly `1/889` chance per fact at the smallest band (the pool grows with fill), so a blind pick is effectively zero. The task is extraction, not multiple choice, so success is not inflated by a 25% guess rate.

## Reading

- Task success is flat at 100% across all 4 bands; no knee appears between 6000 and 48000.
- Mean provider prompt tokens grow from 13629 to 99400 (7.3×); total cost grows from $0.0168 to $0.1197 for 8 tasks.
- Mean latency moves from 4040 ms to 8496 ms; at n=8 per band this is a point estimate, not a significance test.

## Conclusion

- Even on the hard corpus, task success is flat in 6000–48000: 8/8 tasks and 100% of facts at every band.
- From 6000 to 48000, provider prompt tokens grow 7.3×, total cost 7.1×, and mean latency 2.1×.
- The shell's chars/4 unit undercounts this Chinese corpus by 2.3×: 6000 shell tokens are 13629 provider prompt tokens.
- On this evidence, raising `targetTokens` above 6000 buys no accuracy even on the discriminating corpus. Keep 6000 as the provisional route value for `auto/deepseek-v4.1-flash`; the open question is coverage (does 6000 keep the useful lane?), not attention.
- E6 still needs a second model before the per-model value is final, and this experiment always includes the target, so it cannot show that a small budget keeps the useful lane.

## Limitations

- The context is one recall lane sized to the band. The shell's six-lane assembler may drop a whole low-priority lane when the total exceeds `targetTokens`; that product behaviour is not reproduced here, and the target is always present.
- One model only (`auto/deepseek-v4.1-flash`). E6 asks for at least two models before the per-model route value is final.
- `temperature: 0` reduces but does not remove provider nondeterminism; re-running can move individual tasks.
- The band unit is the shell's `chars/4` estimate. Provider tokens are shown separately; do not read the two columns as the same unit.

## Recheck of the one anomalous usage sample

`se02 @ 48000` reported 8,187 provider prompt tokens for a 192,022-character context, which no tokenizer explains; every other 48k cell reported 100k–130k tokens. The band was re-run on 2026-11-17: `se02` reported 113,976 prompt tokens, answered correctly, and all eight tasks passed again. The cell is a gateway/usage-accounting outlier, not a long-context success; the flat-success conclusion does not rest on it.

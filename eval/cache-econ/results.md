# Cache economics of fold strategies — #259 C4

- base commit at run: `a09a226e9345`
- run at: 2026-11-16T12:19:27.491Z
- model: `auto/deepseek-v4.1-flash` through `http://127.0.0.1:3425/v1`
- sessions: 4 × 23 pairs + final question
- fold window: last 6 pairs kept verbatim; boundary batch: every 6 pairs
- temperature: 0; fixed ledger; scripted assistant replies; one command: `bun eval/cache-econ/run.ts`

## Corpus

- Four sessions, one per detail type (number, name, constraint, step). The target detail is in pair 2; two same-type distractors are in pairs 12 and 21; the rest are filler paragraphs.
- The final no-fold projection is about 23.5k characters, the C3 provisional 6,000 shell tokens; the provider counts it as about 14.5k prompt tokens.
- The assistant replies are scripted and the ledger is identical across arms. The model is called once per pair with the arm-specific projection; its replay reply is discarded, so only the projection differs.
- Fold stubs use the kernel `SessionDigest` shape: entryId (key), an exact prefix quote of the pair user turn, and sourceRefs. The value is only in the omitted suffix; folded arms can call `read_memory`.
- Random baseline: the final question has one target among three same-type detail pairs; a blind pick is 33.3%, and a random string matches no answer.

## Results

| arm | sessions | correct | hallucinated | turns | avg context chars | avg context tokens (chars/4) | prompt tokens | cache hit | cache miss | cache hit rate | completion tokens | total cost | cost/session | cost/turn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| no_fold | 4 | 4/4 | 0 | 96 | 12709 | 3177 | 755278 | 653824 | 101454 | 86.6% | 6079 | $0.020827 | $0.005207 | $0.000217 |
| per_turn | 4 | 4/4 | 0 | 96 | 6931 | 1733 | 487460 | 133120 | 354340 | 27.3% | 11964 | $0.060729 | $0.015182 | $0.000633 |
| boundary | 4 | 4/4 | 0 | 96 | 8663 | 2166 | 616564 | 512256 | 104308 | 83.1% | 14216 | $0.025713 | $0.006428 | $0.000268 |

Pricing from the gateway's `/v1/models` at run time: prompt $0.15/M, cache read $0.003/M, completion $0.60/M.

## Scale at the final question

| arm | final context chars | final context tokens (chars/4) | final prompt tokens (provider) | final model calls | final tool calls | final cache hit rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| no_fold | 23491 | 5873 | 14541 | 1.00 | 0.00 | 97.7% |
| per_turn | 7786 | 1947 | 10825 | 2.00 | 1.75 | 53.8% |
| boundary | 12538 | 3135 | 16571 | 2.00 | 1.25 | 93.8% |

The final prompt-token column sums every call in the final turn. The folded arms call `read_memory` on the final question, so they resend the context in a follow-up call; the no-fold arm answers in one call. That is a real cost of the fold path, not a counting artifact.

## Per session

| session | arm | correct | prompt tokens | cache hit rate | total cost |
| --- | --- | ---: | ---: | ---: | ---: |
| c01-number | no_fold | ✓ | 188785 | 83.8% | $0.006025 |
| c01-number | per_turn | ✓ | 132226 | 28.0% | $0.016686 |
| c01-number | boundary | ✓ | 159933 | 83.6% | $0.007324 |
| c02-name | no_fold | ✓ | 188500 | 91.3% | $0.003585 |
| c02-name | per_turn | ✓ | 120113 | 29.7% | $0.014464 |
| c02-name | boundary | ✓ | 156354 | 83.5% | $0.005872 |
| c03-constraint | no_fold | ✓ | 188895 | 91.5% | $0.003782 |
| c03-constraint | per_turn | ✓ | 114912 | 26.7% | $0.014063 |
| c03-constraint | boundary | ✓ | 157610 | 82.4% | $0.006649 |
| c04-step | no_fold | ✓ | 189098 | 79.7% | $0.007435 |
| c04-step | per_turn | ✓ | 120209 | 24.7% | $0.015516 |
| c04-step | boundary | ✓ | 142667 | 82.8% | $0.005868 |

## Cost by turn

| turn | no_fold | per_turn | boundary |
| ---: | ---: | ---: | ---: |
| 1 | $0.000180 | $0.000231 | $0.000229 |
| 2 | $0.000196 | $0.000225 | $0.000236 |
| 3 | $0.000146 | $0.000156 | $0.000205 |
| 4 | $0.000199 | $0.000242 | $0.000139 |
| 5 | $0.000171 | $0.000183 | $0.000150 |
| 6 | $0.000164 | $0.000160 | $0.000161 |
| 7 | $0.000226 | $0.000314 | $0.000179 |
| 8 | $0.000205 | $0.000739 | $0.000219 |
| 9 | $0.000141 | $0.000758 | $0.000197 |
| 10 | $0.000139 | $0.000798 | $0.000185 |
| 11 | $0.000246 | $0.000746 | $0.000187 |
| 12 | $0.000282 | $0.001107 | $0.000183 |
| 13 | $0.000181 | $0.000818 | $0.000844 |
| 14 | $0.000187 | $0.000813 | $0.000281 |
| 15 | $0.000476 | $0.000794 | $0.000207 |
| 16 | $0.000302 | $0.000710 | $0.000308 |
| 17 | $0.000170 | $0.000731 | $0.000209 |
| 18 | $0.000301 | $0.001062 | $0.000269 |
| 19 | $0.000261 | $0.000745 | $0.000802 |
| 20 | $0.000186 | $0.000737 | $0.000178 |
| 21 | $0.000205 | $0.000816 | $0.000279 |
| 22 | $0.000221 | $0.000712 | $0.000272 |
| 23 | $0.000279 | $0.000721 | $0.000216 |
| 24 (final) | $0.000140 | $0.000864 | $0.000293 |

## Net account

- No-fold is the baseline at $0.020827; per-turn fold costs $0.060729 (191.6%) and boundary fold costs $0.025713 (23.5%).
- Boundary folding is not cheaper than no-fold: it costs $0.004886 more (23.5%). Per the ticket's failure route, C1 should change or raise the fold threshold rather than treat boundary folding as a saving on this session shape.
- Cache hit rate is 86.6% (no-fold), 27.3% (per-turn) and 83.1% (boundary). The hit rate is the mechanism: a changed digest invalidates the whole suffix after it, so the arm that changes it least keeps the most of the prompt at the cache-read price.
- A cache miss costs 50× a cache read on this route ($0.15/M vs $0.003/M). A fold therefore has to save 50× the tokens it invalidates before it breaks even; boundary folding saves 18.4% of prompt tokens but pays the miss price on the changed suffix at every boundary, so it does not. Raising the fold threshold well above 6k, or keeping no-fold, is the cost-supported choice; folding remains a capacity measure, not a saving.
- Per-turn folding is the most expensive arm at $0.060729; it saves tokens but pays the miss price on the recent window every turn.
- Per-session boundary vs no-fold: c01-number 21.6%, c02-name 63.8%, c03-constraint 75.8%, c04-step -21.1%. Boundary is cheaper in the session(s) where the no-fold arm happened to miss more cache; the aggregate is the decision number, not the best session.

## Failures

- none

## What this measures, and what it does not

- It measures the projection + provider cache, not the product pipeline: the harness supplies the fold, the key and the drill action.
- The ledger is a replay: assistant replies are scripted so all arms see the same text. A live agent would append its own replies, which changes the prefix and can change cache behaviour.
- The digest is append-only and deterministic. A fold that rewrites the digest each turn would invalidate more prefix than the per-turn arm does here; this is the cache-friendly end of per-turn folding.
- Cache hits are the provider's report (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens` or `cached_tokens`). A provider that reports no cache field is recorded as all-miss, not as zero cost.
- One model route and four synthetic sessions; the absolute dollars are small. The result is a direction and a mechanism, not a universal price list.

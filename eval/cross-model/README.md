# Cross-model retest (#269 E6)

The second-model rows for B4 and C3 reuse the existing harnesses unchanged:

```bash
bun eval/fold-drill/run.ts --model workbuddy-ai/glm-5.3-flash \
  --out-dir eval/cross-model/fold-drill-glm-5.3-flash
bun eval/sweet-spot/run.ts --model workbuddy-ai/glm-5.3-flash \
  --out-dir eval/cross-model/sweet-spot-glm-5.3-flash
bun eval/cross-model/compare.ts
```

`workbuddy-ai/glm-5.3-flash` is the chosen second model: a GLM family route,
not DeepSeek, reachable at the mg gateway, tool-capable, and priced by
`/v1/models`. `group/n-550` was unreachable (the upstream model is end-of-life).

D5 is named in the ticket but not rerun: the D group has not landed, so there is
no rerunnable object. The comparison says so in one line.

`compare.ts` reads the first-model `results.json` files in `eval/fold-drill/`
and `eval/sweet-spot/` plus the two second-model files above, and writes
`results.md`. It does not call a model and does not average the two models.

# Associative recall — #355

- corpus: 40 synthetic facts; 24 cues (16 positive, 8 negative); k=3
- embedding: `Xenova/bge-base-zh-v1.5` (768d); semanticIndex=true
- companion arm: `CompanionShell.submit()` -> assembled `<COGMEM_RECALL_CONTEXT>` block; vector arm: cosine top-k over the same facts

| arm | hit rate | precision | false-positive ratio | negative surfaced | tokens/cue | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| companion recall lane | 62.5% | 20.4% | 67.4% | 62.5% | 27.6 | 428.0 | 743.0 |
| vector top-k | 62.5% | 13.9% | 86.1% | 100.0% | 39.8 | 116.0 | 360.0 |

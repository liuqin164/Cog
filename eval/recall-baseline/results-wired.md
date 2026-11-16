# Recall through the wired path — #250

- model: `Xenova/bge-base-zh-v1.5` (768d), semanticIndex=true
- load: 513 ms; 30 queries: 6842 ms; RSS 475 MiB; peak 516 MiB
- reEmbed: first 0 processed / 0 remaining; second 0 / 0

| corpus | recall@1 | recall@5 |
| --- | ---: | ---: |
| memory (n=20) | 65.0% | 95.0% |
| memory — kernel evidence lane (n=20) | 75.0% | 95.0% |
| procedure (n=10) | 70.0% | 90.0% |
| all (n=30) | 66.7% | 93.3% |

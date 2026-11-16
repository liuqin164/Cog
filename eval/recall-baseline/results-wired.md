# Recall through the wired path — #250

- model: `Xenova/bge-base-zh-v1.5` (768d), semanticIndex=true
- load: 594 ms; 30 queries: 4825 ms; RSS 675 MiB; peak 678 MiB
- reEmbed: first 0 processed / 0 remaining; second 0 / 0

| corpus | recall@1 | recall@5 |
| --- | ---: | ---: |
| memory (n=20) | 10.0% | 30.0% |
| memory — kernel evidence lane (n=20) | 75.0% | 95.0% |
| procedure (n=10) | 20.0% | 20.0% |
| all (n=30) | 13.3% | 26.7% |

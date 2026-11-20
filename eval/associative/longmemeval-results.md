# LongMemEval — #355

- data: `longmemeval_s_cleaned.json`
- sample: 20 questions (sort by question_id, step=floor(n/limit), take limit), k=5
- embedding: `Xenova/bge-base-zh-v1.5`
- answering: auto/deepseek-v4.1-flash (observed: group/auto-deepseek-v4-1-flash)

| question type | n | retrieval hit | accuracy |
| --- | ---: | ---: | ---: |
| single-session-user | 5 | 40.0% | 40.0% |
| temporal-reasoning | 8 | 87.5% | 62.5% |
| knowledge-update | 2 | 100.0% | 100.0% |
| multi-session | 3 | 66.7% | 33.3% |
| single-session-preference | 1 | 0.0% | 0.0% |
| single-session-assistant | 1 | 100.0% | 100.0% |
| all | 20 | 70.0% | 55.0% |

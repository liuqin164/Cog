# Recall baseline — #250 A6

- base commit at run: `d557ee114ad8` (the corpus and harness are committed on this tree)
- run at: 2026-11-16T06:26:48.167Z
- bun: 1.3.14 · linux/arm64

## Corpus

- 30 Chinese paraphrase queries: 20 memory targets, 10 procedure targets.
- Every query was checked to contain none of its target's `keyTerms`; the check is in `run.ts`.
- Max deterministic cosine between memory targets: 0.9378 (m09/m20); below the 0.98 write-path dedup threshold, so all 20 survived as separate neurons.
- Seed write order is a fixed SHA-256 shuffle, not the corpus order, so recency is not aligned with the query list.

## Results

| corpus | arm | recall@1 | recall@5 |
| --- | --- | ---: | ---: |
| memory (n=20) | rule_only | 10.0% | 30.0% |
| memory (n=20) | fts_trigram | 5.0% | 5.0% |
| memory (n=20) | embedding | 80.0% | 95.0% |
| procedure (n=10) | rule_only | 20.0% | 20.0% |
| procedure (n=10) | fts_trigram | 0.0% | 0.0% |
| procedure (n=10) | embedding | 60.0% | 90.0% |
| all (n=30) | rule_only | 13.3% | 26.7% |
| all (n=30) | fts_trigram | 3.3% | 3.3% |
| all (n=30) | embedding | 73.3% | 93.3% |

Chance for a random ranker: memory @1 5.0%, @5 25.0%; procedure @1 10.0%, @5 50.0% (the procedure pool is 10 because `PROCEDURE_RECALL_MAX` caps a page at 10).

## Reading the table

- On memories, `rule_only` answered 2/20 at rank 1 and 6/20 at top 5; the lane returns a recency-ordered window, so a paraphrase is mostly found by position, not by its words.
- Trigram only wins when a three-character run survives the rewrite: one memory hit (m14, via the shared "不能手") and no procedure hit. A true paraphrase often shares no such run.
- Embedding kept 19/20 memories in the top 5 and 9/10 procedures; its only top-5 misses are listed below.

## Failures (rank > 5 or not returned)

### rule_only

- `m01` (memory, rank 18) — query: 查一下各条业务线的例行碰头定在哪个半天、什么时刻，地点是哪间屋子。 — target: 每周三下午两点在 3 号会议室开产品同步会。
- `p01` (procedure, not returned) — query: 要把这次改动正式交给用户，按顺序该做哪些动作？ — target: 发布新版本（发布/release）: 跑全量测试 → 构建产物 → 打标签 → 推送仓库
- `m03` (memory, rank 10) — query: 弄清这个计划的内部叫法是什么，跟外部沟通时该用哪个说法。 — target: 项目代号是“青岚”，对外一律使用这个称呼。

### fts_trigram

- `m01` (memory, not returned) — query: 查一下各条业务线的例行碰头定在哪个半天、什么时刻，地点是哪间屋子。 — target: 每周三下午两点在 3 号会议室开产品同步会。
- `p01` (procedure, not returned) — query: 要把这次改动正式交给用户，按顺序该做哪些动作？ — target: 发布新版本（发布/release）: 跑全量测试 → 构建产物 → 打标签 → 推送仓库
- `m02` (memory, not returned) — query: 确认线上库的历史副本最多留多久，过期后会被怎么处理。 — target: 生产数据库的备份保留 90 天，超期自动清理。

### embedding

- `m01` (memory, rank 8) — query: 查一下各条业务线的例行碰头定在哪个半天、什么时刻，地点是哪间屋子。 — target: 每周三下午两点在 3 号会议室开产品同步会。
- `p02` (procedure, rank 6) — query: 服务出问题后怎么退回到之前能用的那版？ — target: 线上回滚（事故/rollback）: 确认影响范围 → 切回上一个稳定版本 → 通知值班 → 补事故记录

## Embedding model and memory

- model: `Xenova/bge-base-zh-v1.5` (quantized ONNX; 102M parameters, 768 dimensions)
- source: https://huggingface.co/Xenova/bge-base-zh-v1.5
- query instruction: `为这个句子生成表示以用于检索相关文章：` (applied to queries only; documents are embedded as written)
- cache: `<worktree>/.cogmem/recall-baseline/models` (gitignored); first run downloads, later runs reuse it.
- on-disk size: 99 MiB total
  - `Xenova/bge-base-zh-v1.5/onnx/model_quantized.onnx`: 98 MiB
  - `Xenova/bge-base-zh-v1.5/tokenizer.json`: 429 KiB
  - `Xenova/bge-base-zh-v1.5/config.json`: 938 B
  - `Xenova/bge-base-zh-v1.5/tokenizer_config.json`: 366 B
- load: 508 ms (warm cache); index: 2090 ms; 20+10 queries: 3202 ms
- RSS before model: 81 MiB; after load: 468 MiB; after index: 514 MiB; after queries: 561 MiB
- peak RSS (VmHWM): 561 MiB; resident increment after queries: +480 MiB; peak increment: +480 MiB
- dimensions: 768; process bound: `ulimit -v 16777216 KB` + 2.0 GiB RSS watchdog

## What this measures, and what it does not

- `rule_only` is the real shell path: `KernelAgentMemoryBackend.recall()` for memories and `ProcedureCompiler.recall()` for practices.
- The memory recall was asked for 20 items to expose ranks beyond the shell's default `limit: 3`; the procedure pool is capped at 10 by the product.
- `fts_trigram` is SQLite FTS5 `tokenize='trigram'` over the same target texts, queried as an OR of the query's trigrams and ranked by bm25.
- `embedding` is a local vector ranker, not wired into the product. No product code was changed in this round.
- Decision (enable embedding / keep lexical + change the procedure vocabulary) is Ryu's in #250; this file only reports the measurement.

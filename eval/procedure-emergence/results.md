# Procedure emergence A/B — #265 D5

- base commit at run: `f74b3b2b51f4`
- run at: 2026-11-17T06:52:17.110Z
- model: `auto/deepseek-v4.1-flash` through `http://127.0.0.1:3425/v1`
- tasks: 10; each is run first (no practice), then twice on the repeat prompt (without and with the practice)
- tools: the shell's `read` / `write` / `edit` / `bash` / `declare_task`, with the production descriptions

## 1. Producer trigger rate

| task | declare start | declare end | domain | key | correct | rounds | tool calls | tool errors | prompt tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 购物清单 | no | yes | file authoring | create-and-verify-shopping-list | yes | 4 | 2 | 0 | 5008 |
| 礼物清单 | no | yes | file authoring | three-line gift list file | yes | 4 | 2 | 0 | 5020 |
| 错误行统计 | no | yes | log analysis | count-error-lines | yes | 7 | 5 | 1 | 10036 |
| TODO 提取 | no | no | — | — | yes | 3 | 2 | 0 | 3723 |
| TSV 转 CSV | no | yes | data conversion | tsv-to-csv | yes | 6 | 5 | 1 | 8607 |
| 配置键改名 | no | no | — | — | yes | 7 | 6 | 3 | 9865 |
| JSON 合并 | no | yes | data-merge | json-merge-right-wins | yes | 7 | 7 | 2 | 10816 |
| 标题汇总 | no | no | — | — | yes | 4 | 5 | 1 | 5228 |
| 修复脚本 | no | no | — | — | yes | 12 | 13 | 4 | 20930 |
| 文本文件清单 | no | yes | file management | list-txt-filenames-sorted | yes | 7 | 7 | 3 | 10087 |

- Runs that ended with `declare_task end` **and** a domain+key: **6/10 (60.0%)**.
- Runs that ended with `declare_task end` at all: 6/10; `declare_task start`: 0/10.
- Task completion without any declaration: 4/10.

## 2. Deterministic fallback descriptor

| task | derived domain | derived key | steps | tools | declared instead |
| --- | --- | --- | --- | --- | --- |
| 购物清单 | file-edit | 在工作目录创建shoppingtxt写三行牛奶鸡 | 2 | write, read | file authoring/create-and-verify-shopping-list |
| 礼物清单 | file-edit | 创建gifttxt写三行礼物围巾茶杯书写完确认一 | 2 | write, read | file authoring/three-line gift list file |
| 错误行统计 | shell | 统计logtxt里含ERROR的行数把数字写进e | 5 | bash, read, write | log analysis/count-error-lines |
| TODO 提取 | file-edit | 把notesmd里所有TODO行提取到todom | 2 | read, write | — |
| TSV 转 CSV | shell | 把datatsv转成datacsv逗号分隔保留表 | 5 | bash, read, write | data conversion/tsv-to-csv |
| 配置键改名 | shell | 把configjson里的键retry_limi | 6 | read, edit, bash | — |
| JSON 合并 | shell | 合并ajson和bjson成mergedjson | 7 | bash, read, write | data-merge/json-merge-right-wins |
| 标题汇总 | shell | 提取amdbmdcmd的一级标题到summary | 5 | bash, read, write | — |
| 修复脚本 | shell | runsh运行失败了修好它让它能用bashrun | 13 | bash, read, write | — |
| 文本文件清单 | shell | 把工作目录里所有txt文件名按字母顺序写进lis | 7 | bash, write, read | file management/list-txt-filenames-sorted |

- Tool calls were captured for 10/10 tasks, so steps and tools are derivable without a declaration.
- The domain and key are not in the trajectory; the fallback takes the domain from the tool mix and the key from the first user line. Declared entries were available for 6/10 tasks.

## 3. Recall by the real compiler

| task | declared entry surfaced | rank | derived entry surfaced | rank | others in lane |
| --- | --- | --- | --- | --- | --- |
| 购物清单 | yes | 4 | yes | 5 | 4 |
| 礼物清单 | yes | 3 | yes | 4 | 4 |
| 错误行统计 | yes | 2 | yes | 3 | 4 |
| TODO 提取 | no | — | yes | 2 | 1 |
| TSV 转 CSV | yes | 2 | yes | 1 | 0 |
| 配置键改名 | no | — | yes | 2 | 1 |
| JSON 合并 | yes | 1 | yes | 1 | 1 |
| 标题汇总 | no | — | yes | 1 | 1 |
| 修复脚本 | no | — | yes | 2 | 7 |
| 文本文件清单 | yes | 1 | yes | 1 | 5 |

- The declared entry (when one existed) was recalled for **6/6** repeat prompts, ranked first for **2/6**.
- The derived entry was recalled for **10/10** repeat prompts, and ranked first for **4/10**.
- The lane carried at least one other task's entry in **9/10** cases, which is what cue matching without a model does at ten entries.

## 4. A/B on the repeat prompt

| task | off correct | on correct | off tokens | on tokens | off rounds | on rounds | off tools | on tools | off errors | on errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 购物清单 | yes | yes | 7990 | 5333 | 6 | 4 | 4 | 2 | 2 | 0 |
| 礼物清单 | yes | yes | 6441 | 5322 | 5 | 4 | 3 | 2 | 2 | 0 |
| 错误行统计 | yes | yes | 8612 | 9385 | 6 | 6 | 6 | 5 | 2 | 1 |
| TODO 提取 | yes | yes | 5588 | 5649 | 4 | 4 | 3 | 2 | 0 | 0 |
| TSV 转 CSV | yes | yes | 10839 | 9728 | 7 | 6 | 7 | 5 | 2 | 1 |
| 配置键改名 | yes | yes | 8881 | 11015 | 6 | 7 | 6 | 6 | 2 | 2 |
| JSON 合并 | yes | yes | 10463 | 11733 | 7 | 7 | 8 | 6 | 3 | 2 |
| 标题汇总 | no | yes | 10462 | 11492 | 7 | 7 | 7 | 7 | 1 | 1 |
| 修复脚本 | yes | yes | 8595 | 24512 | 6 | 12 | 6 | 11 | 2 | 1 |
| 文本文件清单 | yes | yes | 9495 | 12979 | 7 | 8 | 6 | 6 | 1 | 2 |

- The "on" arm showed the declared entry where one existed (6/10), otherwise the derived fallback.
- Correct: **9/10** without the practice, **10/10** with it.
- Prompt tokens: **87366** vs **107148** (with/without = 122.6%).
- Paired per-task delta: median 9.8%; cheaper in 3/10 tasks, dearer in 6/10 (beyond ±2%).
- Mean rounds: 6.10 vs 6.50; mean tool calls: 5.60 vs 5.20; tool errors: 17 vs 10.
- Reference: the first attempt (first prompt, no practice) averaged 8932 tokens and 6.10 rounds; the repeat without the practice averaged 8737 tokens, so repetition alone is not the saving being measured.

## Conclusion

- The producer fired on 6/10 runs; the book is not empty, but the ticket's question is still whether the surfaced practice pays.
- Deterministic fallback: steps and tools are recoverable from the trajectory in 10/10 runs, so the silent case is not "nothing to record". The domain/key still need a deterministic source; the first-user-line key was recalled by the real compiler for 10/10 repeat prompts.
- A/B: correctness 9/10 vs 10/10, prompt tokens +22.6%, rounds 0.40.
- Tool errors fell from 17 to 10 with the practice, the one direction it consistently helped; at ten tasks and one sample this is a weak signal, not a promotion case.
- Bound: ten small file/shell chores, one model, one sample per cell, and a harness that only emulates the shell's tool loop. A practice that pays on larger or repeated tasks is not excluded.

## What this does not measure

- The real shell's lane assembly, budget drops and caching are not reproduced; the practice is injected as one `<procedure-lane>` block.
- `declare_task` is offered exactly as the product offers it, but the open assignment is opened by the harness before the first turn, the way the shell does from the user's line.
- The derived fallback is a candidate descriptor, not a settled implementation. It is measured here to size the work, not wired into the product.

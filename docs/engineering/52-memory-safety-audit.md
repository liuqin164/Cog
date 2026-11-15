# 52-memory-safety 审计（#226）

审计基线：`main` @ `523eb4c`。行号是**改动前**的位置；带「修」的项在同一轮已经落到后面的提交里。
口径：常驻进程 = `cogmem-companion.service` 跑的那一个 Node/Bun 进程（shell + kernel 同进程）。
TUI 是独立进程，但常驻侧还留着 `AttachServer.mirror`（同一个 `TuiView`），所以一起算。

## 结论

- 发现并修掉 **4 个 shell 侧无界结构**：attach/TUI 转录、recall 每回合去重 Map、`shell-events.jsonl`、`service.log`。
- 发现 **1 个内核侧慢增长**（软删除墓碑仍留在内存索引里）：按红线**只在票上报告，没有改内核**，等 Susan 定。
- 其余常驻结构都有明确上限；SQLite page cache 用默认值（2 MiB/连接），没有应用侧预编译语句表，向量检索不建内存索引。

## A. Shell 常驻结构

| # | 结构 | 上限位置（或缺口） | 结论 |
|---|---|---|---|
| A1 | 流转历史 `checkpoint.history` | `shell/src/state/checkpoint.ts:158`（200 条）+ `:278` 截断 | 有界 |
| A2 | `awayQueue`（无人时的浮现队列） | `shell/src/presence.ts:90`（50 条）+ `:94` 截断 | 有界 |
| A3 | 已结算命令提议 | `shell/src/proposals.ts:55`（64 条 / 24h）+ `:101` 惰性清理 | 有界 |
| A4 | 插件工具/命令/服务注册表 | `shell/src/plugins/host.ts:133,194,278`；只在 `start()` 注册一次 | 有界（注册数） |
| A5 | 事件总线监听器 | `shell/src/bus.ts:38`；`on()` 返回退订函数，`AttachServer` 有 `started` 闸门 | 有界（注册数） |
| A6 | attach 连接集合 | `shell/src/attach/server.ts:111`；`close`/`error` 时删除（`:172-176`） | 有界（当前连接数） |
| A7 | **attach 的镜像转录** | `shell/src/attach/server.ts:109` 的 `mirror = new TuiView()`；`TuiView.push` 只追加（`shell/src/tui/view.ts:411-414`），常驻进程从不渲染/清空 `dirty` | **无界 → 修**：转录上限 500 条，`dirty` 随裁剪丢弃 |
| A8 | TUI 进程自己的转录 | 同一个 `TuiView`（`shell/src/tui/view.ts:123`） | **同上 → 修**（A7 的常量同时约束 TUI 进程） |
| A9 | TUI 输入历史 | `shell/src/tui/editor.ts:25,62`（200 条） | 有界（票面说的“200”是这一项，不是转录） |
| A10 | **recall 去重 Map** | `shell/src/plugins/recall.ts:33` 按 `runId` 建 `Map<string, Set<string>>`，只在 `dispose` 清空（`:62`），每个回合永久留一条 | **无界 → 修**：只保留当前 run 的集合，run 切换即丢 |
| A11 | capture 回合缓冲 | `shell/src/plugins/capture.ts:225`；`agent_end` 里 `buffers.delete(runId)`（`:272-277`），`agent_end` 在 `try/finally` 之后必发 | 有界（一个活跃回合） |
| A12 | web 缓存 | `shell/src/plugins/web.ts:28-30`（64 条 / 32 MiB / 1h）+ `:356` 写入/读取时修剪；在盘上，不在内存 | 有界 |
| A13 | web 单次抓取 | `MAX_HTML_BYTES` 5 MiB、`MAX_OUTPUT_CHARS` 30k（`shell/src/plugins/web.ts:31-32`） | 有界（单次） |
| A14 | 每次运行的消息投影 | `shell/src/state/agent-loop.ts:389` 每回合新建，回合结束可回收 | 无跨回合驻留 |
| A15 | 工具调用/结果累积 | `shell/src/state/agent-loop.ts` 的 `allToolCalls/allToolResults` 属于单次运行；`MAX_NESTED_TOOL_DEPTH` 8（`:129`） | 有界（单次） |
| A16 | steering / follow-up 队列 | `shell/src/state/agent-loop.ts:311-313`；在回合边界排空，且落 checkpoint | 有界（用户输入量；无程序化增长） |
| A17 | `trace.reportedDamage` | `shell/src/trace.ts:40`；只收当前日志里损坏行的偏移 | 有界（A18 轮转后） |
| A18 | **`shell-events.jsonl`** | `shell/src/trace.ts:42-53` 只追加，无轮转、无上限 | **无界 → 修**：8 MiB 轮转，保留 1 代 `.1` |
| A19 | **`service.log`** | `shell/src/install/service.ts:106-107`（systemd `append:`）；launchd `StandardOutPath`（`:146-149`）；无 logrotate | **无界 → 修**：运行中按 8 MiB copytruncate，保留 `.1` |
| A20 | 终端通道 | `shell/src/channels/terminal.ts` 无累积；readline 单行 | 无驻留 |
| A21 | HTTP face / observatory 路由 | `shell/src/kernel-host.ts` 每次请求建响应；observatory 只读连接 | 无驻留（请求级） |
| A22 | `pluginResults` | `shell/src/app.ts:152`；初始化时按插件数填充 | 有界（注册数） |

## B. 内核侧（同进程）

| # | 结构 | 上限位置（或缺口） | 结论 |
|---|---|---|---|
| B1 | SQLite page cache | `src/core/MemoryGraph.ts:81-84` 只设 WAL/NORMAL/foreign_keys/busy_timeout；没有改 `cache_size`，走 SQLite 默认 2 MiB/连接 | 有界（默认） |
| B2 | `temp_store = MEMORY` | `src/factory.ts:3952-3962`（forgetUser 临时打开）与 `src/utils/SqliteTempDirectory.ts:57-66`（仅在临时目录不可写时） | 有界（单次操作，结束恢复/连接关闭） |
| B3 | 预编译语句 | 全仓无模块级 statement 注册表；`db.prepare(...)` 在调用点创建（如 `src/store/EventStore.ts:105` 打开、`src/recall/BrainRecall.ts:112` 查询） | 无应用侧长寿表；语句随调用/GC 释放（Bun 内部缓存未在本次审计范围内） |
| B4 | 向量索引 | 没有内存索引：`NeuronEmbeddingStore.findNearest`（`src/embedding/NeuronEmbeddingStore.ts:88`）每次按项目读行，`readRows`（`:186`）为瞬态 | 无驻留；单次内存与项目向量量成正比 |
| B5 | 事件流缓冲 | `src/events/KernelEventStream.ts:96`（1024 条）+ `:108-109`（buffer/listeners） | 有界 |
| B6 | **`MemoryGraph` 时间/项目索引** | `src/core/MemoryGraph.ts:45-46` 常驻 `Map<string, Set<string>>`；启动全量重建（`:330-347`），写入时追加（`:351-357`）；**软删除（`is_deleted=1`）不从这里删**，只有换项目域才删（`:839-842`） | **数据量正比 + 墓碑累积；内核红线，未改**。重启会按 `is_deleted=0` 重建，所以是进程内慢增长，不是每回合泄漏。报告 Susan。 |
| B7 | `MemoryGraph.anchorIndex` | `src/core/MemoryGraph.ts:47`；`createAnchor` 时 `set`（`:589`），`rebuildIndexes` 不清空 | 数据量正比（每次 Dream 锚点一条）；量很小，未改 |
| B8 | 快照保留 | `src/snapshot/BrainManifest.ts:10`（7 份） | 有界（盘上） |

## C. 盘上

| # | 项 | 上限 | 结论 |
|---|---|---|---|
| C1 | `shell-events.jsonl` | 无（A18） | **修**：8 MiB × 2 代 |
| C2 | `service.log` | 无（A19） | **修**：8 MiB × 2 代 |
| C3 | `web-cache/` | 64 条 / 32 MiB / 1h（A12） | 有界 |
| C4 | `snapshots/` | 7 份（B8） | 有界 |
| C5 | `memory.sqlite` / `-wal` | 数据本体，由 F19 快照保留与 kernel 自身管理 | 不在本轮 |

## D. soak 判据（先定死，后跑）

写在 `shell/test/soak-memory.test.ts` 头部，并在该文件里按此执行：

- **预热**：前 20 个回合丢弃（JIT、惰性加载、初始缓存填充）。
- **采样**：第 20 回合后每 10 回合一次，共 10 个点（第 20…110 回合）。
- **样本**：先 `Bun.gc(true)`，再取 `process.memoryUsage().rss`；同时记录 `heapUsed`。
- **判据**：采样点的最小二乘斜率 **< 256 KiB/回合**，且末样本 − 首样本 **< 32 MiB**；`heapUsed` 斜率 **< 64 KiB/回合**。
- **为什么不是 4 KiB**：本机 harness 的 RSS 在平坦均值上下摆动 ±30 MiB（强制 GC 时机），4 KiB/回合落在测量噪声以下，只会假红。每回合结构泄漏由 `memory-safety.test.ts` 的精确上限测试（转录 500、recall 只留当前 run、日志轮转）判别；soak 负责票面要的**长时趋势**。
- **回合构成**：普通回合（`submit`，走模型/投影/capture）、web 抓取（本地 fixture，走 Readability/Turndown 与缓存写入）、自醒（推进假时钟后 `tick`，走 due intent / 健康检查 / emergence）。
- 斜率按 `bytes/cycle` 打印在失败消息里；不通过就是失败，不调阈值。

**首跑（2026-11-15，120 回合）**：RSS 采样 `[270436, 302016, 245200, 265264, 265496, 257720, 215692, 252544, 274380, 242784]` KiB，
斜率 **−348838 B/回合**、首末差 **−28315648 B**；`heapUsed` 斜率 **−92 B/回合**。通过。

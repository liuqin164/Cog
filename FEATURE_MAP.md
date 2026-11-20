# Cogmem 功能地图（能力与验证）

草稿 v0.1 · 2026-11-19 · 基于 main `b0724077`，逐行核过调用点与测试。本文件存放在仓库根目录（与 MEMORY_MODEL.md 并列），是唯一正本；每轮开发直接在本文件里改自己动过的行。
一行一个功能：是什么 / 谁在用（活消费者）/ 靠什么证明 / 状态。
⚠️ = 有已知缺口（附票号）；在飞的改动落地后更新对应行。
规矩：之后每轮改到功能面，验收报告里同步改本图对应行，并列「删了什么」。

## 一、记忆内核

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 账本 | 一切记忆的原始记录，只追加不改 | 捕获写、召回/装配读（KernelAgentMemoryBackend） | 根套件 2329 测试；box 纠正传播实测 | ✅ |
| 捕获 | 消息与工具结果产生即写账本（raw 事件），轮末只做 episode/编译；中断轮可从账本恢复 | capture 插件逐事件 recordRawEvent/ingestTool* + agent_end finalize | 壳 capture 测试＋capture-durability（轮内 mem:、kill -9 后会话含中断轮）＋capture-perf（40/12 KB 原样入账不编译） | ✅ 大工具结果由 #343 删掉编译基底后恢复线性（#359 加门）；增量落盘 #348 |
| 召回 | 按相关性捞回旧事（raw 账本＋Atlas＋Frames；#343 删编译基底后） | session-context 每轮装进 recall 车道（limit 3）；memory 工具在车道没答案时按需 search 同一内核召回；命中的 profile 摘要在 working_set 展开为原文 | A6 基线（嵌入 @5 93.3%，rule-only 33.3%）；记分卡长会话 592/600；#72 超代四例＋#253 展开正向例（round 128，关掉超代过滤即红）；#362 根层复现（atlas=1/selected=0 → 命中并 touch，round 132）；#323 壳 memory-tool 5 测（search/read/recent/信任分层/端到端同义问法） | Atlas 按天和解＋命中反馈已接（#356 关）；首次构建由召回兜底（#361 关）；合并层丢弃已修 — #362 关（round 132）；按需检索已接 — #323 |
| 信任分层 | 工具观察（`tool_result`/`tool_call`）默认不进召回候选；显式提升（`metadata.toolObservationPromoted`，主人「记住」＋工具引用触发）才可进，带 `trust=tool_observation`、`whyMatched=tool observation (untrusted)` 并排在最后；同一内容不与原文重复；捕获超过 48,000 字符截断 | recall raw 准入（`isRawEventInRecallScope`）＋ capture 插件 | #325 根测试 5 条（含新进程 B 探针）；壳 `tool-trust-recall` 2 条；`capture-perf` 40/12 KB 原样、60 KB 截断；真实账本候选字节 79.6% → 0%（#325） | ✅ |
| 画像 | 关于主人的稳定事实册 | 装配器 profile 车道每轮注入；空闲 tick 在 compileProactiveBooks 增量编译（compiledThroughEventId 去重） | 提取质量探针（4 条事实：rule-only 4/4、模型证据 4/4）；10k 账本冷编译 p95 29.9 ms；50 个空 tick 不再编译 | ✅ 增量编译已接上 — #329 |
| 做法册 | 做成过的事沉淀成步骤 | declare_task end 时编译；装配时按任务匹配 | #265 实测（浮现不提升，定为不主动推） | ⚠️ 弱模型上生产者不触发（box 实测 declare 0 次） |
| 承诺 | 答应过的事，到期提醒一次 | emergence 插件查到期 + working_set 车道 | F16 测试；记分卡 A2 | ✅ |
| 意图 | 它自己打算做的事，到点自醒 | app.ts 唤醒循环扫 dueAt | F22 测试 | ✅ |
| 灵魂 | 性格文本：主人可改，它只能提案 | pinned 车道每轮逐字注入；propose_soul_edit 只产草稿 | F17 测试（直写被拒 soul_agent_write_forbidden） | ✅ |
| 遗忘 | 按时间窗真删账本及派生数据 | /forget 两步（预览→确认） | #303 测试（secure_delete＋VACUUM）；#332 遍历式残留测试（派生表＋FTS 影子表＋trace）；box 真删实测 | 旧库派生表按项目/事件关联删除；FTS 残留未复现，由遍历测试守住 |
| 共享与导入 | 家族共享集合、外部记忆导入桥 | 内核 [shared] 开关 + import 通道（默认关） | #143/#146 测试 | ✅ |

## 二、壳 · 会话

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 状态机 | DORMANT→WAKING→IDLE⇄RUNNING／DREAMING／SUSPENDED | 一切回合的骨架；table.ts 迁移表，非法迁移抛错 | machine 测试；每迁移 checkpoint 落盘；box kill -9 恢复实测 | ✅ |
| 上下文装配 | 六车道（pinned/profile/digest/working_set/recall/tail）按预算拼每轮请求；assignment 只在 working_set 出现一次，无 assignment 时不出现（#334） | session-context 插件每轮调用 | 记分卡长会话 592/600（#343 后复核）；#319/#320 预算与前缀缓存测试；context-continuity 探针（闲聊 0 块／declare 后恰好 1 块） | ✅ |
| 工具面 | 默认 9 工具：read/write/edit/bash＋declare_task/ask_user/propose_command/propose_soul_edit＋memory（search/read/recent）；declare_task start 是唯一的 assignment 构造点，普通消息不再隐式创建（#334）；propose_command 只可提议 13 个白名单命令，破坏性五命令（/forget /plugins /upgrade /export /correct）永不可提议（#335） | 每轮挂载；/context 可见清单 | #333 实测 schema ≈1,336 token/请求；壳测试；context-continuity 的 declare start/end 用例；round 129 白名单探针（五命令逐个被拒、描述与白名单集合相等、/pause 端到端确认）；#323 工具数 8→9、memory-tool 三动作 | installPlugin 安装路径无 hygiene 门 — #363；自治运行共用全量工具 — #349 待定 |
| 笼子 | 回合/令牌预算＋工具白名单，超限暂停到 SUSPENDED | cage 插件在钩子点拦截 | cage.test.ts；#222 预算档位 | ✅ |
| 浮现 | 到期承诺/意图在合适时机冒出来；勿扰窗内只排队、不主动开口 | emergence 插件（nextWakeAt/surfacingCandidates）＋ F18 deliveryRoute(Batch) | F6/F7/F8/F10 门测试；壳 surfacing-loop 4 测（忽略降频、/wake 到期、/snooze 顺延、/surfacing 停源）＋ quiet-window 2 测（窗口内排队、窗口后首 tick 送达） | ✅ 反馈环已接 — #330；勿扰窗已生效 — #328 |
| 时间 | 每轮注入分钟级当前时间，保前缀缓存 | clock 插件 | #320 测试（相邻请求前缀 100% 一致） | ✅ |
| 秘密脱敏 | 密钥类文本进账本前抹掉 | capture 插件＋模型路由的 redactSecretText | 根套件脱敏测试 | ✅ |
| 模型接入 | 自定义 OpenAI 协议端点＋mg 路由 | provider 插件每轮调用 | box/生产多路由实测 | ✅ |
| 嵌入 | 本地 bge 向量，可换 ollama/OpenAI 协议 | 召回车道算向量；壳启动 warm 成功后调 backfillEventEmbeddings 补嵌旧事件 | #313 测试；round 128 补嵌判别测试（换模型重开后 nearest 由空转命中、stale 转 false） | ✅ 换模型/维度后旧事件自动补嵌（#360 关）；仅壳本地嵌入 warm 成功后执行，失败不致命 |
| 观测台（星海） | 网页看记忆/图谱、改灵魂 | kernel-host 挂 observatory，令牌文件鉴权 | #308 令牌测试；日常人工使用 | ✅ |
| 终端 | `cog` TUI＋远程 attach | channels/terminal＋attach server | TUI 测试 | ✅ |
| 网页工具 | 抓网页/搜索（插件） | 默认不加载，显式启用才挂 | #306 测试（默认零 fetch） | ✅ 可选 |

## 三、夜间

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 做梦 | 夜里整理账本：分类、编译、摘要；02:00 折的是昨天，错过窗口下一 tick 补最近一日（跨多日只补最近一日并记跳过天数），失败按 5/10/20/30 分钟退避、整夜最多 5 次 | clock 插件在窗口内或补课时触发 runKernelNight | box 整夜实测（61 事件→10 候选）；F13 行为评测；#326 测试：memory 角色跟随激活路线、不可达写 memory_model_unavailable 并计入失败夜；#327 假时钟 6 例（窗口内、补课、跨日、23→6 一夜一次、退避上限、48h 无 Dream） | ✅ 模型不可达时不再静默：/health 与 /status 显示记忆模型降级；补课与重试风暴已修（#327） |
| 分类 | 新记忆按角色归类（规则/画像/承诺/意图/经历） | Dream 内调 memory 模型（Route A），主人 /candidates 审 | #231 测试；成本上限在 budgets.json | ✅ |

## 四、治理与运维

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 健康与备份 | 整脑快照（距上次 ≥24h 触发，不依赖 Dream）＋健康自检 | 快照落 snapshots/；/health 面 | F19 恢复演练 13/13；#327 假时钟 48h 无 Dream 仍写 1 次快照 | ✅ |
| 升级 | 预告→静默期→分阶段装→健康门→失败回滚 | upgrade/supervisor | 升级单元测试 | ⚠️ 实机升级考试未做 — 生存跑阶段验 |
| 安装/doctor | 一条命令装好＋自检 | install/installer＋doctor | box 六步自检实测；core-cli 的 doctor --storage 断言（含 embeddings 覆盖读数，round 128 恢复） | doctor 嵌入覆盖读数已恢复（#360）；⚠️ 与内核侧安装栈重复 — #354 待定 |
| 行为评测 | F13 场景集＋连续性记分卡 | eval/behavior＋记分卡 | F13 box 16/16；记分卡基线 2/6 | ⚠️ 记分卡全绿等队列清空后复测 |

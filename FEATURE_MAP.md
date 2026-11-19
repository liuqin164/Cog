# Cogmem 功能地图（能力与验证）

草稿 v0.1 · 2026-11-19 · 基于 main `b0724077`，逐行核过调用点与测试。本文件存放在仓库根目录（与 MEMORY_MODEL.md 并列），是唯一正本；每轮开发直接在本文件里改自己动过的行。
一行一个功能：是什么 / 谁在用（活消费者）/ 靠什么证明 / 状态。
⚠️ = 有已知缺口（附票号）；在飞的改动落地后更新对应行。
规矩：之后每轮改到功能面，验收报告里同步改本图对应行，并列「删了什么」。

## 一、记忆内核

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 账本 | 一切记忆的原始记录，只追加不改 | 捕获写、召回/装配读（KernelAgentMemoryBackend） | 根套件 2329 测试；box 纠正传播实测 | ✅ |
| 捕获 | 每轮结束把对话写进账本 | app.ts 三处 rememberTurnWithResult + capture 插件 | 壳 capture 测试；box 对话后复述 | ⚠️ 只在轮末捕获，崩溃丢当轮；大工具结果捕获慢 — #348/#359 |
| 召回 | 按相关性捞回旧事（raw 账本＋Atlas＋Frames；#343 删编译基底后） | recall 插件每轮装进 recall 车道（limit 3） | A6 基线（嵌入 @5 93.3%，rule-only 33.3%）；记分卡长会话 592/600 | Atlas 已接召回前按天和解＋命中反馈（#356 关，round 125）；首次构建无同伴触发点 — #361；模型变更后旧事件不重嵌 — #360（在飞） |
| 画像 | 关于主人的稳定事实册 | 装配器 profile 车道每轮注入 | 提取质量探针（4 条事实命中率） | ⚠️ 质量下限未达 — #329 |
| 做法册 | 做成过的事沉淀成步骤 | declare_task end 时编译；装配时按任务匹配 | #265 实测（浮现不提升，定为不主动推） | ⚠️ 弱模型上生产者不触发（box 实测 declare 0 次） |
| 承诺 | 答应过的事，到期提醒一次 | emergence 插件查到期 + working_set 车道 | F16 测试；记分卡 A2 | ✅ |
| 意图 | 它自己打算做的事，到点自醒 | app.ts 唤醒循环扫 dueAt | F22 测试 | ✅ |
| 灵魂 | 性格文本：主人可改，它只能提案 | pinned 车道每轮逐字注入；propose_soul_edit 只产草稿 | F17 测试（直写被拒 soul_agent_write_forbidden） | ✅ |
| 遗忘 | 按时间窗真删账本及派生数据 | /forget 两步（预览→确认） | #303 测试（secure_delete＋VACUUM）；box 真删实测 | ⚠️ 派生表残留 — #332 |
| 共享与导入 | 家族共享集合、外部记忆导入桥 | 内核 [shared] 开关 + import 通道（默认关） | #143/#146 测试 | ✅ |

## 二、壳 · 会话

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 状态机 | DORMANT→WAKING→IDLE⇄RUNNING／DREAMING／SUSPENDED | 一切回合的骨架；table.ts 迁移表，非法迁移抛错 | machine 测试；每迁移 checkpoint 落盘；box kill -9 恢复实测 | ✅ |
| 上下文装配 | 六车道（pinned/profile/digest/working_set/recall/tail）按预算拼每轮请求；assignment 只在 working_set 出现一次，无 assignment 时不出现（#334） | session-context 插件每轮调用 | 记分卡长会话 592/600（#343 后复核）；#319/#320 预算与前缀缓存测试；context-continuity 探针（闲聊 0 块／declare 后恰好 1 块） | ✅ |
| 工具面 | 默认 8 工具：read/write/edit/bash＋declare_task/ask_user/propose_command/propose_soul_edit；declare_task start 是唯一的 assignment 构造点，普通消息不再隐式创建（#334） | 每轮挂载；/context 可见清单 | #333 实测 schema ≈1,336 token/请求；壳测试；context-continuity 的 declare start/end 用例 | ✅ |
| 笼子 | 回合/令牌预算＋工具白名单，超限暂停到 SUSPENDED | cage 插件在钩子点拦截 | cage.test.ts；#222 预算档位 | ✅ |
| 浮现 | 到期承诺/意图在合适时机冒出来 | emergence 插件（nextWakeAt/surfacingCandidates） | F6/F7/F8/F10 门测试 | ⚠️ 反馈环未接（无人调 recordSurfacingFeedback/snooze）— #330 |
| 时间 | 每轮注入分钟级当前时间，保前缀缓存 | clock 插件 | #320 测试（相邻请求前缀 100% 一致） | ✅ |
| 秘密脱敏 | 密钥类文本进账本前抹掉 | capture 插件＋模型路由的 redactSecretText | 根套件脱敏测试 | ✅（捕获成本问题在 #359） |
| 模型接入 | 自定义 OpenAI 协议端点＋mg 路由 | provider 插件每轮调用 | box/生产多路由实测 | ✅ |
| 嵌入 | 本地 bge 向量，可换 ollama/OpenAI 协议 | 召回车道算向量 | #313 测试 | ⚠️ 换模型/维度后旧事件不重嵌（#313 的自动重嵌随 #343 删除丢失）— #360（在飞，round 126） |
| 观测台（星海） | 网页看记忆/图谱、改灵魂 | kernel-host 挂 observatory，令牌文件鉴权 | #308 令牌测试；日常人工使用 | ✅ |
| 终端 | `cog` TUI＋远程 attach | channels/terminal＋attach server | TUI 测试 | ✅ |
| 网页工具 | 抓网页/搜索（插件） | 默认不加载，显式启用才挂 | #306 测试（默认零 fetch） | ✅ 可选 |

## 三、夜间

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 做梦 | 夜里整理账本：分类、编译、摘要 | clock 插件在窗口内触发 runKernelNight | box 整夜实测（61 事件→10 候选）；F13 行为评测 | ⚠️ 模型不可达时静默降级纯规则还记成功 — #326；补跑重试风暴 — #327 |
| 分类 | 新记忆按角色归类（规则/画像/承诺/意图/经历） | Dream 内调 memory 模型（Route A），主人 /candidates 审 | #231 测试；成本上限在 budgets.json | ✅ |

## 四、治理与运维

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 健康与备份 | 整脑快照（夜）＋健康自检 | 快照落 snapshots/；/health 面 | F19 恢复演练 13/13 | ✅ |
| 升级 | 预告→静默期→分阶段装→健康门→失败回滚 | upgrade/supervisor | 升级单元测试 | ⚠️ 实机升级考试未做 — 生存跑阶段验 |
| 安装/doctor | 一条命令装好＋自检 | install/installer＋doctor | box 六步自检实测 | ⚠️ 与内核侧安装栈重复 — #354 待定 |
| 行为评测 | F13 场景集＋连续性记分卡 | eval/behavior＋记分卡 | F13 box 16/16；记分卡基线 2/6 | ⚠️ 记分卡全绿等队列清空后复测 |

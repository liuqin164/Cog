# Cogmem 功能地图（能力与验证）

定稿 · 2026-11-21 · 基于 main `340dff3a`（round 167 合并头），逐行核过调用点与测试。本文件存放在仓库根目录（与 MEMORY_MODEL.md 并列），是唯一正本；每轮开发直接在本文件里改自己动过的行。
一行一个功能：是什么 / 谁在用（活消费者）/ 靠什么证明 / 状态。
⚠️ = 有已知缺口（附票号）；在飞的改动落地后更新对应行。
规矩：之后每轮改到功能面，验收报告里同步改本图对应行，并列「删了什么」。

## 一、记忆内核

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 账本 | 一切记忆的原始记录，只追加不改 | 捕获写、召回/装配读（KernelAgentMemoryBackend） | 根套件 1351 测试／212 文件（340dff3a 合并头实测）；box 纠正传播实测 | ✅ |
| 捕获 | 消息与工具结果产生即写账本（raw 事件），轮末只做 episode/编译；中断轮可从账本恢复 | capture 插件逐事件 recordRawEvent/ingestTool* + agent_end finalize | 壳 capture 测试＋capture-durability（轮内 mem:、kill -9 后会话含中断轮）＋capture-perf（40/12 KB 原样入账不编译） | ✅ 大工具结果由 #343 删掉编译基底后恢复线性（#359 加门）；增量落盘 #348 |
| 召回 | 按相关性捞回旧事（raw 账本＋Atlas＋Frames；#343 删编译基底后） | session-context 每轮装进 recall 车道（limit 3）；memory 工具在车道没答案时按需 search 同一内核召回；命中的 profile 摘要在 working_set 展开为原文 | A6 基线（嵌入 @5 93.3%，rule-only 33.3%）；记分卡长会话 593/600；#72 超代四例＋#253 展开正向例（round 128，关掉超代过滤即红）；#362 根层复现（atlas=1/selected=0 → 命中并 touch，round 132）；#391 扣留回填（前 3 含 1 机密、第 4 干净 → limit 3 交 3，机密零出现）；#323 壳 memory-tool 5 测（search/read/recent/信任分层/端到端同义问法） | Atlas 按天和解＋命中反馈已接（#356 关）；首次构建由召回兜底（#361 关）；合并层丢弃已修 — #362 关（round 132）；按需检索已接 — #323；保密/生活扣留不再吃名额 — #391 关 |
| 信任分层 | 工具观察（`tool_result`/`tool_call`）默认不进召回候选；显式提升（`metadata.toolObservationPromoted`，主人「记住」＋工具引用触发）才可进，带 `trust=tool_observation`、`whyMatched=tool observation (untrusted)` 并排在最后；同一内容不与原文重复；捕获超过 48,000 字符截断 | recall raw 准入（`isRawEventInRecallScope`）＋ capture 插件 | #325 根测试 5 条（含新进程 B 探针）；壳 `tool-trust-recall` 3 条；`capture-perf` 40/12 KB 原样、60 KB 截断；真实账本候选字节 79.6% → 0%（#325） | ✅ |
| 画像 | 关于主人的稳定事实册 | 装配器 profile 车道每轮注入；空闲 tick 在 compileProactiveBooks 增量编译（compiledThroughEventId 去重） | 提取质量探针（4 条事实：rule-only 4/4、模型证据 4/4）；10k 账本冷编译 p95 29.9 ms；50 个空 tick 不再编译；#364 负例精度（profile-extraction-quality.unit.test.ts 三条：a one-off plan is not a wake-time habit / a temporary stay is not a home address / a figure of speech is not an allergy） | ✅ 增量编译已接上 — #329；负例精度 — #364 |
| 做法册 | 做成过的事沉淀成步骤 | 壳在该 run 首个工具调用时开 assignment；declare_task end 时编译；装配时按任务匹配 | #265 实测（浮现不提升，定为不主动推）；#371 真实模型 auto/deepseek-v4.1-flash 1/1：新任务 write+read → declare end → 账本条目两条步骤与 trace 逐条一致 | ✅ 生产者端到端已通（#371）；触发率样本仍小 |
| 承诺 | 答应过的事，到期提醒一次 | emergence 插件查到期 + working_set 车道 | F16 测试；记分卡 A2 | ✅ |
| 意图 | 它自己打算做的事，到点自醒 | resident-tick 唤醒循环扫 dueAt（compile＋list active＋schedule 自醒） | F22 测试（intention-book 契约＋wake-intention） | ✅ |
| 灵魂 | 性格文本：主人可改，它只能提案 | pinned 车道每轮逐字注入；propose_soul_edit 只产草稿 | F17 测试（直写被拒 soul_agent_write_forbidden） | ✅ |
| 遗忘 | 按时间窗真删账本及派生数据，含壳侧 checkpoint 引用与 trace 的 `run_prompt`（#331）；收尾枚举全部 FTS5 表 optimize 重写段后再 VACUUM | /forget 两步（预览→确认）；checkpoint 的 assignment/away/task 文本只存账本 eventId，恢复时回读 | #303 测试（secure_delete＋VACUUM）；#332 sqlite_master 枚举全表全列的残留测试；#373 pending_bindings 随 interaction_units 级联并做 DB 字节扫描；#374 真实规模 CJK 判别（三文件字节零命中）；#331 壳探针（四个文件零命中＋快照恢复 assignment/away）；记分卡 forget 由 3 文件残留转 0；10k 窗口 629 ms／峰值 210 MB（基线 621 ms／207 MB）；10k 事件 optimize ＋181 ms（1.59 s → 1.77 s） | 旧库派生表按项目/事件关联删除；#373 后 pending_bindings 的 reference_text 随所属 unit 删除，模式驱动遍历守残留；#374 后 FTS5 段内死字节随 optimize＋VACUUM 清零 |
| 共享与导入 | 家族共享集合、外部记忆导入桥 | 内核 [shared] 开关 + import 通道（默认关） | #143/#146 测试 | ✅ |

## 二、壳 · 会话

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 状态机 | DORMANT→WAKING→IDLE⇄RUNNING／DREAMING／SUSPENDED | 一切回合的骨架；table.ts 迁移表，非法迁移抛错；checkpoint 只留进程恢复字段，对话原文存账本（#331） | machine 测试；每迁移 checkpoint 落盘；box kill -9 恢复实测；kill-matrix 与快照恢复 | ✅ |
| 上下文装配 | 六车道（pinned/profile/digest/working_set/recall/tail）按预算拼每轮请求；一轮内复用装配，账本 global_seq 前进才整份重算，working_set 的 auto-expansion 可按最新文本重算；assignment 只在 working_set 出现一次，无 assignment 时不出现（#334/#351） | session-context 插件每轮调用 | 记分卡长会话 593/600（#343 后复核）；#319/#320 预算与前缀缓存测试；#351 assembly-cache 探针（无落盘 4 次调用 recall=1；工具落盘后每次失效点重算）；context-continuity 探针（闲聊 0 块／declare 后恰好 1 块） | ✅ |
| 工具面 | 默认 13 工具：read/write/edit/bash＋declare_task/ask_user/propose_command/request_credential/propose_soul_edit/propose_plugin/plugin_proposal_status/installed_plugins＋memory（search/read/recent）；declare_task start 是唯一的 assignment 构造点，普通消息不再隐式创建（#334）；propose_command 只可提议 13 个白名单命令，破坏性五命令（/forget /plugins /upgrade /export /correct）永不可提议（#335）；插件提案三工具只提案/查账，不自批 | 每轮挂载；/context 可见清单 | #333 实测 schema ≈1,336 token/请求；壳测试；context-continuity 的 declare start/end 用例；round 129 白名单探针（五命令逐个被拒、描述与白名单集合相等、/pause 端到端确认）；#323 工具数 8→9、memory-tool 三动作；#363 安装路径四门探针（密钥/超体积/越界路径拒绝、正常安装）；#376 plugin-self-install 7 测（attach 卡片与 Enter/Esc、全链/失败自动摘除/四类拒绝/无批准工具） | installPlugin 安装路径四门（体积/形状/密钥/路径）— #363 已补；自治运行共用全量工具 — #349 已定（2026-11-21：与交互运行共用全量权限，无单独名单，无代码变更）；默认工具 9→13 — #376/#383 |
| 插件自助 | 同伴在对话里写插件：源码只写入 `<dataDir>/plugin-workspace/<name>/index.ts`，提案记录名称、用途、provide/inject/data 权限面、源码路径与 `/plugins remove <spec>`；attach 的提案卡片（companion_command_proposal）Enter 批准、Esc 作废，批准后壳走 `/plugins add` 同一注册表与 resumeAfterRestart 重启；加载时把插件经 `ctx.registerTool` 注册的工具自动加入 cage 白名单、卸载时摘除；重启后按 `/health` 的 plugins 加载结果、宿主 started 状态、声明的 provide 服务与工具白名单做健康检查，失败自动摘注册、删源码并入账；提案丢弃/拒绝删暂存源码（账本保留）；`/plugins remove` 由主人一条命令摘除并卸载 | propose_plugin / plugin_proposal_status / installed_plugins 三工具；ProposalsHandlers 的同一 owner confirm；attach server/TUI 的 command-confirm|discard；plugins-admin 的 /plugins add|remove | shell/test/plugin-self-install.test.ts 8 测：attach 卡片含名称/用途/权限面/源码/摘除且无 confirm 不入安装链；纯工具插件提案→批→装→模型真实调用→摘除后工具与白名单无残留；白名单缺失判健康失败并自动摘除；导入失败自动摘除；越界源码/缺权限面/内置重名·服务覆盖·内置工具或核心命令覆盖/未批加载全部拒绝；丢弃提案删暂存源码；账本 `<dataDir>/shell-events.jsonl` 记录 proposed/approved/registered/health_ok|failed/removed/discarded | ✅ #384 |
| 笼子 | 回合/令牌预算＋工具白名单，超限暂停到 SUSPENDED | cage 插件在钩子点拦截 | cage.test.ts；#222 预算档位 | ✅ |
| 浮现 | 到期承诺/意图在合适时机冒出来；勿扰窗内只排队、不主动开口；engaged 只认点名浮现内容的回应，ignored 需送达＋用户活动＋24h 无定向回应，snooze 不计忽略，待决状态落账本 | emergence 插件（nextWakeAt/surfacingCandidates）＋ F18 deliveryRoute(Batch) | F6/F7/F8/F10 门测试；壳 surfacing-loop 8 测（定向 engaged、无关聊天不入账、24h ignored、snooze 不计忽略、重启待决仍在、忽略降频、/wake 到期、/surfacing 停源）＋ quiet-window 2 测（窗口内排队、窗口后首 tick 送达） | ✅ 反馈环已接 — #330；勿扰窗已生效 — #328；反馈信号修正 — #389 |
| 时间 | 每轮注入分钟级当前时间，保前缀缓存 | clock 插件 | #320 测试（相邻请求前缀 100% 一致） | ✅ |
| 秘密脱敏 | 密钥类文本进账本前抹掉 | capture 插件＋模型路由的 redactSecretText | 根套件脱敏测试 | ✅ |
| 保密输入面 | 同伴用 `request_credential` 发起请求（服务/用途/字段），值只在可信面输入：attach TUI 冻结普通输入行，逐字段向导（账号回显、密码完全不回显），任一步 Esc 取消且不存半成品；星海弹窗表单同库同回执。值经宿主写 `<dataDir>/credentials.json`（0600），对话只落「已保存：引用名」/「已取消」；bash 的 `credential` 引用由宿主在调用点注入 `COGMEM_CRED_<REF>_<FIELD>`，模型上下文不见原文；使用/撤销写 `shell-events.jsonl`（引用名/时间/调用方/服务，不带值）；渠道面提交被拒且不落盘 | `request_credential`；`CredentialService`；attach `credential-submit`/`credential-cancel`；observatory `/credentials*`；bash `credential` | shell/test/credential-input 3 测（端到端账本/日志/模型上下文原文零出现、渠道拒绝不落盘、0600 与撤销后使用失败）；tui-proposal-keys 3 测（逐字段、Esc、密码不回显）；__tests__/observatory-credentials 4 测（列表无值、令牌、跨源拒绝、取消/撤销） | ✅ #383 |
| 模型接入 | 自定义 OpenAI 协议端点＋mg 路由；SSE 流式，非 SSE 回退整包 | provider 插件每轮调用；delta 走既有 message_update | 3-chunk 流式测试（3 次 message_update、终文一致）与整包回退测试；真实网关 TTFT 3.46 s／总 18.8 s（上游首包 2.7 s，未达 1.5 s 目标） | ✅ 流式已接；TTFT 受上游限制 |
| 嵌入 | 本地 bge 向量，可换 ollama/OpenAI 协议 | 召回车道算向量；壳启动 warm 成功后本地按 4 条/批、批间 25ms 让行调 backfillEventEmbeddings 补嵌旧事件；常驻 tick 每 60s 增量补嵌一批（默认 16 条，`freshness.embeddingBatch`/`intervalMs` 可配，扫完一圈从头再扫），并把未嵌入数/最老未嵌入年龄/未绑定数写入 /health 的 freshness 读数；回合级 queueEventEmbedding 失败的事件留在同一积压口径由下一轮补 | #313 测试；round 128 补嵌判别测试（换模型重开后 nearest 由空转命中、stale 转 false）；#388 常驻不重启：三类无向量事件＋未绑定事件一个 tick 归零，/health 与回合在慢嵌入等待期间照常作答；失败回合嵌入落积压后被 tick 补上；#375 VPS 播种 2000 条冷启动 warm 实测（改前→改后）：回合 8.2s→3.9s、/health 最长停顿 8.5s→4.1s、补嵌 2001 条 282s→513s | ✅ 换模型/维度后旧事件自动补嵌（#360 关）；增量补嵌失败不致命，留在积压下一圈重试 |
| 观测台（星海） | 网页看记忆/图谱、改灵魂；星图是 3D 力导向星云：节点=编译记忆、边=帧/图谱关系、六类角色图例筛选、点选聚焦+邻里高亮+原文出处；WebGL 不可用降级 Canvas 2D 力导向，移动端可旋转/缩放/平移 | kernel-host 挂 observatory，令牌文件鉴权 | #308 令牌测试；#385 真实账本副本 13 节点/9 边与直查一致、六类图例/点选/原文/2D 降级/手机视口实测；日常人工使用 | ✅ #385 |
| Web 对话渠道 | 官方预装插件（`builtin:web-channel`）：页面由壳的 HTTP 面提供、复用观测台写入令牌；消息走 F12 ingest 后交 `shell.submit`，SSE 流式回复，历史读账本；流内卡片：插件提案（批准走 attach 同一 owner confirm/自装链）、承诺浮现（确认/顺延）、回复出处片跳星海原文；凭据请求打开观测台保密输入弹窗，渠道不自收；`/plugins remove builtin:web-channel` 后页面 404、SSE 断开，账本零改动，重装后历史仍在 | 壳 HTTP 面；`channels/web.ts`；`shell/web-channel/`；observatory `#node=`/`#credentials` 深链 | shell/test/web-channel.test.ts：流式/出处片/提案批准真写注册表/凭据无渠道收集端点/摘除后 404 且事件计数不变/重装历史可见；#383 凭据面测试 | ✅ #386 |
| 终端 | `cog` TUI＋远程 attach | channels/terminal＋attach server | TUI 测试 | ✅ |
| 网页工具 | 抓网页/搜索（插件） | 默认不加载，显式启用才挂 | #306 测试（默认零 fetch） | ✅ 可选 |

## 三、夜间

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 做梦 | 夜里整理账本：分类、编译、摘要；触发改为壳空闲 + 待编译量（未策展事件/未编译集数）达阈值，夜间（2–5）5 分钟空闲/1 条、白天 60 分钟/2 条，夜间优先；02:00 折的是昨天，错过窗口下一 tick 补最近一日（跨多日只补最近一日并记跳过天数），失败按 5/10/20/30 分钟退避、整夜最多 5 次 | resident tick 按 idle+backlog+时段权重触发 runKernelNight，每次决策写 dream_trigger trace（backlogEvents/backlogEpisodes/idleMs/thresholds） | box 整夜实测（61 事件→10 候选）；F13 行为评测；#326 测试：memory 角色跟随激活路线、不可达写 memory_model_unavailable 并计入失败夜；#327 假时钟 6 例（窗口内、补课、跨日、23→6 一夜一次、退避上限、48h 无 Dream）；#379 假时钟一周（凌晨 3 点对话、静夜、白天零散三种夜型：backlog 4/4/8 清空、白天不抢占、状态机表零改动） | ✅ 模型不可达时不再静默：/health 与 /status 显示记忆模型降级；补课与重试风暴已修（#327）；触发策略见 #379 |
| 分类 | 新记忆按角色归类（规则/画像/承诺/意图/经历）；策展输入按角色限长（user 8000／assistant 3000／tool·task 1200），超长保留头尾并标出省略字数与原始长度，整集 24000 字总闸按 tool→assistant→user 压缩 | Dream 内调 memory 模型（Route A），主人 /candidates 审 | #231 测试；成本上限在 budgets.json；#387 记分卡长尾组 6/6（改前 0/6），主集 12/24 持平 | ✅ |

## 四、治理与运维

| 功能 | 是什么 | 谁在用 | 靠什么证明 | 状态 |
|---|---|---|---|---|
| 健康与备份 | 整脑快照（距上次 ≥24h 触发，不依赖 Dream）＋健康自检；上下文装配失败进 /health、doctor 与 daily 报告，连续 3 次读作 degraded（#350）；/health 的 freshness 报未嵌入事件数、最老未嵌入年龄与未绑定事件数，由常驻 tick 的回填轮更新（读请求不扫账本）；同一面报 backlog：未绑定数、待编译量、候选队列各状态、needs_confirmation 的 7 天内将过期/已逾期数、别名冲突数，规矩/灵魂类候选（偏好/目标/边界/失败教训）单列；tick 与 /health 共用 getBacklogReadings（#390） | 快照落 snapshots/；/health 面 | F19 恢复演练 13/13；#327 假时钟 48h 无 Dream 仍写 1 次快照；#350 context-assembly-health 探针（必抛错车道仍发请求、计数递增、3 次降级、恢复清零）；#388 freshness 三读一个 tick 内归零，回填等待嵌入时 /health 与回合不被堵；#390 播种各积压后 /health 与 doctor 逐项等于直接 SQL，临期 needs_confirmation 在过期前可见 | ✅ |
| 升级 | 预告→静默期→分阶段装→健康门→失败回滚 | upgrade/supervisor（`/upgrade` 是唯一正主） | 升级单元测试 | ⚠️ 实机升级考试未做 — 生存跑阶段验；`cogmem update` 与自动升级已删（#354 A） |
| 安装/doctor | 一条命令装好＋自检 | install/installer＋shell doctor | box 六步自检实测；#354 B 的 doctor-no-db 测试（损坏 memory.sqlite 仍过、宿主停止则 resident-health FAIL）；#344 同伴-only HOME 与配置优先级矩阵（COGMEM_CONFIG > 项目 > 全局 > companion；recall 读同伴库）；#372 宿主 /health 暴露 storage 进度（raw events、embeddings completed/total/failed、recall decisions 行数/上限），doctor 读数与 EventEmbeddingStore.getProgress() 一致；#390 doctor 的 backlog 行与 /health 的 backlog 段逐项一致 | ✅ doctor 唯一实现 = 壳侧 runDoctor，管理面只读 install.json＋/health、不开 DB；嵌入覆盖与 recall 决策读数经 /health 恢复（#372）；积压读数经 /health 的 backlog 段进 doctor（#390）；重复安装/doctor 栈已合并（#354 A/B），旧 --config/--storage/secret/shared 读数删除；壳 env 覆盖统一 COG_ 前缀（#370，COGMEM_CONFIG 不变） |
| 行为评测 | F13 场景集＋连续性记分卡 | eval/behavior＋记分卡 | F13 box 16/16；连续性记分卡 6/6（#367：长会话 593/600、max_request_tokens 5994/6000、夜间补做／浮现上限／预算恢复／SIGKILL 存续全绿） | ✅ 六条全绿（#367）；F13 box 本题未重跑 |
| 冻结棘轮 | 冻结线变成机器检查：freeze-budget.json 按区域封顶行数＋工具／命令／状态／表／导出符号五项计数，超限即红；抬上限必须在同一轮改预算文件（#353） | CI 每推必跑（ci.yml 的 budget-check 步）；本地 `bun scripts/budget-check.ts` | round 164 验收判别实验（压低上限即红、恢复即绿）；#383 实测（75 区域／99,800 行；13 工具／23 命令／6 状态／105 表／768 导出符号） | ✅ round 166/167 涨行数已同步抬上限；#383 新增保密输入面，同步抬 shell/src 6608、attach 457、plugins 4904、tui 2782、observatory 3879 与工具 13 |

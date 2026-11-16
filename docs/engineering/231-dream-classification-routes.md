# #231 做梦/分类两条路线对比（待 Ryu 拍板）

状态：**路线 A 已实施**（2026-11-16，Ryu 拍板）。六层分类语义与结构未动；事实同伴库未碰。
本文保留为拍板材料，实施结果见 `CHANGELOG.md` 与 #231 的实施回报。

## 现状（按代码读实）

- `shell/src/app.ts` 构造内核时只传 `dbPath`、`projectTimeZone`、`snapshotsDir`，没有传
  `modelRegistry`；内核因此用 `ModelRegistry.defaults()`，`memory` 与 `reasoning` 都是
  `rule_only`。
- 所以壳里的 `MemoryKernel.semanticIndexEnabled()` 为 `false`，召回结果带
  `semanticIndex: false`；Dream curator 的模型分支不启用，只走确定性抽取。
- `shell/src/plugins/dream.ts` 的夜间摘要是规则截取（当日计数 + 前 5 条用户话的前 80 字），
  不是模型调用。本轮已把它的 provenance 从 `llm_inference` 改成 `rule_extraction`。
- 内核 curator 的普通候选要 `cogmem memory govern` 才晋升，`needs_confirmation` 要
  `cogmem memory review`；本轮壳里新增只读 `/candidates` 面，能看数量、候选类型（来源）和
  待审状态，但不代替 govern/review。
- 事实同伴库 `neurons=101`、`compiled_events=0`：没有存量假标签需要迁移；本轮以代码和
  新装为准。

## 路线 A：夜间模型推断分类

**定义**：夜间 Dream 在确定性抽取之后调用 `memory` 模型，提出偏好、目标、边界、失败教训、
诊断结论等候选；CPU 治理仍决定 status，用户/操作者 review 后才晋升。

### 接线成本

1. 在 `app.ts` 构造 `ModelRegistry`，把 `memory` role 指向壳已有的 mg 网关；若还要语义召回，
   `embedding` role 也要配，并对已有神经元做 re-embed。
2. **只配 `memory` role 不够诚实**：`semanticIndexEnabled()` 会翻成 `true`，但 embedding 仍是
   `deterministic_local`，召回结果里的 `semanticIndex` 就成了一句不实的声明。要么同时配
   embedding，要么改 `semanticIndexEnabled()` 的判据——后者是召回契约变更。
3. 每个 sealed episode 一次（或多次）模型调用：token、延迟、超时、坏 JSON、provider 不可用
   都需要处理；现有 `semanticProcessorReason` / `semanticProcessorError` 路径可以复用。
4. 候选量会上升，review 面从“有”变成“必需”；本轮 `/candidates` 只解决可见性，不解决审批量。
5. 需要成本上限、夜间预算、provider 失败时明确降级为 rule-only，而不是静默假成功。

### 验证法

- **固定语料**：一组已 sealed 的 episode，人工标注期望候选；量 precision / recall、每条候选的
  证据合法率（`eventId` 必须来自本 episode）、以及“无用户证据却晋升”的数量必须为 0。
- **故障注入**：provider 超时、返回非 JSON、引用不存在的 `eventId`；断言 run 记录原因、
  不写假候选、不改变召回契约。
- **成本/延迟**：每夜 token、调用数、P50/P95 延迟；连续 7 夜 soak，候选量不失控。
- **召回回归**：六层分类、Atlas、belief 路径不变；模型只产 candidate，不直接写 verified
  memory。

### 风险

- 幻觉与过度推断；把 assistant 的话当用户偏好；证据引用错误。
- 成本与隐私：对话内容会送到 provider；provider 不可用时容易退化成“看起来跑了”。
- 候选洪水导致 review 疲劳；只配 `memory` 不配 `embedding` 会让 `semanticIndex` 说谎。
- 与“标签止谎”直接冲突：模型候选必须带模型 provenance，不能复用 `rule_extraction`。

## 路线 B：前台显式写入 + 用户确认，夜间只合并/衰减

**定义**：用户在对话里显式说“记住这个偏好/目标/承诺”，壳把它写成带用户证据的候选或直接
确认；夜间 Dream 不再推断新分类，只做去重合并、activation decay、Atlas 投影和过期 review。

### 接线成本

1. 前台捕获入口：一个命令或模型工具（例如 `/remember` 或 `propose_*`），把用户原话 +
   `sourceRefs` 写成候选；确认后才晋升。可复用 `ProspectiveMemoryService` 的
   confirm/reject/defer、`ProfileCompiler` 的 correct、以及现有 candidate review。
2. 夜间路径改成只合并/衰减：关闭 Dream curator 的模型分支，保留确定性 summary/规则帧；
   `runMaintenanceTick` 已有 decay、Atlas refresh、review TTL。
3. 需要定义“显式”的最小语法/工具，以及未确认候选的 TTL 和展示面。
4. 不需要新表；也不需要夜间模型调用。

### 验证法

- **端到端**：用户说一句 → 候选出现 → 用户确认 → recall 能召回；未确认 → recall 不可见。
- **幂等**：夜间跑两遍，第二遍零新候选、零重复合并、decay 幂等。
- **对照 A**：同一语料下 B 的召回覆盖率（预期更低）与错误率（预期更低）；记录用户确认率。
- **隐私**：夜间零模型调用（provider stub 断言 0 次）。

### 风险

- 漏记：用户不会每次都显式标注，隐式偏好会丢失。
- 打断成本与确认疲劳；“显式”仍可能被模型误解析，必须保留原文证据。
- 覆盖上限低：召回质量取决于用户写不写，而不是系统读不读。
- 六层语义不动：B 只改写入时机/确认流程，不改分类结构。

## 对比

| 维度 | A：夜间模型推断 | B：前台显式 + 确认 |
| --- | --- | --- |
| 接线成本 | 中高：ModelRegistry + embedding 决策 + 成本/失败处理 | 中低：前台捕获入口 + 夜间关闭推断 |
| 模型依赖 | 夜间每 episode 调用 | 夜间零调用 |
| 召回上限 | 更高，能捕捉隐式偏好 | 更低，依赖用户显式写入 |
| 错误率/可审计性 | 模型幻觉、证据错误需要额外验证 | 用户原话 + 确认，证据链更短 |
| 隐私 | 对话送 provider | 夜间不出本机 |
| review 负担 | 候选多，必须 review | 候选少，主要是确认 |
| 与 `semanticIndex` 契约 | 只配 memory 会让标签不实；配 embedding 则契约变化 | 可继续保持 `rule_only`，契约不变 |
| 与“标签止谎” | 必须严格区分 model / rule provenance | 本轮 `rule_extraction` 已诚实 |

## 与“给壳接上模型角色”的关系（本票核实结论）

给壳接 `memory` 模型本身是机械小改（构造 `ModelRegistry`），但它**不是不改变召回契约的小改**：

- 只配 `memory` role：`semanticIndexEnabled()` 翻 `true`，embedding 仍是
  `deterministic_local`，召回结果会声称有语义索引，实际没有——这正是 #231 要止的标签谎言。
- 同时配 `embedding` role：召回从词面走向语义，需要 re-embed 存量神经元，属于召回契约变化。
- 因此本票**没有**顺手接模型；它归入路线 A 的接线成本，等 Ryu 先选路线。

如果 Ryu 选 A，建议同时拍板四件事：`embedding` role、`semanticIndexEnabled()` 的判据、
候选 provenance（`llm_inference` vs `rule_extraction`）、夜间成本上限。如果选 B，壳可以继续
`rule_only`，夜间零模型调用。

## 本轮已做 / 未做

- 已做：`rule_extraction` provenance + 壳 `/candidates` 只读面。
- 未做：任何模型接线、候选审批入口、分类语义改动。

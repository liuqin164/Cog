# 第 195 轮 5.0 工程自审

- 日期：2026-11-22
- 审计基底：`main` `8bd6f769`（工作树与基底同一提交）
- 报告分支：`t3/195-self-audit`
- 方法：ponytail（最小实现、删胜于加、复用胜于新建、找死代码/重复逻辑/绕路）＋ mattpocock 工程纪律（类型安全、错误处理、测试有效性、接口契约、性能、并发/时序）
- 范围：全仓只读。重点按重要性覆盖记忆内核（编译/召回/治理/遗忘）、状态机与笼子、插件与提议/批准面、观测台/星海只读面、安装/升级/备份路径。
- 产出：仅本文件。未改任何业务代码、未提交业务改动。

## 结论

整体不是“到处烂”的代码库：状态机转移表、笼子的工具白名单、观测台的只读连接、插件路径包含检查、召回的秘密/生活敏感扣留都有真实测试和清楚的不变量。问题集中在三类：

1. **隐私删除后的读面缓存**：`/forget` 删了库，观测台仍可从进程内缓存返回已删记忆；这是可复现的隐私泄漏。
2. **覆盖写不是原子的**：快照导入/升级回滚直接覆盖整库文件；一次 `ENOSPC` 或进程中断就可能把旧脑截断。
3. **治理证据权威没有在服务层守住**：assistant 证据可以通过 `correct`/`reinforce` 推翻用户拥有的信念；候选审核还可以拿“生成候选的同一事件”当确认证据。

阻塞项建议在 5.0 前修掉，或在发布说明里明确接受风险；重要项至少应在 5.0 前补测试和工单。

## 统计

- 总发现：15
  - 阻塞：3
  - 重要：7
  - 建议：5
- 静态覆盖：956 个 tracked 文件；323 个 `src/**/*.ts`；317 个测试文件（218 个 `__tests__`＋99 个 `shell/test`）；`.skip/.todo` 为 0。
- 逐段阅读（含切片）：84 个文件（源码、壳、测试、标准/模型文档）。
- 模式扫描：`as any` 74 处、`@ts-nocheck` 4 个文件、空 `catch {}` 5 处（不含打包的 `three.bundle.js`）；没有 `eslint-disable`，没有 TODO/FIXME/HACK。
- 针对性测试：`bun test __tests__/candidate-review.unit.test.ts __tests__/belief-graph-v1.unit.test.ts` → **9 pass / 0 fail，34 expect，2 files**。
- 类型检查：`bun run typecheck` 在本工作树无法启动，缺 `node_modules`，报 `TS2688 Cannot find type definition file for 'bun-types'`；这是环境缺依赖，不是本轮判定的代码失败。
- 全量 `prepublishOnly` 未跑：本轮是只读审计，且工作树没有依赖；上面 9 条测试与三条临时探针是实际观察到的结果。

## 发现

### 阻塞

#### 1. 观测台进程内缓存跨 `/forget` 返回已删除的记忆

- 严重度：阻塞
- 文件:行：`src/observatory/MemoryObservatory.ts:380`（`stamp`）、`:399-401`（按 stamp 命中缓存）；`shell/src/sovereignty.ts:49-58`（`/forget confirm` 的删除入口，没有缓存失效）
- 问题是什么：观测台把整个项目的聚合结果缓存在进程内，缓存键只由 `MAX(memory_events.global_seq)`、`MAX(memory_atlas_documents.updated_at)`、`MAX(soul_versions.created_at)`、`MAX(beliefs.updated_at)` 拼成。删除旧事件/图节点不会保证这些最大值下降，因此 stamp 可以完全不变，缓存继续返回删除前的节点和事件文本。
- 最小证据：
  ```ts
  return `${watermark}:${atlas?.stamp ?? 0}:${soul?.stamp ?? 0}:${belief?.stamp ?? 0}`;
  ...
  const cached = this.cache.get(projectId);
  if (cached && cached.stamp === stamp) return cached;
  ```
  我用临时库复现：先 `snapshot()`，再删除一条 `memory_events` 和对应 `memory_atlas_documents`，第二次 `snapshot()` 仍返回 `raw_event:evt-0`；两次 watermark 都是 3，`leaks: true`。
- 为什么这是问题：`/forget` 对用户承诺“已删除”，但星海/`/observatory/snapshot` 仍会展示被删的节点与文本，直到进程重启或某个恰好更新的 atlas 文档把 stamp 改掉。观测台是隐私删除后的主要读面之一，缓存不识别删除就等于删除没有完成。
- 建议修法：把删除也纳入 stamp（例如 `PRAGMA data_version`、项目事件/文档行数、或显式的 deletion generation），或在 `forget`/`deleteRange` 后清空对应项目的缓存；加一个“snapshot → delete → snapshot”的回归测试。
- 影响面：`/observatory/snapshot`、`timeline`、`recalls` 等所有走 `aggregate()` 的只读面；在常驻壳里是进程生命周期级残留。

#### 2. 快照导入/升级回滚直接覆盖整库，失败会截断旧脑

- 严重度：阻塞
- 文件:行：`src/snapshot/SnapshotImporter.ts:52-57`；使用点：`shell/src/upgrade/supervisor.ts:327`（升级回滚的 `restoreSnapshot`）、`src/bin/snapshot.ts:94-102`、`src/factory.ts:2123`
- 问题是什么：`SnapshotImporter.import(..., { overwrite: true })` 在目标已存在时直接 `writeFileSync(targetDbPath, dbBytes)`。没有临时文件、没有 `fsync`、没有 `rename`。升级回滚在调用前还会先删掉 `-wal`/`-shm`（`supervisor.ts:319-325`），所以目标库在写入期间没有可回退的旧副本。
- 最小证据：
  ```ts
  if (existsSync(targetDbPath) && opts.overwrite !== true) {
    throw new SnapshotTargetExistsError(targetDbPath);
  }
  writeFileSync(targetDbPath, dbBytes);
  ```
  同一个仓库的 `BrainBundle.restoreBundle` 已经做对了：先写 `stagedPath`，校验 counts，再 `renameSync(stagedPath, targetDbPath)`（`src/snapshot/BrainBundle.ts:106-124`）。
- 为什么这是问题：快照字节已经过 checksum/维度校验，但**写入目标**仍可能因磁盘满、权限变化、进程被 kill 而只写一半。此时旧数据库已经被截断，升级回滚也失去了最后的“旧版脑”；这不是“多一次重试”能救的场景。
- 建议修法：导入也写成 `<target>.restore-<rand>.db`，校验/`fsync` 后原子 `rename`；成功后再清理 `-wal`/`-shm`。删 WAL 的顺序应移到 rename 成功之后。
- 影响面：`/upgrade` 的 gate/switch/health 失败回滚、`cogmem snapshot import --overwrite`、任何宿主调用 `MemoryKernel.importSnapshot` 的路径。一次 ENOSPC 可能造成整脑不可恢复。

#### 3. `BeliefGovernanceService` 允许 assistant 证据推翻用户拥有的信念

- 严重度：阻塞
- 文件:行：`src/belief/BeliefGovernanceService.ts:70-71`（只在新输入 `ownership === 'user'` 时要求用户证据）、`:89-94`（`correct` 直接 supersede 当前 active 行）、`:153-164`（`reinforce` 直接给当前行加证据并升置信度）
- 问题是什么：`apply()` 先按 `canonicalKey` 找到当前 active 信念，然后只要新输入的 `relation` 是 `correct`，就无条件把当前行标为 `superseded`；新输入可以声明 `ownership: 'project'`，证据可以是 assistant/tool 事件。于是“用户边界/偏好”可以被一条项目观察覆盖。
- 最小证据：我按以下顺序调用并实测：
  ```ts
  // user-owned boundary, evidence u1 (user)
  // project-owned observation, same canonicalKey, evidence a1 (assistant), relation: 'correct'
  ```
  结果：旧行 `status` 从 `active` 变 `superseded`，当前行 `ownership: 'project'`、`sourceRoles: ['assistant']`。
- 为什么这是问题：`MEMORY_MODEL.md` 的硬规则是“User-owned beliefs require explicit user evidence; assistant/tool-only evidence is limited to project observations and cannot establish user preferences, goals, or boundaries”。这里 assistant 证据没有“建立”一个新的用户信念，但它**替换掉了**用户信念，效果相同，且 test suite 没有覆盖跨 ownership 的 correction。`reinforce` 同样能让 assistant 证据给用户信念加权。
- 建议修法：当 `current.ownership === 'user'` 时，`correct`/`reinforce`/同句 `assert` 必须要求本次证据里至少有一条**不同于**当前证据的用户事件；或者把“项目观察”和“用户信念”放到不同 canonical key 空间，禁止跨空间 supersede。
- 影响面：`BeliefGovernanceService` 是 `public.ts`/`internal.ts` 导出的治理面；宿主用它写信念时，assistant/tool 观察可以获得对用户边界的最终解释权。主壳当前没有调用它，但这是公开契约的漏洞。

### 重要

#### 4. 候选审核用“生成候选的同一事件”当确认证据

- 严重度：重要
- 文件:行：`src/governance/CandidateReviewService.ts:159-165`；`:187-190`
- 问题是什么：`requireUserConfirmation()` 只检查事件存在、同项目、`role === 'user'`；不检查该事件是否已经在候选的 `evidence` 里，也不检查它是否晚于候选证据。`appendConfirmationEvidence()` 在事件已存在时只是不重复追加。
- 最小证据：现有测试 `__tests__/candidate-review.unit.test.ts:45-51` 直接把 `confirmation.eventId` 作为候选的 `evidenceEventId`，然后用同一个 `confirmationEventId` approve；测试通过，候选变 `promoted`。这与 `MEMORY_MODEL.md:94` 和 `src/bin/memory.ts:198` 的“distinct same-project raw user evidence”直接矛盾。
- 为什么这是问题：一条由用户事件派生的模型候选，可以拿同一条用户事件作为“主人确认”而进入 promoted；审核审计里记录了 `confirmationEventId`，但它没有提供任何新信息。这正是治理要防止的“把模型猜测写成已验证事实”。
- 建议修法：照 `ProspectiveMemoryService` 的确认规则（`src/prospective/ProspectiveMemoryService.ts:138-155`）做：拒绝 `candidate.evidenceEventIds.includes(confirmationEventId)`，要求 `globalSeq` 晚于候选全部证据，并保留“同一确认事件不能用于多个候选”的检查。
- 影响面：`cogmem memory review --approve/--relink`、`reviewDreamCandidate`、所有候选审核审计行；模型候选的 promotion 信任链。

#### 5. 备份轮换把“验证失败的新快照”也算进保留数，能挤掉验证通过的旧快照

- 严重度：重要
- 文件:行：`src/snapshot/BrainBackup.ts:85-90`、`:193-201`
- 问题是什么：`snapshot()` 无论 `manifest.verification.ok` 是否为真都会 `recordLast()` 并 `rotate(dir)`；`rotate()` 只看文件名 `brain-*.snap`，按数量保留最新 `SNAPSHOT_RETENTION` 个，不区分该快照是否通过 checksum/opens/counts。
- 最小证据：
  ```ts
  manifest.verification = this.verifyFiles(...);
  writeFileSync(manifestPath, ...);
  if (manifest.verification.ok) this.archive(...);
  this.recordLast(...);
  this.rotate(dir); // rotate 不读 verification
  ```
- 为什么这是问题：如果夜间快照连续失败（磁盘满、临时目录不可写、数据库在写入时被锁），这些坏文件仍会占住 7 个保留位；每失败一次就删掉最旧的一个**验证通过**的快照。7 个坏夜之后，目录里可能一个可恢复的 verified 快照都不剩。周归档只保护每周第一个 verified，不能覆盖这种连续失败。
- 建议修法：`rotate()` 只按 verified manifest 排序/保留；验证失败的快照用独立名称或单独目录，不能挤掉 verified 快照。`archive()` 的 `copyFileSync` 也应改成临时文件＋rename。
- 影响面：`/health` 的 `snapshot` 读数、F19 恢复演练、长期无人值守的夜间备份。

#### 6. 快照失败后 `lastSnapshotAt` 已前进，24 小时内不再重试

- 严重度：重要
- 文件:行：`shell/src/resident-tick.ts:462-477`
- 问题是什么：`maybeSnapshot()` 在调用 `backup.snapshot()` **之前**就 `updateRuntime({ lastSnapshotAt: at })`；失败只写一条 `snapshot_failed` trace，不重试。下一次 tick 看到 `at - lastSnapshotAt < 24h` 就直接返回。
- 最小证据：
  ```ts
  if (last !== undefined && at - last < SNAPSHOT_INTERVAL_MS) return;
  this.shell.machine.updateRuntime({ lastSnapshotAt: at });
  try { const manifest = await this.shell.kernel.backup.snapshot(); ... }
  catch (error) { this.shell.trace.append('snapshot_failed', ...); }
  ```
- 为什么这是问题：一次 ENOSPC、临时目录不可写或短暂锁冲突，会让当天没有快照，且不会在下一个 tick 补；这与 Dream 的 5/10/20/30 分钟退避、整夜最多 5 次形成明显反差。备份代码已经“记了失败”，但没有安排恢复。
- 建议修法：成功后再推进 `lastSnapshotAt`；失败保留旧值或写一个 `snapshotRetryAt` 做短退避（例如 5/10/20/30 分钟），并在 `/health` 暴露“上次成功/上次失败”。
- 影响面：无人值守夜间备份；与第 5 条叠加时，连续失败既无补拍又会挤掉旧 verified 快照。

#### 7. 插件提案的源码哈希在批准后不再校验

- 严重度：重要
- 文件:行：`shell/src/plugins/self-install.ts:220-243`（计算/展示 `sourceSha256`）；`shell/src/plugins-admin.ts:155-172`（安装只传 `proposal.sourcePath`）；`shell/src/plugins/load.ts:91-130`（安装时重新读当前文件）
- 问题是什么：提案记录并展示 `sourceSha256`，但 `installProposal()` 只检查 `approvedAt`，然后把路径交给 `installPlugin()`；`checkPluginSpec()` 重新读取当前路径做大小/密钥/可解析/包含检查，**不比较哈希**。
- 最小证据：
  ```ts
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  // proposal: { sourcePath: entry, sourceSha256, ... }
  ...
  const reply = await this.installPlugin(proposal.sourcePath, { ... });
  ```
- 为什么这是问题：批准卡片给主人的证据是“路径＋字节数＋哈希”，但实际加载的可以是批准后、安装前被替换的文件；哈希只成了展示文本，不是安装不变量。提案路径在 `<dataDir>/plugin-workspace`，0600 只能挡住别的用户，挡不住同一用户下的其它进程；如果沙箱不可用，模型自己的 `bash` 也能接触这个目录。
- 建议修法：在 `installProposal()` 读回文件并重算 SHA-256，不匹配就拒绝并 trace；或者安装时只加载批准时冻结的副本（copy-on-approve）。同时把安装实际哈希写进 `plugin_registered` 审计。
- 影响面：`propose_plugin` → 批准卡片 → `/plugins add` 自装链；插件可以注册工具并进入笼子白名单，哈希不校验使“批准的是哪份代码”不可证明。

#### 8. 安装状态、env（含模型密钥）和模型路由文件都是原地写

- 严重度：重要
- 文件:行：`shell/src/install/installer.ts:257-271`（`loadState` 静默回退、`saveState` 直接写）、`:286-294`（`writeEnvFile` 直接写）；`shell/src/model/routes.ts:197-208`（`RouteStore.save` 直接写）
- 问题是什么：这三个文件都直接用 `writeFileSync(path, ...)` 覆盖原文件。`loadState()` 在 JSON 解析失败时静默返回“全新安装”，`writeEnvFile` 的文件里有模型 API key，`RouteStore` 的文件里每个自定义路由都带 `apiKey`。
- 最小证据：
  ```ts
  writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  ...
  writeFileSync(this.envPath, serializeEnvFile(merged), { mode: 0o600 });
  ...
  writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
  ```
  同仓库的 checkpoint/插件注册表/升级记录已经使用 temp＋fsync＋rename（`shell/src/state/checkpoint.ts:425-445`、`shell/src/plugins/registry.ts:46-52`、`shell/src/upgrade/records.ts:157-166`）。
- 为什么这是问题：安装器在六个步骤里写状态，在模型步骤写密钥；一次 kill/ENOSPC 可能留下半截 JSON。状态文件坏了会静默从 step 0 重来，env 文件坏了会丢密钥，routes 文件坏了会丢所有自定义路由；这些都不是“重启后自愈”的数据。
- 建议修法：复用已有的原子写 helper（temp 文件、fsync、rename、目录 fsync）；`loadState` 对损坏文件应报错并保留 `.broken`，而不是当全新安装。
- 影响面：安装/续装、模型路由切换、任何依赖 `$COGMEM_CONFIG`/env 的宿主；密钥丢失是用户可见的破坏。

#### 9. `forgetUser` 在 65,535 个事件以上会因 SQL 变量数失败；且与 `deleteRange` 是两套删除实现

- 严重度：重要
- 文件:行：`src/factory.ts:2205-2210`（把所有 `sourceEventIds` 塞进 `IN (...)`）、`:2258` 之后的多处删除；`src/governance/PrivacyDeletionRegistry.ts:208-216`、`:270-273`
- 问题是什么：`forgetUser(projectId)` 先读出该项目全部 event id，然后把它们展开成 `?` 列表，多次传给 `DELETE ... WHERE ... IN (...)`。Bun 1.3.14 实测：65,535 个占位符可以，65,536 个开始报 `SQLite query expected ... values`/`too many SQL variables`。
- 最小证据：
  ```ts
  WHERE COALESCE(project_id, '') = ? OR neuron_id IN (${sourceEventIds.map(() => '?').join(', ')})
  ...
  DELETE FROM reasoning_steps WHERE neuron_id IN (${placeholders})
  ```
  实测阈值：`n=65535` ok；`n=65536` fail。
- 为什么这是问题：`forgetUser` 是公开 API，`MEMORY_MODEL.md` 明确把它作为整项目遗忘入口；一个多年账本超过 6.5 万事件并不离谱。失败时整次删除在第一个大 `IN` 就抛错，用户无法完成隐私删除。壳里的 `/forget` 走的是 `MemorySovereigntyService.deleteRange`（临时表 `_sovereignty_event_ids`，分页扫描），所以这条 `forgetUser` 路径既没有日常调用者，也没有大库测试，容易继续漂移。
- 建议修法：`forgetUser` 改成与 `deleteRange` 相同的临时表/分批方案，或直接复用 `deleteRange` 的全量窗口实现；补一条 65,536+ 合成 id 的测试（不必真写 6.5 万事件，可以直接测占位符构造）。
- 影响面：公开 `forgetUser`、宿主调用整项目遗忘；与 `/forget` 的范围删除存在双实现漂移风险。

#### 10. 状态机“已 halt”后，`updateRuntime`/`addWakeIntent` 仍能写 checkpoint

- 严重度：重要
- 文件:行：`shell/src/state/machine.ts:99-123`（`updateRuntime`、`addWakeIntent`、`consumeWakeIntent` 直接 `commit`）、`:130-131`（只有 `dispatch` 检查 `halted`）、`:170-183`（`commit` 不检查 `halted`）
- 问题是什么：一次 checkpoint 写失败会把 `halted = true`，`dispatch` 之后抛 `StateMachineHaltedError`；但 `updateRuntime()`、`addWakeIntent()`、`consumeWakeIntent()` 不经过这个检查，仍会调用 `commit()`。如果磁盘随后恢复，它们会把新的 runtime/wake intent 写到磁盘，并更新内存。
- 最小证据：我构造了一个第一次 `save` 抛 `CheckpointWriteError`、第二次成功的 store：
  - `dispatch('message_received')` → 抛错，`halted: true`
  - 随后 `updateRuntime({ lastAttachAt: 123 })` → 写入成功，`runtime.lastAttachAt === 123`，`machine.halted` 仍为 true。
- 为什么这是问题：文件开头写的是“A failed write halts the machine with the old state rather than continuing from a state the disk never saw”。现在 halt 只挡住了状态迁移，没挡住 runtime 写入；一个已经宣告停止的机器仍能改变磁盘上的 checkpoint，重启恢复会读到这些“停止后”的字段。
- 建议修法：在 `commit()` 入口检查 `halted` 并抛 `StateMachineHaltedError`，或在三个直接调用点统一走一个受保护的 `commit`；补“halt 后 updateRuntime/addWakeIntent 必须抛”的测试。
- 影响面：checkpoint 写失败后的恢复、wake intent 调度、运行时状态可信度；属于“状态机与笼子不可错”的面。

### 建议

#### 11. Atlas 召回刷新有 24 小时节流，和“write-driven / next query refreshes”的文档契约不一致

- 严重度：建议
- 文件:行：`src/factory.ts:511-515`；`src/store/MemoryAtlasStore.ts:681-697`（`markProjectionDirty` 保留旧 `last_rebuild_at`）
- 问题是什么：`refreshAtlasForRecall()` 在项目 dirty 时仍会检查 `Date.now() - lastRebuildAt < 24h` 并直接返回。`MEMORY_MODEL.md:183` 写的是“next Kernel or CLI Atlas query refreshes only that project”；`FEATURE_MAP.md:14` 又写“Atlas 按天和解”。两处契约至少有一处不准确。
- 最小证据：
  ```ts
  if (!state || state.status === 'clean') return;
  if (state.lastRebuildAt !== undefined && Date.now() - state.lastRebuildAt < ATLAS_RECALL_REFRESH_MS) return;
  ```
- 为什么这是问题：如果“按天和解”是设计，文档应明确召回可能 stale 24h；如果不是，代码应刷新 dirty 项目。当前实现会让写后召回在最多 24h 内看不到新 Atlas 节点，只能靠 raw ledger 兜底；对“星海/Atlas 是导航面”的用户是可见延迟。
- 建议修法：二选一——把 24h 明确写进 `MEMORY_MODEL.md`/CLI 帮助，或去掉召回路径的 24h 限制、只保留一个短 debounce；用假时钟测试“写入→召回”的新鲜度。
- 影响面：`searchAtlas`/`graphExplore` 的召回新鲜度、星海页面；不影响 raw ledger 的直接召回。

#### 12. `MemoryAtlasStore.listEdges(projectId)` 对 action frames 无上限，并且逐 action 查证据

- 严重度：建议
- 文件:行：`src/store/MemoryAtlasStore.ts:394-408`
- 问题是什么：`memory_edges` 有 `LIMIT 2000`，但 `memory_action_frames` 的查询没有 `LIMIT`；每个 action 还会调用一次或两次 `actionEvidenceIds()`（`:602-604`），形成 N+1 查询并构造无上限的数组。
- 最小证据：
  ```ts
  const actions = this.db.prepare(`SELECT ... FROM memory_action_frames WHERE project_id=?`).all(projectId);
  for (const action of actions) {
    ... evidenceEventIds: this.actionEvidenceIds(action.action_id, projectId) ...
    ... evidenceEventIds: this.actionEvidenceIds(action.action_id, projectId) ...
  }
  ```
- 为什么这是问题：`MemoryAtlasService.overview()` 在没有节点边时会调用 `listEdges()` 来回答“到底有没有关系”（`src/atlas/MemoryAtlasService.ts:51`）。一个有大量 action frames、但节点边为 0 的项目，会在打开 graph overview 时付出几千次查询和大量内存；这是可被真实数据触发的性能陷阱。
- 建议修法：给 action 查询加 `LIMIT`；用一次 `WHERE action_id IN (...)` 批量取证据；总数组也设上限并在 `warnings` 里报告截断。
- 影响面：`cogmem graph`/星图 overview、观测台读取；大项目或 action 密集项目会明显变慢/占内存。

#### 13. 四个文件用 `@ts-nocheck` 绕过发布门禁，其中两个在治理/检索链上

- 严重度：建议
- 文件:行：`src/belief/BeliefStore.ts:1`、`src/retrieval/ConditionDslEvaluator.ts:1`、`src/models/ModelRegistry.ts:1`、`src/batch/InstalledBatchProcessor.ts:1`
- 问题是什么：全仓 4 个 `// @ts-nocheck`，而 `bun run typecheck` 是 `prepublishOnly` 的硬门。`BeliefStore` 负责信念 upsert/冲突/证据，`ConditionDslEvaluator` 解析存储的/模型生成的条件 DSL；它们恰好是最需要类型保护的地方，却完全不在类型检查范围内。
- 最小证据：四个文件第 1 行均为 `// @ts-nocheck`；`rg '@ts-nocheck' src shell/src` 计数为 4。
- 为什么这是问题：类型门禁给出“全绿”的错觉；当 JSON/数据库行形状变化时，这些文件不会阻止 release。`BeliefStore` 里大量 `as any[]`/`mapBelief(row: any)` 是已知的脏边界，`@ts-nocheck` 把边界内的错误也一并放过。
- 建议修法：逐步移除指令，至少把 `BeliefStore` 和 `ConditionDslEvaluator` 先恢复类型检查；临时无法修的用 `@ts-expect-error` 精确标注。加一个脚本/CI 规则禁止新增 `@ts-nocheck`。
- 影响面：类型安全、发布门禁可信度；目前不会直接导致运行时错误，但会让错误更晚被发现。

#### 14. `EventStore.append` 对 `database is locked` 做无延迟重试，和并发契约相反

- 严重度：建议
- 文件:行：`src/store/EventStore.ts:311-317`；契约：`CONCURRENT_ACCESS.md:23`
- 问题是什么：`append()` 捕获到 `database is locked` 后立即递归重试最多 5 次（没有 sleep/backoff）。`CONCURRENT_ACCESS.md` 明确写“Treat `database is locked` as a signal to serialize, not to retry”；而且 `busy_timeout` 已经是 5000ms，第一次失败通常已经等了 5 秒。
- 最小证据：
  ```ts
  if ((streamConflict || message.includes('database is locked')) && input.eventVersion === undefined && retry < 5) {
    return this.append(input, retry + 1);
  }
  ```
- 为什么这是问题：这会把一次已经等了 5 秒的锁冲突变成最多约 25 秒的忙等，并掩盖“应该串行化”的信号；对驻留进程的 tick/命令延迟不友好，也不符合仓库自己写下的并发契约。唯一需要重试的是 `UNIQUE` 流版本竞争，那可以保留。
- 建议修法：只对 `streamConflict` 重试（或用 `INSERT ... ON CONFLICT` 解决版本竞争）；`database is locked` 直接抛给调用者/由单一 writer 串行化。
- 影响面：并发读写的 CLI/宿主、`SQLITE_BUSY` 下的用户可见延迟；不影响单 writer 正常路径。

#### 15. 召回词频缓存没有失效机制，常驻进程会一直用旧的“稀有/常见”判断

- 严重度：建议
- 文件:行：`src/agent/AgentRecallEngine.ts:718-735`
- 问题是什么：`RAW_TERM_DF_CACHE` 以引擎实例为 key，按 `scopeKey + probe` 缓存 `countRawEventMatches(..., cap: 3)` 的结果；没有 watermark/TTL/失效。`count` 只在 0/1/2/3 之间，语料增长后一个词从稀有变常见，缓存仍把它当稀有。
- 最小证据：
  ```ts
  let count = cache.get(key);
  if (count === undefined) {
    count = this.kernel.countRawEventMatches(probe, { projectId: query.projectId, cap: FREQUENT_TERM_MIN });
    cache.set(key, count);
  }
  (count >= FREQUENT_TERM_MIN ? frequent : rare).add(probe);
  ```
- 为什么这是问题：这个判断用于社交/闲聊门的“只由常见词组成”规则；长期常驻的壳里，缓存会让新近变成高频的词永远被当稀有，社交噪声更容易进入上下文。它不是安全漏洞，但是真实的召回质量问题，而且和 `#321` 的抑制规则相关。
- 建议修法：缓存带 ledger watermark 或短 TTL；在 `EventStore` append 后按项目递增 generation，generation 变了就清缓存。
- 影响面：召回/社交门排序与抑制；不影响数据库内容。

## 审过且认为干净的面

- **状态机转移表**：`shell/test/state-machine.test.ts` 对每条合法边逐一测试，并对所有非法 state/trigger 对断言 `IllegalTransitionError`；表本身没有漏边或重复边。除第 10 条的 halt 缺口外，迁移流程是干净的。
- **笼子**：工具白名单在 `beforeToolCall` 拦截，嵌套 `runToolCall` 走同一 `executeToolCall` 管线（`shell/src/state/agent-loop.ts:175-211`）；回合/令牌预算在每轮请求前和用量后检查；没有发现绕过白名单的路径。
- **观测台只读面**：`src/observatory/*.ts` 没有 `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP`；`HttpServer` 用 `readonly: true` 连接，路由检查 loopback、Host、写令牌；灵魂/凭据写面有单独的 JSON content-type + token 门。第 1 条是缓存失效问题，不是写路径问题。
- **插件装载/卸载**：路径用 realpath＋workspace 包含检查，限制大小/密钥/可解析；host 对工具名、命令名、服务名做冲突拒绝；`unload` 注销工具/命令/服务并跑 disposer。除第 7 条哈希 TOCTOU 外，装载路径未发现绕过。
- **召回的秘密/生活敏感扣留**：`AgentRecallEngine.recallPrivate` 在返回前做 secret/life/agent/occasion 门；`mergeRecallItems` 在截断前处理扣留与 supersede；`#391` 的回填测试实际存在。未发现召回正文直接泄漏敏感文本的路径。
- **快照格式与 bundle 恢复**：`SnapshotExporter` 做 checksum，`BrainBundle.restoreBundle` 做 checksum/byteLength/counts 校验并用 staged temp＋rename；`SnapshotImporter` 是例外（第 2 条）。
- **测试卫生**：317 个测试文件全部有断言，0 个 `.skip/.todo`；状态机表穷举、插件 host 冲突、观测台只读哈希、召回扣留都有真实测试。第 4 条是测试把错误行为钉成了“通过”，不是空洞测试。
- **错误处理**：5 处空 `catch {}` 都出现在清理/兼容/通知路径（`scripts/sweep-temp-dirs.ts`、`scripts/temp-prefixes.ts`、`shell/src/channels/web.ts:159/262` 的 presence/节点通知、`src/factory.ts:358` 的旧 payload 解析）；没有发现把业务失败吞掉的空 catch。

## 验证记录与限制

- 定向测试：`TMPDIR="$PWD/.cogmem/tmp" bun test __tests__/candidate-review.unit.test.ts __tests__/belief-graph-v1.unit.test.ts` → 9 pass / 0 fail。
- 可复现探针（临时库，均在 `.cogmem/tmp` 下，已删除）：
  1. 观测台：`snapshot → 删除 memory_events/memory_atlas_documents → snapshot` 仍返回已删节点，`leaks: true`。
  2. 治理：用户 `boundary` → assistant 证据 `relation: 'correct'` → 旧行 `superseded`，当前行 `ownership: 'project'`、`sourceRoles: ['assistant']`。
  3. 状态机：首次 checkpoint 写失败 → `halted: true` → `updateRuntime()` 仍成功写入，`runtime.lastAttachAt` 更新。
  4. SQLite 变量上限：Bun 1.3.14 下 65,535 个占位符 ok，65,536 个 fail。
- 未跑：全量 `bun test __tests__`、`bun run build`、`npm pack --dry-run`、`bun run typecheck`（工作树没有 `node_modules`，`bun-types` 缺失）。本轮交付是审计报告，不是发布门禁结果；这些应在正式合并/发布前按 CI 重跑。
- 未覆盖：Amazon Quick 的外部审计结果、#310 密钥轮换、#375 的 box 复现、#165 的 7 天生存跑；按 brief 这些不在本轮重审范围。

## 提交记录

- 审计基底：`8bd6f769`。
- 报告分支：`t3/195-self-audit`。
- 报告提交：`chore(audit): add round-195 self-audit report`。提交后的 `HEAD` 以 `git rev-parse HEAD` 与 #165 的 round 报告为准（提交哈希不能写进自身内容而不改变自身哈希）。

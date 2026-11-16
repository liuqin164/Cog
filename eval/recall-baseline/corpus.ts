/**
 * The 30-item paraphrase corpus for the #250 A6 recall baseline.
 *
 * Every query is a rewrite of its target: different wording, different sentence
 * shape, sometimes an implicit reference. `keyTerms` are the words a literal
 * matcher would use to win; the corpus check in `run.ts` fails if one of them
 * appears in the query, so a rule-only score cannot be inflated by the corpus.
 *
 * 20 targets are raw memory turns (written through
 * `KernelAgentMemoryBackend.rememberTurn`) and 10 are practice entries (written
 * through `KernelMemory.recordTaskEvent` + `procedures.compile`). The split is
 * 20/10 because `ProcedureCompiler.recall` caps a page at `PROCEDURE_RECALL_MAX`
 * (10), so a larger procedure pool could not be ranked end to end.
 */

export const EVAL_NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

export interface MemorySeed {
  kind: 'memory';
  id: string;
  /** The target memory as the owner wrote it. */
  text: string;
  /** The task description used to look for it. */
  query: string;
  /** Distinctive words from `text` that must not appear in `query`. */
  keyTerms: string[];
}

export interface ProcedureSeed {
  kind: 'procedure';
  id: string;
  domain: string;
  key: string;
  title: string;
  steps: string[];
  tools: string[];
  /** The task description used to look for it. */
  query: string;
  /** Distinctive words from the entry that must not appear in `query`. */
  keyTerms: string[];
}

export type Seed = MemorySeed | ProcedureSeed;

export const MEMORY_SEEDS: MemorySeed[] = [
  {
    kind: 'memory',
    id: 'm01',
    text: '每周三下午两点在 3 号会议室开产品同步会。',
    query: '查一下各条业务线的例行碰头定在哪个半天、什么时刻，地点是哪间屋子。',
    keyTerms: ['周三', '两点', '3 号', '会议室', '产品同步会'],
  },
  {
    kind: 'memory',
    id: 'm02',
    text: '生产数据库的备份保留 90 天，超期自动清理。',
    query: '确认线上库的历史副本最多留多久，过期后会被怎么处理。',
    keyTerms: ['生产数据库', '备份', '90 天', '超期', '清理'],
  },
  {
    kind: 'memory',
    id: 'm03',
    text: '项目代号是“青岚”，对外一律使用这个称呼。',
    query: '弄清这个计划的内部叫法是什么，跟外部沟通时该用哪个说法。',
    keyTerms: ['项目代号', '青岚', '对外', '称呼'],
  },
  {
    kind: 'memory',
    id: 'm04',
    text: '部署窗口固定在每月第一个周二凌晨一点到三点。',
    query: '系统上线只能在每个月的哪个夜晚、哪几个小时做？',
    keyTerms: ['部署窗口', '第一个周二', '凌晨', '一点到三点'],
  },
  {
    kind: 'memory',
    id: 'm05',
    text: '证书在 12 月 15 日到期，续期由运维组负责。',
    query: '查一下那个加密凭证什么时候失效，归哪个组跟进更换。',
    keyTerms: ['证书', '12 月 15 日', '到期', '续期', '运维组'],
  },
  {
    kind: 'memory',
    id: 'm06',
    text: '新的索引重建任务安排在周日凌晨，避免影响白天查询。',
    query: '为了让检索服务白天不受干扰，翻新工作被挪到了哪个时间段？',
    keyTerms: ['索引', '重建', '周日', '凌晨', '查询'],
  },
  {
    kind: 'memory',
    id: 'm07',
    text: '客户数据导出必须经过安全审批，审批人是林晓。',
    query: '把用户资料带到外部之前，需要谁签字放行？',
    keyTerms: ['客户数据', '导出', '安全审批', '林晓'],
  },
  {
    kind: 'memory',
    id: 'm08',
    text: '每周五下午四点前提交周报，逾期会在群里点名。',
    query: '一周总结的截止时刻是什么时候，错过会有什么后果？',
    keyTerms: ['周五', '四点', '周报', '逾期', '点名'],
  },
  {
    kind: 'memory',
    id: 'm09',
    text: '测试环境地址是 test.internal.example，只能内网访问。',
    query: '预发那套服务从哪儿连、外网能不能打开？',
    keyTerms: ['测试环境', 'test.internal.example', '内网'],
  },
  {
    kind: 'memory',
    id: 'm10',
    text: '遇到 P0 故障先拉群，再在 15 分钟内给出初步结论。',
    query: '最严重的线上事故发生后，第一步做什么、多久要交出第一版判断？',
    keyTerms: ['P0', '故障', '拉群', '15 分钟', '初步结论'],
  },
  {
    kind: 'memory',
    id: 'm11',
    text: '采购部负责在每年 3 月续签供应商合同，联系人是王敏。',
    query: '外部合作方的协议多久重签一回、由哪个部门牵头？',
    keyTerms: ['供应商', '合同', '3 月', '续签', '采购部', '王敏'],
  },
  {
    kind: 'memory',
    id: 'm12',
    text: '官网的 CDN 缓存刷新要走工单，不能直接操作。',
    query: '让边缘节点上的旧内容失效，必须走什么流程？',
    keyTerms: ['官网', 'CDN', '缓存', '刷新', '工单'],
  },
  {
    kind: 'memory',
    id: 'm13',
    text: '新员工入职第一周要完成安全培训和信息登记。',
    query: '刚加入的人头七天需要办完哪两件事？',
    keyTerms: ['新员工', '入职', '第一周', '安全培训', '信息登记'],
  },
  {
    kind: 'memory',
    id: 'm14',
    text: '所有生产环境的配置变更都必须走 GitOps，不能手工修改。',
    query: '线上参数不能手工动，必须通过什么方式落地？',
    keyTerms: ['生产环境', '配置', '变更', 'GitOps', '手工修改'],
  },
  {
    kind: 'memory',
    id: 'm15',
    text: '每月最后一个工作日做一次成本复盘，财务和研发都参加。',
    query: '账单回顾多久一次、哪些部门的人要到场？',
    keyTerms: ['最后一个工作日', '成本复盘', '财务', '研发'],
  },
  {
    kind: 'memory',
    id: 'm16',
    text: '用户反馈的严重问题要在 24 小时内回复，哪怕还没修好。',
    query: '客户报上来的大毛病，最晚多久得先给个说法？',
    keyTerms: ['用户反馈', '严重问题', '24 小时', '回复'],
  },
  {
    kind: 'memory',
    id: 'm17',
    text: '代码合并前至少需要两位同事批准。',
    query: '把改动并进主干之前，要凑够几个人的同意？',
    keyTerms: ['代码合并', '两位同事', '批准'],
  },
  {
    kind: 'memory',
    id: 'm18',
    text: '灾备演练的切换窗口上限是 30 分钟，由基础设施组执行。',
    query: '容灾演习每次切换最多允许中断多久？',
    keyTerms: ['灾备演练', '切换窗口', '30 分钟', '基础设施组'],
  },
  {
    kind: 'memory',
    id: 'm19',
    text: '内部文档统一放在 Notion 的“工程手册”空间。',
    query: '团队资料集中存放在哪个协作平台的哪个分区？',
    keyTerms: ['内部文档', 'Notion', '工程手册'],
  },
  {
    kind: 'memory',
    id: 'm20',
    text: '每周一上午十点站会，每人说三件事。',
    query: '周初那个短会几点开始，每个人要讲几项内容？',
    keyTerms: ['周一', '上午十点', '站会', '三件事'],
  },
];

export const PROCEDURE_SEEDS: ProcedureSeed[] = [
  {
    kind: 'procedure',
    id: 'p01',
    domain: '发布',
    key: 'release',
    title: '发布新版本',
    steps: ['跑全量测试', '构建产物', '打标签', '推送仓库'],
    tools: ['bun', 'git'],
    query: '要把这次改动正式交给用户，按顺序该做哪些动作？',
    keyTerms: ['发布', '新版本', '全量测试', '构建', '标签', '仓库'],
  },
  {
    kind: 'procedure',
    id: 'p02',
    domain: '事故',
    key: 'rollback',
    title: '线上回滚',
    steps: ['确认影响范围', '切回上一个稳定版本', '通知值班', '补事故记录'],
    tools: ['kubectl'],
    query: '服务出问题后怎么退回到之前能用的那版？',
    keyTerms: ['线上回滚', '影响范围', '稳定版本', '值班', '事故记录'],
  },
  {
    kind: 'procedure',
    id: 'p03',
    domain: '数据',
    key: 'export',
    title: '导出客户数据',
    steps: ['提交审批', '脱敏', '生成压缩包', '走安全通道发送'],
    tools: ['审批系统', '加密工具'],
    query: '要把用户资料交给外部合作方，流程怎么走？',
    keyTerms: ['导出', '客户数据', '审批', '脱敏', '压缩包', '安全通道'],
  },
  {
    kind: 'procedure',
    id: 'p04',
    domain: '数据库',
    key: 'backup',
    title: '数据库备份',
    steps: ['锁定快照', '导出到冷存储', '校验可恢复', '登记保留期'],
    tools: ['pg_dump', '对象存储'],
    query: '怎么给线上库留一份以后能找回来的副本？',
    keyTerms: ['数据库备份', '快照', '冷存储', '可恢复', '保留期'],
  },
  {
    kind: 'procedure',
    id: 'p05',
    domain: '安全',
    key: 'rotate',
    title: '轮换访问密钥',
    steps: ['生成新密钥', '灰度替换', '观察错误率', '吊销旧密钥'],
    tools: ['密钥管理服务'],
    query: '长期使用的登录凭据该怎么换成新的而不中断服务？',
    keyTerms: ['轮换', '访问密钥', '新密钥', '灰度', '错误率', '吊销'],
  },
  {
    kind: 'procedure',
    id: 'p06',
    domain: '会议',
    key: 'retro',
    title: '迭代复盘',
    steps: ['收集数据', '列做得好的', '列待改进', '定行动项'],
    tools: ['白板', '文档'],
    query: '一个开发周期结束后，团队怎么坐下来总结经验？',
    keyTerms: ['迭代复盘', '收集数据', '行动项'],
  },
  {
    kind: 'procedure',
    id: 'p07',
    domain: '新人',
    key: 'onboarding',
    title: '新人上手',
    steps: ['开通账号', '读工程手册', '配开发环境', '跟一个真实任务'],
    tools: ['内部系统', '仓库'],
    query: '刚入职的工程师前几周按什么顺序熟悉工作？',
    keyTerms: ['新人上手', '开通账号', '工程手册', '开发环境', '真实任务'],
  },
  {
    kind: 'procedure',
    id: 'p08',
    domain: '监控',
    key: 'alert',
    title: '配置告警',
    steps: ['定义指标', '设阈值', '接通知渠道', '演练触发'],
    tools: ['监控平台'],
    query: '怎么让系统在数据不对劲时主动叫人？',
    keyTerms: ['配置告警', '指标', '阈值', '通知渠道'],
  },
  {
    kind: 'procedure',
    id: 'p09',
    domain: '成本',
    key: 'review',
    title: '云成本复盘',
    steps: ['拉账单', '找异常增长', '定优化项', '跟踪落地'],
    tools: ['账单平台', '表格'],
    query: '云上开销突然变高时，用什么例行办法查清楚？',
    keyTerms: ['云成本', '账单', '异常增长', '优化项'],
  },
  {
    kind: 'procedure',
    id: 'p10',
    domain: '文档',
    key: 'archive',
    title: '归档旧文档',
    steps: ['标记过期', '移到归档区', '更新索引', '通知相关人'],
    tools: ['文档平台'],
    query: '过时的资料该怎么收起来又不让人误用？',
    keyTerms: ['归档', '旧文档', '过期', '索引'],
  },
];

export const SEEDS: Seed[] = [...MEMORY_SEEDS, ...PROCEDURE_SEEDS];

/** The text every retrieval arm indexes for a seed. */
export function seedText(seed: Seed): string {
  if (seed.kind === 'memory') return seed.text;
  return `${seed.domain} ${seed.key} ${seed.title} ${seed.steps.join(' ')} ${seed.tools.join(' ')}`;
}

/** The human-readable target used in failure examples. */
export function seedLabel(seed: Seed): string {
  if (seed.kind === 'memory') return seed.text;
  return `${seed.title}（${seed.domain}/${seed.key}）: ${seed.steps.join(' → ')}`;
}

/**
 * Query trigrams, one run at a time so a trigram never spans punctuation.
 * The FTS arm uses these as an OR query; this is the same three-character
 * overlap the trigram tokenizer indexes, without treating the whole query as
 * one phrase (which would require a contiguous match and always miss).
 */
export function queryTrigrams(text: string): string[] {
  const runs = text.toLowerCase().match(/[\p{Script=Han}a-z0-9]+/gu) ?? [];
  const out = new Set<string>();
  for (const run of runs) {
    const chars = [...run];
    for (let index = 0; index + 3 <= chars.length; index += 1) {
      out.add(chars.slice(index, index + 3).join(''));
    }
  }
  return [...out];
}

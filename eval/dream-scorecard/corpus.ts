export type DreamRole = 'rule' | 'soul' | 'commitment' | 'intention' | 'experience' | 'ordinary' | 'correction';

export interface ClassificationItem {
  id: string;
  role: DreamRole;
  userText: string;
  assistantText: string;
  pair?: string;
  group?: string;
}

export interface CompileTurn {
  userText: string;
  assistantText: string;
}

export interface CompileDay {
  localDate: string;
  turns: CompileTurn[];
}

export interface GoldPoint {
  id: string;
  label: string;
  groups: string[][];
}

export interface CompileScenario {
  id: string;
  title: string;
  days: CompileDay[];
  gold: GoldPoint[];
  temporalUpdates?: TemporalUpdate[];
}

export interface TemporalUpdate {
  id: string;
  query: string;
  oldValue: string;
  newValue: string;
}

export const SCORED_ROLES: Exclude<DreamRole, 'correction'>[] = [
  'rule',
  'soul',
  'commitment',
  'intention',
  'experience',
  'ordinary',
];

export const CLASSIFICATION_CORPUS: ClassificationItem[] = [
  {
    id: 'rule-docs-language',
    role: 'rule',
    userText: '以后所有对外文档一律用中文写，不要再发英文版。',
    assistantText: '明白，之后都按中文版来。',
    pair: 'rule_vs_one_off',
  },
  {
    id: 'rule-no-meetings',
    role: 'rule',
    userText: '每周三晚上不要给我排会议，我要离线。',
    assistantText: '记下了，周三晚上不排会。',
  },
  {
    id: 'rule-free-cancellation',
    role: 'rule',
    userText: '订酒店一定要选可以免费取消的。',
    assistantText: '明白，订之前先看取消政策。',
  },
  {
    id: 'rule-no-weekend-work',
    role: 'rule',
    userText: '不要在周末给我发工作消息。',
    assistantText: '好，周末不打扰。',
  },
  {
    id: 'ordinary-one-off-room',
    role: 'ordinary',
    userText: '这周三晚上帮我订个会议室，就这一次。',
    assistantText: '已经订好了。',
    pair: 'rule_vs_one_off',
  },
  {
    id: 'soul-honesty',
    role: 'soul',
    userText: '我这个人最看重的就是诚实，不喜欢拐弯抹角。',
    assistantText: '我会尽量直接说。',
    pair: 'soul_vs_preference',
  },
  {
    id: 'soul-family',
    role: 'soul',
    userText: '我特别看重家人，希望周末能留给他们。',
    assistantText: '记下了，周末尽量不打扰。',
  },
  {
    id: 'soul-direct',
    role: 'soul',
    userText: '我是个直来直去的人，不喜欢试探。',
    assistantText: '明白，有话直说。',
  },
  {
    id: 'soul-old-friend',
    role: 'soul',
    userText: '我希望你跟我说话时直接一点，像老朋友一样。',
    assistantText: '好，就像老朋友那样聊。',
  },
  {
    id: 'ordinary-tea',
    role: 'ordinary',
    userText: '我喜欢喝乌龙茶。',
    assistantText: '下次给你准备乌龙茶。',
    pair: 'soul_vs_preference',
  },
  {
    id: 'commit-report',
    role: 'commitment',
    userText: '我答应你，这周五之前把星河项目的报告交给你。',
    assistantText: '我等你周五前发来。',
    pair: 'commitment_vs_intention',
  },
  {
    id: 'commit-answer',
    role: 'commitment',
    userText: '我承诺下周三之前给你答复。',
    assistantText: '好，下周三前等你的答复。',
  },
  {
    id: 'commit-payment',
    role: 'commitment',
    userText: '我保证这个月底前把尾款结清。',
    assistantText: '记下了，月底前结清。',
  },
  {
    id: 'commit-design',
    role: 'commitment',
    userText: '我答应你，下个月十号之前把设计稿发给你。',
    assistantText: '好，十号前等设计稿。',
  },
  {
    id: 'intention-kyoto',
    role: 'intention',
    userText: '下周我打算去京都看红叶。',
    assistantText: '京都的红叶应该正好。',
    pair: 'commitment_vs_intention',
  },
  {
    id: 'intention-japanese',
    role: 'intention',
    userText: '我计划下个月开始学日语。',
    assistantText: '需要的话我可以帮你排学习计划。',
  },
  {
    id: 'intention-library',
    role: 'intention',
    userText: '明天我想去图书馆查资料。',
    assistantText: '好，明天去图书馆。',
  },
  {
    id: 'intention-marathon',
    role: 'intention',
    userText: '今年我想把马拉松跑进四小时。',
    assistantText: '这个目标需要稳定的训练。',
  },
  {
    id: 'experience-migration',
    role: 'experience',
    userText: '昨天下午我们在会议室排查了数据库迁移失败的问题。',
    assistantText: '后来找到原因了吗？',
  },
  {
    id: 'experience-osaka',
    role: 'experience',
    userText: '上周我去了大阪出差，住了三天。',
    assistantText: '大阪那几天天气怎么样？',
  },
  {
    id: 'experience-users',
    role: 'experience',
    userText: '昨天我联系了三位老用户，他们反馈了三个问题。',
    assistantText: '这三个问题分别是什么？',
  },
  {
    id: 'experience-build',
    role: 'experience',
    userText: '今天上午我修好了构建脚本。',
    assistantText: '构建现在能过了吗？',
  },
  {
    id: 'ordinary-weather',
    role: 'ordinary',
    userText: '今天天气有点冷。',
    assistantText: '出门记得加件衣服。',
  },
  {
    id: 'ordinary-window',
    role: 'ordinary',
    userText: '发布窗口定在周四晚上。',
    assistantText: '好，周四晚上发布。',
    pair: 'correction_vs_new_fact',
  },
  {
    id: 'correction-window',
    role: 'correction',
    userText: '纠正一下，发布窗口不是周三，是周四晚上。',
    assistantText: '明白，改成周四晚上。',
    pair: 'correction_vs_new_fact',
  },
  {
    id: 'correction-report',
    role: 'correction',
    userText: '我说错了，报告不是周五交，是下周一交。',
    assistantText: '好，改成下周一。',
  },
];

const LONG_TAIL_FILLER = '项目背景说明：这段时间我们在整理记忆内核的账本、召回和编译流程，逐项核对事件写入、证据绑定与夜间整理的结果，记录每个环节的观察和疑问，方便后续复盘。';

function longTail(tail: string): string {
  return `${LONG_TAIL_FILLER.repeat(18)}${tail}`;
}

CLASSIFICATION_CORPUS.push(
  {
    id: 'longtail-rule-release',
    role: 'rule',
    group: 'long-tail',
    userText: longTail('以后只在周五下午做对外发布，除非有紧急安全修复；其他时间一律不发版。'),
    assistantText: '记下了，只有周五下午发版。',
  },
  {
    id: 'longtail-rule-ledger',
    role: 'rule',
    group: 'long-tail',
    userText: longTail('任何账本事件都不准在未经我确认的情况下删除，这条没有例外。'),
    assistantText: '明白，删除前一律先经过你确认。',
  },
  {
    id: 'longtail-condition-merge',
    role: 'rule',
    group: 'long-tail',
    userText: longTail('只有在三项检查全部通过之后才允许合入 main，任何一项失败就停下来等我判断。'),
    assistantText: '好，三项检查全过才合入。',
  },
  {
    id: 'longtail-negation-retry',
    role: 'rule',
    group: 'long-tail',
    userText: longTail('夜间整理失败时禁止自动重试超过两次，第三次起改为记录并等我处理。'),
    assistantText: '明白，第三次起停下来等你。',
  },
  {
    id: 'longtail-condition-credentials',
    role: 'rule',
    group: 'long-tail',
    userText: longTail('凭证只在宿主注入时使用，禁止把原文写进对话或日志。'),
    assistantText: '好，凭证原文不会出现在对话和日志里。',
  },
  {
    id: 'longtail-rule-weekend',
    role: 'rule',
    group: 'long-tail',
    userText: longTail('周末只处理线上事故，其他工作一律等到周一。'),
    assistantText: '记下了，周末只接线上事故。',
  },
);

export const COMPILE_SCENARIOS: CompileScenario[] = [
  {
    id: 'launch',
    title: '产品发布准备',
    days: [
      {
        localDate: '2026-11-10',
        turns: [
          { userText: '以后所有对外文档一律用中文写，不要再发英文版。', assistantText: '明白，之后都按中文版来。' },
          { userText: '我们的发布窗口固定在每周三晚上。', assistantText: '记下了，周三晚上发布。' },
        ],
      },
      {
        localDate: '2026-11-11',
        turns: [
          { userText: '我答应你，这周五之前把星河项目的报告交给你。', assistantText: '我等你周五前发来。' },
          { userText: '下周我打算先做用户访谈，再做原型。', assistantText: '听起来可以，先从访谈开始。' },
        ],
      },
    ],
    gold: [
      { id: 'docs-chinese', label: '对外文档一律中文', groups: [['对外文档', '对外', '文档'], ['中文']] },
      { id: 'release-wednesday', label: '发布窗口周三晚上', groups: [['发布窗口', '发布', '窗口'], ['周三', '星期三']] },
      { id: 'report-friday', label: '周五前交付星河报告', groups: [['周五', '星期五'], ['报告', '交付'], ['星河']] },
      { id: 'interviews-prototype', label: '下周先访谈再原型', groups: [['访谈', '用户访谈'], ['原型']] },
    ],
  },
  {
    id: 'incident',
    title: '事故与纠正',
    days: [
      {
        localDate: '2026-11-12',
        turns: [
          { userText: '昨天下午我们在会议室排查了数据库迁移失败的问题。', assistantText: '后来找到原因了吗？' },
          { userText: '今天上午我修好了构建脚本。', assistantText: '构建现在能过了吗？' },
        ],
      },
      {
        localDate: '2026-11-13',
        turns: [
          { userText: '纠正一下，发布窗口不是周三，是周四晚上。', assistantText: '明白，改成周四晚上。' },
          { userText: '我这个人最看重的就是诚实，不喜欢拐弯抹角。', assistantText: '我会尽量直接说。' },
        ],
      },
    ],
    gold: [
      { id: 'migration-failure', label: '数据库迁移失败被排查', groups: [['数据库', '迁移'], ['失败', '排查']] },
      { id: 'build-fixed', label: '构建脚本已修复', groups: [['构建脚本', '构建'], ['修好', '修复']] },
      { id: 'release-thursday', label: '发布窗口改为周四', groups: [['发布窗口', '发布'], ['周四', '星期四']] },
      { id: 'honesty', label: '看重诚实直率', groups: [['诚实'], ['看重', '直率', '直接']] },
    ],
  },
  {
    id: 'travel',
    title: '出行与个人偏好',
    days: [
      {
        localDate: '2026-11-14',
        turns: [
          { userText: '下个月我打算去京都看红叶。', assistantText: '京都的红叶应该正好。' },
          { userText: '我喜欢喝乌龙茶。', assistantText: '下次给你准备乌龙茶。' },
        ],
      },
      {
        localDate: '2026-11-15',
        turns: [
          { userText: '订酒店一定要选可以免费取消的。', assistantText: '明白，订之前先看取消政策。' },
          { userText: '上周我去了大阪出差，住了三天。', assistantText: '大阪那几天天气怎么样？' },
        ],
      },
    ],
    gold: [
      { id: 'kyoto', label: '下月去京都看红叶', groups: [['京都'], ['红叶', '枫叶']] },
      { id: 'oolong', label: '喜欢乌龙茶', groups: [['乌龙茶']] },
      { id: 'hotel-cancel', label: '订酒店要免费取消', groups: [['酒店'], ['免费取消', '取消']] },
      { id: 'osaka-trip', label: '大阪出差三天', groups: [['大阪'], ['出差'], ['三天', '3天']] },
    ],
  },
  {
    id: 'reschedule',
    title: '中文时间性更新',
    days: [
      {
        localDate: '2026-11-16',
        turns: [
          { userText: '评审会定在周二下午两点。', assistantText: '好，记在周二下午两点。' },
          { userText: '客户饭局定在周五晚上七点。', assistantText: '好，周五晚上七点。' },
          { userText: '发布窗口定在周四晚上八点。', assistantText: '好，周四晚上八点。' },
          { userText: '健身课定在周六上午十点。', assistantText: '好，周六上午十点。' },
        ],
      },
      {
        localDate: '2026-11-17',
        turns: [
          { userText: '评审会改到周三下午三点。', assistantText: '好，改到周三下午三点。' },
          { userText: '客户饭局改到周六中午十二点。', assistantText: '好，改到周六中午十二点。' },
          { userText: '发布窗口改到周一上午十一点。', assistantText: '好，改到周一上午十一点。' },
          { userText: '健身课改到周日早上六点半。', assistantText: '好，改到周日早上六点半。' },
        ],
      },
    ],
    gold: [
      { id: 'review-moved', label: '评审会改到周三三点', groups: [['评审会'], ['周三', '三点']] },
      { id: 'dinner-moved', label: '客户饭局改到周六十二点', groups: [['客户饭局', '饭局'], ['周六', '十二点']] },
      { id: 'release-moved', label: '发布窗口改到周一十一点', groups: [['发布窗口', '发布'], ['周一', '十一点']] },
      { id: 'gym-moved', label: '健身课改到周日六点半', groups: [['健身课', '健身'], ['周日', '六点半']] },
    ],
    temporalUpdates: [
      { id: 'review-time', query: '评审会定在什么时候？', oldValue: '两点', newValue: '三点' },
      { id: 'dinner-time', query: '客户饭局定在什么时候？', oldValue: '七点', newValue: '十二点' },
      { id: 'release-time', query: '发布窗口定在什么时候？', oldValue: '八点', newValue: '十一点' },
      { id: 'gym-time', query: '健身课定在什么时候？', oldValue: '十点', newValue: '六点半' },
    ],
  },
];

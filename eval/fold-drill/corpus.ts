/**
 * The #254 B4 fold/drill corpus.
 *
 * 24 tasks, six per detail type. Each task plants one target detail early and
 * two same-type distractors later; the question at the end names the target.
 * Three runs use the same tasks: the full transcript, the transcript with the
 * three detail turns folded into digest stubs, and the folded transcript with
 * the target expanded when the question hits its stub entity terms.
 *
 * Stubs use the kernel's `SessionDigest` shape: entryId (the key), an exact
 * prefix quote of the ledger turn, and sourceRefs. The value itself lives only
 * in the omitted suffix.
 */
import { createHash } from 'node:crypto';

import type { FoldTask, RawTask, Turn } from './types.ts';

export const FOLD_TASKS: RawTask[] = [
  {
    id: 'f01',
    type: 'number',
    setting: '今天把上传链路的失败处理过一遍，只讨论这一个服务。',
    target: {
      text: '关于上传失败的处理，团队最终定下的重试上限是最多重试 7 次，超过就进死信队列。',
      stub: '关于上传失败的处理，团队最终定下的重试上限是',
      entity: ['上传失败', '重试上限'],
    },
    distractors: [
      {
        text: '另一个旧版网关把重试上限设成 12 次，已经不再使用。',
        stub: '另一个旧版网关把重试上限设成',
        entity: ['旧版网关'],
      },
      {
        text: '监控组的结论是 3 次重试就够，但那是另一套告警链路。',
        stub: '监控组的结论是',
        entity: ['监控组'],
      },
    ],
    question: '上传失败后的重试上限是多少次？',
    expected: '7',
    checks: [['7']],
    number: 7,
  },
  {
    id: 'f02',
    type: 'number',
    setting: '今天只讨论离线批处理的吞吐配置。',
    target: {
      text: '批处理任务每批最多处理 480 条记录，超过就拆成下一批。',
      stub: '批处理任务每批最多处理',
      entity: ['批处理', '每批'],
    },
    distractors: [
      {
        text: '实时通道的批量大小是 200 条，和离线批处理分开配置。',
        stub: '实时通道的批量大小是',
        entity: ['实时通道'],
      },
      {
        text: '压测时把批量调到 1000 条，只在那次演练里生效。',
        stub: '压测时把批量调到',
        entity: ['压测'],
      },
    ],
    question: '批处理每批最多多少条？',
    expected: '480',
    checks: [['480']],
    number: 480,
  },
  {
    id: 'f03',
    type: 'number',
    setting: '今天只讨论商品详情页的缓存策略。',
    target: {
      text: '商品详情缓存的有效期是 45 分钟，过期后回源重建。',
      stub: '商品详情缓存的有效期是',
      entity: ['商品详情', '缓存'],
    },
    distractors: [
      {
        text: '会话缓存只放 15 分钟，避免权限变更后继续命中旧数据。',
        stub: '会话缓存只放',
        entity: ['会话缓存'],
      },
      {
        text: '静态资源缓存可以放 90 分钟，走的是另一套 CDN 规则。',
        stub: '静态资源缓存可以放',
        entity: ['静态资源'],
      },
    ],
    question: '商品详情缓存的有效期是多少分钟？',
    expected: '45',
    checks: [['45']],
    number: 45,
  },
  {
    id: 'f04',
    type: 'number',
    setting: '今天只讨论连接池扩容这一件事，别的配置先不碰。',
    target: {
      text: '连接池的上限最终定为 64，超过就排队等待。',
      stub: '连接池的上限最终定为',
      entity: ['连接池', '连接数'],
    },
    distractors: [
      {
        text: '只读副本的连接上限是 16，和主库分开算。',
        stub: '只读副本的连接上限是',
        entity: ['只读副本'],
      },
      {
        text: '压测环境把连接上限开到 128，生产不会照抄。',
        stub: '压测环境把连接上限开到',
        entity: ['压测环境'],
      },
    ],
    question: '刚才那个上限最后定成了多少？',
    expected: '64',
    checks: [['64']],
    number: 64,
  },
  {
    id: 'f05',
    type: 'number',
    setting: '今天只讨论网关的超时配置。',
    target: {
      text: '网关的读超时设为 2500 毫秒，超过就快速失败。',
      stub: '网关的读超时设为',
      entity: ['读超时', '网关'],
    },
    distractors: [
      {
        text: '写超时是 800 毫秒，比读超时短很多。',
        stub: '写超时是',
        entity: ['写超时'],
      },
      {
        text: '批量导出任务用 5000 毫秒，避免大文件被截断。',
        stub: '批量导出任务用',
        entity: ['批量导出'],
      },
    ],
    question: '网关的读超时是多少毫秒？',
    expected: '2500',
    checks: [['2500']],
    number: 2500,
  },
  {
    id: 'f06',
    type: 'number',
    setting: '今天只讨论容量告警的阈值。',
    target: {
      text: '容量告警阈值定在 85%，达到后先通知值班，不自动扩容。',
      stub: '容量告警阈值定在',
      entity: ['告警阈值', '容量'],
    },
    distractors: [
      {
        text: '错误率告警阈值是 60%，和容量告警不是一条线。',
        stub: '错误率告警阈值是',
        entity: ['错误率'],
      },
      {
        text: '延迟告警阈值放到 95%，只用于夜间。',
        stub: '延迟告警阈值放到',
        entity: ['延迟告警'],
      },
    ],
    question: '容量告警阈值是多少？',
    expected: '85',
    checks: [['85']],
    number: 85,
  },
  {
    id: 'f07',
    type: 'name',
    setting: '今天只讨论计费迁移的交接安排。',
    target: {
      text: '计费迁移的负责人已经定了，是林雯，她下周一开始接手。',
      stub: '计费迁移的负责人已经定了，是',
      entity: ['计费迁移', '负责人'],
    },
    distractors: [
      {
        text: '搜索服务那边由赵敏临时看着，等招聘到位再交接。',
        stub: '搜索服务那边由',
        entity: ['搜索服务'],
      },
      {
        text: '数据校验那边由陈默协助，不占用迁移负责人。',
        stub: '数据校验那边由',
        entity: ['数据校验'],
      },
    ],
    question: '计费迁移的负责人是谁？',
    expected: '林雯',
    checks: [['林雯']],
  },
  {
    id: 'f08',
    type: 'name',
    setting: '今晚只讨论搜索服务的值班安排。',
    target: {
      text: '搜索服务的夜间 on-call 这周排的是周启，交接时间是晚上八点。',
      stub: '搜索服务的夜间 on-call 这周排的是',
      entity: ['搜索服务', 'on-call'],
    },
    distractors: [
      {
        text: '上周值班的人选已经确认，是苏禾，这周不排了。',
        stub: '上周值班的人选已经确认，是',
        entity: ['上周值班'],
      },
      {
        text: '周末白班另有人负责，是韩川，和工作日的 on-call 分开。',
        stub: '周末白班另有人负责，是',
        entity: ['周末白班'],
      },
    ],
    question: '今晚值班的是谁？',
    expected: '周启',
    checks: [['周启']],
  },
  {
    id: 'f09',
    type: 'name',
    setting: '今天只讨论鉴权模块的代码评审安排。',
    target: {
      text: '鉴权模块的评审人定下来了，是顾言，下周一开始看代码。',
      stub: '鉴权模块的评审人定下来了，是',
      entity: ['鉴权模块', '评审人'],
    },
    distractors: [
      {
        text: '网关模块的评审人另有人选，是沈青。',
        stub: '网关模块的评审人另有人选，是',
        entity: ['网关模块'],
      },
      {
        text: '文档评审不占用代码评审名额，由罗一顺带看。',
        stub: '文档评审不占用代码评审名额，由',
        entity: ['文档评审'],
      },
    ],
    question: '鉴权模块的评审人是谁？',
    expected: '顾言',
    checks: [['顾言']],
  },
  {
    id: 'f10',
    type: 'name',
    setting: '今天只讨论客户侧的对接口。',
    target: {
      text: '客户侧的对接口已经确认，是唐宁，所有变更先和她同步。',
      stub: '客户侧的对接口已经确认，是',
      entity: ['客户侧', '对接口'],
    },
    distractors: [
      {
        text: '内部法务接口是许安，只处理合同问题。',
        stub: '内部法务接口是',
        entity: ['内部法务'],
      },
      {
        text: '运维窗口的协调人由白露负责，不参与需求讨论。',
        stub: '运维窗口的协调人由',
        entity: ['运维窗口'],
      },
    ],
    question: '客户侧的对接口是谁？',
    expected: '唐宁',
    checks: [['唐宁']],
  },
  {
    id: 'f11',
    type: 'name',
    setting: '今天只讨论这次发布的 release manager。',
    target: {
      text: '这次发布的 release manager 定了，是郑昊，周二开始接管。',
      stub: '这次发布的 release manager 定了，是',
      entity: ['release manager', '发布'],
    },
    distractors: [
      {
        text: '回滚演练的负责人是方雨，和发布不是同一个人。',
        stub: '回滚演练的负责人是',
        entity: ['回滚演练'],
      },
      {
        text: '变更评审的主持人由蒋舟担任，只管会议。',
        stub: '变更评审的主持人由',
        entity: ['变更评审'],
      },
    ],
    question: '这次发布的 release manager 是谁？',
    expected: '郑昊',
    checks: [['郑昊']],
  },
  {
    id: 'f12',
    type: 'name',
    setting: '今天只处理数据修复脚本的交接，其他脚本不改。',
    target: {
      text: '数据修复脚本最后交给孟遥维护，其他人不再改动。',
      stub: '数据修复脚本最后交给',
      entity: ['数据修复'],
    },
    distractors: [
      {
        text: '校验脚本的维护人是何夕，和修复脚本分开。',
        stub: '校验脚本的维护人是',
        entity: ['校验脚本'],
      },
      {
        text: '临时补丁由陆离保管，月底统一清理。',
        stub: '临时补丁由',
        entity: ['临时补丁'],
      },
    ],
    question: '那个脚本最后交给谁了？',
    expected: '孟遥',
    checks: [['孟遥']],
  },
  {
    id: 'f13',
    type: 'constraint',
    setting: '今天只讨论生产库的迁移窗口。',
    target: {
      text: '数据库迁移窗口定在周日 02:00 到 04:00，其他时间不允许动生产库。',
      stub: '数据库迁移窗口定在',
      entity: ['迁移窗口', '数据库'],
    },
    distractors: [
      {
        text: '回滚演练安排在周六 23:00 到 01:00，时长两小时。',
        stub: '回滚演练安排在',
        entity: ['回滚演练'],
      },
      {
        text: '发布窗口是周一 04:00 到 06:00，和迁移不是一回事。',
        stub: '发布窗口是',
        entity: ['发布窗口'],
      },
    ],
    question: '数据库迁移窗口是什么时间？',
    expected: '周日 02:00 到 04:00',
    checks: [['周日'], ['02:00', '2:00', '2点'], ['04:00', '4:00', '4点']],
  },
  {
    id: 'f14',
    type: 'constraint',
    setting: '今天只讨论对外接口的限流。',
    target: {
      text: '接口限流按每分钟 120 次设计，超过就排队，不直接报错。',
      stub: '接口限流按',
      entity: ['接口限流', '限流'],
    },
    distractors: [
      {
        text: '另一个内部服务限制在每分钟 60 次，不对外。',
        stub: '另一个内部服务限制在',
        entity: ['内部服务'],
      },
      {
        text: '压测环境放宽到每分钟 300 次，只用于测试。',
        stub: '压测环境放宽到',
        entity: ['压测环境'],
      },
    ],
    question: '接口限流是多少？',
    expected: '120',
    checks: [['120']],
    number: 120,
  },
  {
    id: 'f15',
    type: 'constraint',
    setting: '今天只讨论审计日志的保留策略。',
    target: {
      text: '审计日志只保留 30 天，过期后由清理任务统一删除。',
      stub: '审计日志只保留',
      entity: ['审计日志', '保留'],
    },
    distractors: [
      {
        text: '调试日志保留 7 天，方便排查最近的问题。',
        stub: '调试日志保留',
        entity: ['调试日志'],
      },
      {
        text: '备份归档保留 90 天，和审计日志不是同一套策略。',
        stub: '备份归档保留',
        entity: ['备份归档'],
      },
    ],
    question: '审计日志保留多少天？',
    expected: '30',
    checks: [['30']],
    number: 30,
  },
  {
    id: 'f16',
    type: 'constraint',
    setting: '今天只讨论发布封禁的时间，其他变更先不排。',
    target: {
      text: '发布封禁从周五 18:00 开始，周末不允许上线，周一早上恢复。',
      stub: '发布封禁从',
      entity: ['发布封禁', '封禁'],
    },
    distractors: [
      {
        text: '灰度例外已经批了，只限周四 20:00 之后，仅此一次。',
        stub: '灰度例外已经批了，只限',
        entity: ['灰度例外'],
      },
      {
        text: '只读巡检安排在周六 12:00，不属于发布。',
        stub: '只读巡检安排在',
        entity: ['只读巡检'],
      },
    ],
    question: '什么时候不能上线？',
    expected: '周五 18:00',
    checks: [['周五'], ['18:00', '18点']],
  },
  {
    id: 'f17',
    type: 'constraint',
    setting: '今天只讨论管理员密码的轮换周期。',
    target: {
      text: '管理员密码每 90 天必须更换一次，不能重复使用最近五次。',
      stub: '管理员密码每',
      entity: ['管理员密码', '密码'],
    },
    distractors: [
      {
        text: '普通用户密码每 180 天更换一次，规则更松。',
        stub: '普通用户密码每',
        entity: ['普通用户密码'],
      },
      {
        text: '服务账号密码每 30 天轮换，由密钥系统自动完成。',
        stub: '服务账号密码每',
        entity: ['服务账号密码'],
      },
    ],
    question: '管理员密码多久必须更换？',
    expected: '90',
    checks: [['90']],
    number: 90,
  },
  {
    id: 'f18',
    type: 'constraint',
    setting: '今天只讨论磁盘告警和扩容。',
    target: {
      text: '磁盘使用率超过 80% 就必须扩容，告警只是提醒，不能代替扩容。',
      stub: '磁盘使用率超过',
      entity: ['磁盘使用率', '扩容'],
    },
    distractors: [
      {
        text: '内存使用率超过 90% 才会触发第二级告警。',
        stub: '内存使用率超过',
        entity: ['内存使用率'],
      },
      {
        text: '归档盘使用率到 70% 时先清理冷数据，不急着扩容。',
        stub: '归档盘使用率到',
        entity: ['归档盘'],
      },
    ],
    question: '磁盘使用率超过多少必须扩容？',
    expected: '80',
    checks: [['80']],
    number: 80,
  },
  {
    id: 'f19',
    type: 'step',
    setting: '今天只讨论回滚流程的步骤。',
    target: {
      text: '回滚流程的第三步是先关闭 feature flag，再重启 worker，确认没有新请求后继续。',
      stub: '回滚流程的第三步是',
      entity: ['回滚流程', '第三步'],
    },
    distractors: [
      {
        text: '发布流程的第三步是跑冒烟测试，再切换流量。',
        stub: '发布流程的第三步是',
        entity: ['发布流程'],
      },
      {
        text: '数据清理流程的第三步是导出快照，再删除过期分区。',
        stub: '数据清理流程的第三步是',
        entity: ['数据清理流程'],
      },
    ],
    question: '回滚流程的第三步是什么？',
    expected: '先关闭 feature flag，再重启 worker',
    checks: [['关闭', '关掉'], ['featureflag', '特性开关'], ['重启', 'restart'], ['worker']],
  },
  {
    id: 'f20',
    type: 'step',
    setting: '今天只讨论恢复流程的演练步骤。',
    target: {
      text: '恢复流程的第二步是先校验备份校验和，再解压到临时目录。',
      stub: '恢复流程的第二步是',
      entity: ['恢复流程', '备份'],
    },
    distractors: [
      {
        text: '发布流程的第二步是冻结变更，再通知相关同学。',
        stub: '发布流程的第二步是',
        entity: ['发布流程'],
      },
      {
        text: '数据迁移流程的第二步是停写旧库，再建立增量通道。',
        stub: '数据迁移流程的第二步是',
        entity: ['数据迁移流程'],
      },
    ],
    question: '第二步具体做什么？',
    expected: '先校验备份校验和，再解压到临时目录',
    checks: [['校验', '检查'], ['校验和', 'checksum'], ['解压'], ['临时目录', '临时']],
  },
  {
    id: 'f21',
    type: 'step',
    setting: '今天只讨论事故止血流程的第一步。',
    target: {
      text: '事故止血流程的第一步是先冻结发布，再拉齐值班人。',
      stub: '事故止血流程的第一步是',
      entity: ['事故止血', '止血流程'],
    },
    distractors: [
      {
        text: '故障通报流程的第一步是先建群，再同步影响面。',
        stub: '故障通报流程的第一步是',
        entity: ['故障通报'],
      },
      {
        text: '复盘流程的第一步是先收集时间线，再约会议。',
        stub: '复盘流程的第一步是',
        entity: ['复盘流程'],
      },
    ],
    question: '事故止血的第一步做什么？',
    expected: '先冻结发布，再拉齐值班人',
    checks: [['冻结', '停止', '暂停'], ['发布'], ['拉齐', '召集', '通知'], ['值班']],
  },
  {
    id: 'f22',
    type: 'step',
    setting: '今天只讨论发布流程的第四步。',
    target: {
      text: '发布流程的第四步是先跑冒烟测试，再切换流量。',
      stub: '发布流程的第四步是',
      entity: ['发布流程', '第四步'],
    },
    distractors: [
      {
        text: '回滚流程的第四步是恢复旧镜像，再验证健康检查。',
        stub: '回滚流程的第四步是',
        entity: ['回滚流程'],
      },
      {
        text: '数据迁移流程的第四步是校验行数，再切换读流量。',
        stub: '数据迁移流程的第四步是',
        entity: ['数据迁移流程'],
      },
    ],
    question: '发布流程的第四步是什么？',
    expected: '先跑冒烟测试，再切换流量',
    checks: [['冒烟测试', '冒烟'], ['切换流量', '切流', '切流量']],
  },
  {
    id: 'f23',
    type: 'step',
    setting: '今天只讨论数据清理流程的第一步。',
    target: {
      text: '数据清理流程的第一步是先导出快照，再删除过期分区。',
      stub: '数据清理流程的第一步是',
      entity: ['数据清理', '清理流程'],
    },
    distractors: [
      {
        text: '归档流程的第一步是先打标签，再移动到冷存储。',
        stub: '归档流程的第一步是',
        entity: ['归档流程'],
      },
      {
        text: '删除审批流程的第一步是先登记影响范围，再找负责人签字。',
        stub: '删除审批流程的第一步是',
        entity: ['删除审批'],
      },
    ],
    question: '数据清理的第一步是什么？',
    expected: '先导出快照，再删除过期分区',
    checks: [['导出', 'dump'], ['快照'], ['删除', '清理'], ['过期分区', '分区']],
  },
  {
    id: 'f24',
    type: 'step',
    setting: '今天只讨论迁移流程的第五步。',
    target: {
      text: '迁移流程的第五步是先停写，再切换读流量。',
      stub: '迁移流程的第五步是',
      entity: ['迁移流程', '第五步'],
    },
    distractors: [
      {
        text: '回滚流程的第五步是恢复旧库连接，再重放增量。',
        stub: '回滚流程的第五步是',
        entity: ['回滚流程'],
      },
      {
        text: '验收流程的第五步是对比抽样结果，再签字。',
        stub: '验收流程的第五步是',
        entity: ['验收流程'],
      },
    ],
    question: '迁移流程的第五步是什么？',
    expected: '先停写，再切换读流量',
    checks: [['停写', '停止写入'], ['切换读流量', '切读', '切读流量', '切换读']],
  },
];

/** The person names planted anywhere in the corpus; used by the hallucination check. */
export const NAME_POOL = [
  '林雯',
  '赵敏',
  '陈默',
  '周启',
  '苏禾',
  '韩川',
  '顾言',
  '沈青',
  '罗一',
  '唐宁',
  '许安',
  '白露',
  '郑昊',
  '方雨',
  '蒋舟',
  '孟遥',
  '何夕',
  '陆离',
];

/** Action families for the step hallucination check. */
export const ACTION_FAMILIES = [
  ['关闭', '关掉', '禁用'],
  ['重启', 'restart'],
  ['回滚', 'rollback'],
  ['停写', '停止写入', '停写旧库'],
  ['切流', '切换流量', '切流量'],
  ['切读', '切换读流量', '切读流量', '切换读'],
  ['导出', 'dump'],
  ['删除', '清理'],
  ['解压'],
  ['校验', '检查'],
  ['冻结', '停止', '暂停'],
  ['拉齐', '召集', '通知'],
  ['发布', '上线'],
  ['扩容'],
  ['限流'],
  ['降级'],
  ['恢复'],
  ['签字'],
];

const FILLER = [
  '我们先把接口文档过了一遍，确认字段命名和错误码的描述没有歧义。',
  '讨论里有人提到监控面板的告警噪音偏大，决定下次例会单独排期处理。',
  '产品侧补充了几个边界场景，要求实现时把失败路径也写进测试计划。',
  '值班同事同步了上一轮线上问题的复盘结论，暂无新的阻塞项。',
  '文档组把术语表更新了一版，主要统一了状态机和重试相关的叫法。',
  '我们约定后续变更都走同一个评审模板，避免口头结论散落在聊天里。',
  '有人问起演练的安排，结论是先按现有节奏推进，细节之后再定。',
  '测试环境最近不太稳定，大家同意先把失败用例归档，不阻塞本次讨论。',
  '对接方发来了新的字段说明，和现有约定基本一致，只有措辞上的调整。',
  '会议最后确认了行动项的分工方式，由各模块负责人自行跟进。',
  '接口联调的时间还没定，先把依赖方需要的清单整理出来。',
  '有同事提醒副本不要只看文件大小，还要比对内容摘要。',
  '这次讨论没有改动节奏，只是把观察项补进了值班手册。',
  '最后大家一起确认了记录方式，后续结论统一写进同一份纪要。',
  '有人提议把错误码按域拆开，讨论后决定先保持现状，等调用方稳定再说。',
  '我们把最近几次故障的时间线又对了一遍，确认没有遗漏的依赖项。',
  '值班手册里补了一条沟通约定：先同步影响面，再给处理时间点。',
  '评审时有人担心新旧逻辑并存太久，结论是先加开关，按周观察。',
  '接口变更的通知已经发出去，接下来等依赖方确认排期。',
  '测试同学建议把回归用例按模块分组，方便失败时快速定位。',
  '讨论中提到文档和实现有出入，决定以代码为准并补一轮说明。',
  '发布清单又核对了一遍，确认没有漏掉配置项和交接材料。',
  '有人问是否需要额外的压测，结论是等容量数据出来再判断。',
  '这次会议没有新增决策，只把待办分给了各模块的负责人。',
];

function fillerFor(id: string, count: number): string[] {
  const digest = createHash('sha256').update(id).digest();
  const start = digest.readUInt32BE(0) % FILLER.length;
  return Array.from({ length: count }, (_, index) => FILLER[(start + index * 5) % FILLER.length]!);
}

function buildTask(raw: RawTask): FoldTask {
  const filler = fillerFor(raw.id, 20);
  const turn = (n: number, speaker: Turn['speaker'], text: string): Turn => ({
    id: `${raw.id}-t${String(n).padStart(2, '0')}`,
    speaker,
    text,
  });
  const turns: Turn[] = [
    turn(1, 'owner', raw.setting),
    turn(2, 'owner', raw.target.text),
    turn(3, 'assistant', filler[0]!),
    turn(4, 'assistant', filler[1]!),
    turn(5, 'assistant', filler[2]!),
    turn(6, 'assistant', filler[3]!),
    turn(7, 'assistant', filler[4]!),
    turn(8, 'assistant', filler[5]!),
    turn(9, 'assistant', filler[6]!),
    turn(10, 'assistant', filler[7]!),
    turn(11, 'owner', raw.distractors[0].text),
    turn(12, 'assistant', filler[8]!),
    turn(13, 'assistant', filler[9]!),
    turn(14, 'assistant', filler[10]!),
    turn(15, 'assistant', filler[11]!),
    turn(16, 'assistant', filler[12]!),
    turn(17, 'assistant', filler[13]!),
    turn(18, 'assistant', filler[14]!),
    turn(19, 'assistant', filler[15]!),
    turn(20, 'owner', raw.distractors[1].text),
    turn(21, 'assistant', filler[16]!),
    turn(22, 'assistant', filler[17]!),
    turn(23, 'assistant', filler[18]!),
    turn(24, 'assistant', filler[19]!),
  ];
  const detail = (n: number, value: RawTask['target']): FoldTask['details'][number] => ({
    key: `digest:${raw.id}-t${String(n).padStart(2, '0')}`,
    turnId: `${raw.id}-t${String(n).padStart(2, '0')}`,
    stubQuote: value.stub,
    entityTerms: value.entity,
  });
  return {
    id: raw.id,
    type: raw.type,
    turns,
    details: [detail(2, raw.target), detail(11, raw.distractors[0]), detail(20, raw.distractors[1])],
    targetKey: `digest:${raw.id}-t02`,
    question: raw.question,
    expected: raw.expected,
    checks: raw.checks,
    ...(raw.number === undefined ? {} : { number: raw.number }),
  };
}

export const TASKS: FoldTask[] = FOLD_TASKS.map(buildTask);

export function turnText(task: FoldTask, turnId: string): string {
  const found = task.turns.find((turn) => turn.id === turnId);
  if (!found) throw new Error(`missing turn ${turnId} in ${task.id}`);
  return found.text;
}

/** Normalization shared with the checker: full-width to half-width, lower-case, no spaces. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/gu, '');
}

/** The stub matches when the question names its key or one of its entity terms. */
export function autoExpandMatches(task: FoldTask, detailKey: string, question: string): boolean {
  const detail = task.details.find((entry) => entry.key === detailKey);
  if (!detail) return false;
  const haystack = normalize(question);
  return [detail.key, ...detail.entityTerms].some((term) => haystack.includes(normalize(term)));
}

/**
 * #294 — the fold experiment at the scale the ticket names: one tool output of thousands of
 * provider tokens and sessions of hundreds of turns. The original #254 corpus averaged 24 turns
 * and 665 characters, so it could show "the key works" but not a capacity decision.
 *
 * The shape is the same as `corpus.ts` (one target detail, two same-type distractors, three arms,
 * the same checker), so the runner and the grader are shared. What changes is that every folded
 * detail is a whole tool result of ~9k characters and the transcript around it is 240 turns.
 *
 * `SWEEP_TASKS` holds one target at growing block counts. Running it gives the point where a
 * folded transcript plus one drill stops costing more than the full transcript.
 */
import { createHash } from 'node:crypto';

import type { DetailType, FoldTask, Turn } from './types.ts';

interface DetailSpec {
  service: string;
  key: string;
  value: string;
}

export interface RealSpec {
  id: string;
  type: DetailType;
  setting: string;
  question: string;
  expected: string;
  checks: string[][];
  number?: number;
  target: DetailSpec;
  distractors: [DetailSpec, DetailSpec];
  extras: DetailSpec[];
}

const CONVERSATION = [
  '今天先把发布前的检查清单过一遍，重点看回滚路径。',
  '刚收到的告警是测试环境触发的，确认过不影响线上。',
  '我把上周的复盘结论整理成三条，稍后同步到文档里。',
  '这个接口的延迟比上周高了十几毫秒，还在阈值内。',
  '明天上午的同步会我可能晚到，材料已经发出来了。',
  '运维说磁盘还有余量，归档可以下周再清。',
  '变更单我重新核对过，编号和审批人是对的。',
  '这一版文案改了三处，都是措辞问题。',
  '监控面板新加了延迟分位，先观察几天。',
  '这周的值班表排好了，周五演练由我盯着。',
  '昨天那个偶发失败没有复现，先挂到观察列表。',
  '文档里回滚步骤的描述有点旧，回头统一改。',
  '压测结果比上次好一点，瓶颈还是连接池。',
  '会议纪要整理成三条待办，稍后发给大家。',
  '新同学问的配置项在启动参数里，不在配置文件里。',
  '这次发布窗口避开月底结算，风险小一些。',
  '我把日志采样率临时调到一成，先压一压存储。',
  '灰度比例今天不再往上加，等明天观察结果。',
  '告警规则加了一条静默，只对测试环境生效。',
  '这批任务跑完大概要四十分钟，先让它跑着。',
];

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

/** One tool result: a config dump of ~9k characters with the detail line near its middle. */
function blockText(detail: DetailSpec, seed: number, index: number): string {
  const lines = [
    `[tool result] ${detail.service} 配置快照 第${index + 1}份 采集于 03:12`,
    '-'.repeat(64),
  ];
  for (let field = 0; field < 460; field += 1) {
    const hash = createHash('sha256').update(`${detail.service}:${seed}:${field}`).digest();
    const value = hash.readUInt32BE(0) % 100_000;
    const note = field % 11 === 0 ? '  # 节点已退役，仅供核对' : '';
    lines.push(`field_${String(field).padStart(3, '0')} = ${value}${note}`);
  }
  lines.splice(232, 0, `${detail.key} = ${detail.value}`);
  return lines.join('\n');
}

const REAL_SPECS: RealSpec[] = [
  {
    id: 'r01',
    type: 'number',
    setting: '今天把网关的重试配置按服务过一遍，一个一个来。',
    question: 'svc-alpha 的 max_retries 是多少？',
    expected: '720',
    checks: [['720']],
    number: 720,
    target: { service: 'svc-alpha', key: 'max_retries', value: '720' },
    distractors: [
      { service: 'svc-alpha-2', key: 'max_retries', value: '480' },
      { service: 'svc-alpha-old', key: 'max_retries', value: '120' },
    ],
    extras: [
      { service: 'svc-beta', key: 'max_retries', value: '90' },
      { service: 'svc-gamma', key: 'max_retries', value: '240' },
      { service: 'svc-delta', key: 'max_retries', value: '600' },
    ],
  },
  {
    id: 'r02',
    type: 'number',
    setting: '离线批处理的批次大小要对一遍，别和实时通道混了。',
    question: 'batch-worker 的 batch_size 是多少？',
    expected: '3600',
    checks: [['3600']],
    number: 3600,
    target: { service: 'batch-worker', key: 'batch_size', value: '3600' },
    distractors: [
      { service: 'batch-worker-2', key: 'batch_size', value: '1800' },
      { service: 'batch-worker-legacy', key: 'batch_size', value: '600' },
    ],
    extras: [
      { service: 'stream-worker', key: 'batch_size', value: '120' },
      { service: 'batch-indexer', key: 'batch_size', value: '900' },
      { service: 'batch-archiver', key: 'batch_size', value: '2400' },
    ],
  },
  {
    id: 'c01',
    type: 'constraint',
    setting: '这次只讨论超时约束，其他项不动。',
    question: 'edge-proxy 的 timeout_ms 是多少？',
    expected: '4500',
    checks: [['4500']],
    number: 4500,
    target: { service: 'edge-proxy', key: 'timeout_ms', value: '4500' },
    distractors: [
      { service: 'edge-proxy-2', key: 'timeout_ms', value: '1500' },
      { service: 'edge-proxy-old', key: 'timeout_ms', value: '750' },
    ],
    extras: [
      { service: 'inner-proxy', key: 'timeout_ms', value: '3000' },
      { service: 'edge-cache', key: 'timeout_ms', value: '900' },
      { service: 'edge-auth', key: 'timeout_ms', value: '2200' },
    ],
  },
  {
    id: 'c02',
    type: 'constraint',
    setting: '连接池的上限这次要定死，不要再按环境分开。',
    question: 'db-pool 的 max_connections 是多少？',
    expected: '880',
    checks: [['880']],
    number: 880,
    target: { service: 'db-pool', key: 'max_connections', value: '880' },
    distractors: [
      { service: 'db-pool-2', key: 'max_connections', value: '440' },
      { service: 'db-pool-readonly', key: 'max_connections', value: '110' },
    ],
    extras: [
      { service: 'db-report', key: 'max_connections', value: '60' },
      { service: 'db-migrate', key: 'max_connections', value: '20' },
      { service: 'db-archive', key: 'max_connections', value: '30' },
    ],
  },
  {
    id: 'n01',
    type: 'name',
    setting: '值班负责人这块今天只确认一个服务。',
    question: 'svc-alpha 的 owner 是谁？',
    expected: '长庚',
    checks: [['长庚']],
    target: { service: 'svc-alpha', key: 'owner', value: '长庚' },
    distractors: [
      { service: 'svc-alpha-2', key: 'owner', value: '白露' },
      { service: 'svc-alpha-old', key: 'owner', value: '沈青' },
    ],
    extras: [
      { service: 'svc-beta', key: 'owner', value: '林雯' },
      { service: 'svc-gamma', key: 'owner', value: '唐宁' },
      { service: 'svc-delta', key: 'owner', value: '郑昊' },
    ],
  },
  {
    id: 'n02',
    type: 'name',
    setting: '发布审批人这次按服务记清楚。',
    question: 'release-bot 的 owner 是谁？',
    expected: '苏禾',
    checks: [['苏禾']],
    target: { service: 'release-bot', key: 'owner', value: '苏禾' },
    distractors: [
      { service: 'release-bot-2', key: 'owner', value: '周启' },
      { service: 'release-bot-old', key: 'owner', value: '韩川' },
    ],
    extras: [
      { service: 'release-gate', key: 'owner', value: '顾言' },
      { service: 'release-audit', key: 'owner', value: '方雨' },
      { service: 'release-cdn', key: 'owner', value: '蒋舟' },
    ],
  },
  {
    id: 's01',
    type: 'step',
    setting: '回滚流程这次定下来，按顺序执行。',
    question: 'svc-alpha 的 rollback_plan 是什么？',
    expected: '先回滚再校验最后切流',
    checks: [['回滚'], ['校验'], ['切流']],
    target: { service: 'svc-alpha', key: 'rollback_plan', value: '先回滚再校验最后切流' },
    distractors: [
      { service: 'svc-alpha-2', key: 'rollback_plan', value: '先切流再校验最后重启' },
      { service: 'svc-alpha-old', key: 'rollback_plan', value: '先停写再导出最后删除' },
    ],
    extras: [
      { service: 'svc-beta', key: 'rollback_plan', value: '先校验再回滚最后切流' },
      { service: 'svc-gamma', key: 'rollback_plan', value: '先导出再停写最后解压' },
      { service: 'svc-delta', key: 'rollback_plan', value: '先冻结再切读最后校验' },
    ],
  },
  {
    id: 's02',
    type: 'step',
    setting: '故障恢复步骤按服务各自记，不要互相套用。',
    question: 'db-pool 的 recovery_steps 是什么？',
    expected: '先停写再导出然后重启',
    checks: [['停写'], ['导出'], ['重启']],
    target: { service: 'db-pool', key: 'recovery_steps', value: '先停写再导出然后重启' },
    distractors: [
      { service: 'db-pool-2', key: 'recovery_steps', value: '先回滚再校验最后切流' },
      { service: 'db-pool-old', key: 'recovery_steps', value: '先冻结再删除最后解压' },
    ],
    extras: [
      { service: 'db-report', key: 'recovery_steps', value: '先导出再校验最后恢复' },
      { service: 'db-migrate', key: 'recovery_steps', value: '先停写再回滚最后重启' },
      { service: 'db-archive', key: 'recovery_steps', value: '先冻结再导出最后删除' },
    ],
  },
];

/** One realistic task: `blocks` giant tool results among `turns` conversation turns. */
function buildRealTask(spec: RealSpec, blocks: number, turns: number, scale: string): FoldTask {
  const base = [spec.target, ...spec.distractors, ...spec.extras];
  for (let index = base.length; index < blocks; index += 1) {
    const value = spec.number !== undefined ? String(spec.number + 10_000 * index) : `${spec.target.value}${index + 1}`;
    base.push({ service: `svc-extra-${index + 1}`, key: spec.target.key, value });
  }
  const details = base.slice(0, Math.max(1, blocks));
  const blockTurns: Array<{ at: number; turn: Turn }> = details.map((detail, index) => {
    const turnId = `${spec.id}-b${pad(index + 1, 2)}`;
    return {
      at: turns === 0 ? 0 : Math.floor(turns * (0.1 + 0.5 * index / Math.max(1, details.length - 1))),
      turn: {
        id: turnId,
        speaker: 'assistant',
        text: blockText(detail, spec.id.length + 294, index),
      },
    };
  });
  const turnsList: Turn[] = [];
  let blockIndex = 0;
  for (let index = 0; index < turns; index += 1) {
    while (blockIndex < blockTurns.length && blockTurns[blockIndex]!.at === index) {
      turnsList.push(blockTurns[blockIndex]!.turn);
      blockIndex += 1;
    }
    turnsList.push({
      id: `${spec.id}-c${pad(index)}`,
      speaker: index % 2 === 0 ? 'owner' : 'assistant',
      text: CONVERSATION[index % CONVERSATION.length]!,
    });
  }
  for (; blockIndex < blockTurns.length; blockIndex += 1) turnsList.push(blockTurns[blockIndex]!.turn);

  const foldedDetails = details.map((detail, index) => {
    const turn = blockTurns[index]!.turn;
    return {
      key: `digest:${turn.id}`,
      turnId: turn.id,
      stubQuote: turn.text.split('\n')[0]!,
      entityTerms: [detail.service, detail.key],
    };
  });
  return {
    id: spec.id,
    type: spec.type,
    turns: turnsList,
    details: foldedDetails,
    targetKey: foldedDetails[0]!.key,
    question: spec.question,
    expected: spec.expected,
    checks: spec.checks,
    ...(spec.number === undefined ? {} : { number: spec.number }),
    blocks: details.length,
    scale,
  };
}

/** 240 turns and six ~9k-character tool results: the ticket's "real scale". */
export const REAL_TASKS: FoldTask[] = REAL_SPECS.map((spec) => buildRealTask(spec, 6, 240, 'real'));

/** One target at 1/2/4/8/16 blocks, for the fold-enable threshold. */
export const SWEEP_TASKS: FoldTask[] = [1, 2, 4, 8, 16].map((blocks) =>
  ({
    ...buildRealTask(REAL_SPECS[0]!, blocks, 240, `${blocks} block${blocks === 1 ? '' : 's'}`),
    id: `r01-sweep-${blocks}`,
  }),
);

/** The checks `validateCorpus` makes for the small corpus, minus its fixed task/type counts. */
export function validateRealCorpus(tasks: FoldTask[]): string[] {
  const problems: string[] = [];
  for (const task of tasks) {
    if (task.turns.length < 100) problems.push(`${task.id}: only ${task.turns.length} turns`);
    if (task.details.length === 0) problems.push(`${task.id}: no folded details`);
    if (!task.targetKey) problems.push(`${task.id}: empty target key`);
    if (!task.checks.length) problems.push(`${task.id}: no checks`);
    if (task.question.includes(task.expected)) problems.push(`${task.id}: question leaks expected`);
    for (const detail of task.details) {
      const turn = task.turns.find((entry) => entry.id === detail.turnId);
      if (!turn) {
        problems.push(`${task.id}: missing turn ${detail.turnId}`);
        continue;
      }
      if (!turn.text.startsWith(detail.stubQuote)) problems.push(`${task.id}: ${detail.key} stub is not a prefix`);
      if (turn.text.length < 5_000) problems.push(`${task.id}: ${detail.key} tool output is only ${turn.text.length} chars`);
      if (detail.key === task.targetKey && !turn.text.includes(task.expected)) {
        problems.push(`${task.id}: target output does not contain the expected value`);
      }
    }
  }
  return problems;
}

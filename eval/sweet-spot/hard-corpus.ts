/**
 * #293 — the discriminating corpus. The 20-task corpus in `corpus.ts` scored 20/20 at every
 * band, so it could price context but not show a knee. These tasks add the four shapes the
 * ticket names: a two-hop chain, near-duplicate distractors, one multi-thousand-token tool
 * output, and a 200+ turn session. Every answer is still one exact code, so the same strict
 * grader applies; the corpus differs only in what has to be found and where it sits.
 *
 * Each task builds its own context to `band * 4` characters, the shell's `chars/4` unit, and
 * keeps the anchor lines at fixed relative depths at every band.
 */
import { createHash } from 'node:crypto';

import type { BuiltContext } from './types.ts';

export type HardType = 'multihop' | 'similar' | 'longtool' | 'session';

export interface HardTask {
  id: string;
  type: HardType;
  question: string;
  /** Strictly expected, in order. */
  expected: string[];
  render: (band: number, seed: number) => BuiltContext;
}

const ENTITIES = ['青岚', '白桦', '赤霄', '玄圃', '流萤', '长庚', '子规', '沧澜', '扶摇', '重明', '陆吾', '毕方'];
const ATTRIBUTES = ['备份保留期', '部署窗口', '值班负责人', '灰度比例', '回滚时限', '告警阈值', '审计周期', '密钥轮换', '容量上限', '演练频率', '重试上限', '超时时间'];
const OTHER_ENTITIES = Array.from({ length: 240 }, (_, index) => `项目${String(index + 1).padStart(4, '0')}`);

function padEntity(index: number): string {
  return OTHER_ENTITIES[index % OTHER_ENTITIES.length]!;
}

function padFact(index: number): string {
  return `${padEntity(index)}项目的${ATTRIBUTES[(index * 5) % ATTRIBUTES.length]!}编号是 Q${String(index % 10_000).padStart(4, '0')}-${index % 89}。`;
}

function shuffled<T>(items: T[], seed: number, taskId: string, salt: string): T[] {
  return items
    .map((item, index) => ({
      item,
      hash: createHash('sha256').update(`${seed}:${taskId}:${salt}:${index}`).digest('hex'),
    }))
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))
    .map((entry) => entry.item);
}

interface Group {
  depth: number;
  lines: string[];
}

/**
 * Pads to `band * 4` characters with generic distractors, then splices each group in at its
 * relative depth. The anchors are checked for presence before returning, so a bad depth (or a
 * budget too small for the anchors) fails the run instead of silently dropping the target.
 */
function layout(taskId: string, seed: number, band: number, groups: Group[], pad = padFact): BuiltContext {
  const anchorLines = groups.flatMap((group) => group.lines);
  const anchorChars = anchorLines.reduce((sum, line) => sum + line.length + 1, 0);
  const budget = Math.max(0, band * 4 - anchorChars);
  const pads: string[] = [];
  let chars = 0;
  for (let index = 0; chars < budget; index += 1) {
    const line = pad(index);
    pads.push(line);
    chars += line.length + 1;
  }
  const ordered = shuffled(pads, seed, taskId, `pad:${band}`);
  let inserted = 0;
  for (const group of [...groups].sort((left, right) => left.depth - right.depth)) {
    const at = Math.min(ordered.length, Math.floor(ordered.length * group.depth) + inserted);
    ordered.splice(at, 0, ...group.lines);
    inserted += group.lines.length;
  }
  const text = ordered.join('\n');
  for (const line of anchorLines) {
    if (!text.includes(line)) throw new Error(`${taskId} @ ${band}: anchor line missing`);
  }
  return {
    text,
    entries: ordered.length,
    targetLines: anchorLines,
    contextChars: text.length,
    contextTokens: Math.ceil(text.length / 4),
  };
}

interface MultihopSpec {
  id: string;
  entity: string;
  person: string;
  attribute: string;
  code: string;
  wrongPerson: string;
  wrongAttribute: string;
  wrongCode: string;
}

const MULTIHOP: MultihopSpec[] = [
  { id: 'mh01', entity: '青岚', person: '长庚', attribute: '告警阈值', code: 'KA-17', wrongPerson: '白桦', wrongAttribute: '备份保留期', wrongCode: 'KA-71' },
  { id: 'mh02', entity: '玄圃', person: '子规', attribute: '重试上限', code: 'RB-24', wrongPerson: '椒图', wrongAttribute: '回滚时限', wrongCode: 'RB-42' },
];

interface SimilarSpec {
  id: string;
  entity: string;
  attribute: string;
  code: string;
  nearEntity: string;
  nearCode: string;
  otherAttribute: string;
  otherCode: string;
  farEntity: string;
  farCode: string;
}

const SIMILAR: SimilarSpec[] = [
  { id: 'sm01', entity: '赤霄', attribute: '部署窗口', code: 'DW-31', nearEntity: '赤霄东', nearCode: 'DW-32', otherAttribute: '回滚时限', otherCode: 'DW-13', farEntity: '赤霄南', farCode: 'DW-310' },
  { id: 'sm02', entity: '重明', attribute: '审计周期', code: 'AU-48', nearEntity: '重明北', nearCode: 'AU-49', otherAttribute: '巡检频率', otherCode: 'AU-84', farEntity: '重明西', farCode: 'AU-480' },
];

interface LongToolSpec {
  id: string;
  service: string;
  code: string;
  nearService: string;
  nearCode: string;
  oldService: string;
  oldCode: string;
  canaryService: string;
  canaryCode: string;
}

const LONGTOOL: LongToolSpec[] = [
  { id: 'lt01', service: 'svc-alpha', code: 'RT-17', nearService: 'svc-alpha-2', nearCode: 'RT-18', oldService: 'svc-alpha-old', oldCode: 'RT-71', canaryService: 'svc-alpha-canary', canaryCode: 'RT-170' },
  { id: 'lt02', service: 'svc-orchid', code: 'PL-39', nearService: 'svc-orchid-2', nearCode: 'PL-40', oldService: 'svc-orchid-legacy', oldCode: 'PL-93', canaryService: 'svc-orchid-canary', canaryCode: 'PL-390' },
];

interface SessionSpec {
  id: string;
  entity: string;
  attribute: string;
  code: string;
  nearEntity: string;
  nearCode: string;
  otherAttribute: string;
  otherCode: string;
}

const SESSION: SessionSpec[] = [
  { id: 'se01', entity: '流萤', attribute: '密钥轮换', code: 'KR-56', nearEntity: '流萤西', nearCode: 'KR-560', otherAttribute: '审计周期', otherCode: 'KR-65' },
  { id: 'se02', entity: '扶摇', attribute: '灰度比例', code: 'GS-73', nearEntity: '扶摇北', nearCode: 'GS-730', otherAttribute: '容量上限', otherCode: 'GS-37' },
];

/** One tool-output block: a plausible config dump big enough to cost thousands of tokens. */
function toolBlock(spec: LongToolSpec, service: string, code: string, seed: number, index: number): string {
  const lines = [`[tool result] ${service} 配置快照（第 ${index + 1} 份，共 6 份）`, '{'];
  for (let key = 0; key < 70; key += 1) {
    const hash = createHash('sha256').update(`${spec.id}:${seed}:${service}:${key}`).digest('hex');
    const value = Number.parseInt(hash.slice(0, 4), 16);
    lines.push(`  "setting_${String(key).padStart(2, '0')}": ${value % 1000},`);
    if (key % 13 === 6) lines.push(`  "note_${key}": "节点 ${hash.slice(0, 6)} 在 ${value % 24}:00 之后退役",`);
  }
  lines.push(`  "release_code": "${code}",`);
  lines.push('}');
  return lines.join('\n');
}

const SESSION_UTTERANCES = [
  '今天先把手上的事情按优先级排一下，排在前面的是发布和巡检。',
  '刚才那条告警是测试环境触发的，不用担心，已经确认过了。',
  '我把上周的复盘看了一遍，有三条结论需要落到下周的计划里。',
  '这个接口的响应时间比预期慢一点，但还在可接受范围内。',
  '明天上午的同步会我可能晚到十分钟，材料已经发到群里。',
  '运维说磁盘还剩不少空间，暂时不用清理归档。',
  '我重新核对了一遍变更单，编号和审批记录都对得上。',
  '这一版的文案改了三处，都是措辞问题，不影响功能。',
  '监控面板新加了一个延迟分位，后面观察几天再说。',
  '这周的值班表已经排好，周五晚上那次演练由我来盯。',
  '昨天那个偶发失败没复现，先挂到观察列表里。',
  '文档里关于回滚步骤的描述有点旧了，回头统一改一次。',
  '压测结果比上次好一些，瓶颈还是在数据库连接上。',
  '我把会议纪要整理成了三条待办，稍后同步给大家。',
  '新同学问的那个配置项在启动参数里，不在配置文件里。',
  '这次发布窗口避开了月底结算，风险会小很多。',
];

function sessionLines(band: number, seed: number, taskId: string, anchors: Group[]): string[] {
  const anchorChars = anchors.flatMap((group) => group.lines).reduce((sum, line) => sum + line.length + 1, 0);
  const budget = Math.max(0, band * 4 - anchorChars);
  const lines: string[] = [];
  let chars = 0;
  for (let index = 0; chars < budget; index += 1) {
    const utterance = SESSION_UTTERANCES[index % SESSION_UTTERANCES.length]!;
    const speaker = index % 2 === 0 ? '负责人' : '助手';
    const line = `${speaker}：${utterance}`;
    lines.push(line);
    chars += line.length + 1;
  }
  const ordered = shuffled(lines, seed, taskId, `session:${band}`);
  let inserted = 0;
  for (const group of [...anchors].sort((left, right) => left.depth - right.depth)) {
    const at = Math.min(ordered.length, Math.floor(ordered.length * group.depth) + inserted);
    ordered.splice(at, 0, ...group.lines);
    inserted += group.lines.length;
  }
  return ordered;
}

function multihopTask(spec: MultihopSpec): HardTask {
  return {
    id: spec.id,
    type: 'multihop',
    question: `${spec.entity}项目的值班负责人所在项目的${spec.attribute}编号是多少？只写一个编号。`,
    expected: [spec.code],
    render: (band, seed) =>
      layout(spec.id, seed, band, [
        {
          depth: 0.08,
          lines: [
            `${spec.entity}项目的值班负责人是${spec.person}。`,
            `${spec.entity}东项目的值班负责人是${spec.wrongPerson}。`,
          ],
        },
        {
          depth: 0.55,
          lines: [
            `${spec.person}项目的${spec.attribute}编号是 ${spec.code}。`,
            `${spec.person}项目的${spec.wrongAttribute}编号是 ${spec.wrongCode}。`,
            `${spec.wrongPerson}项目的${spec.attribute}编号是 ${spec.wrongCode.replace(/\d+$/u, (digits) => `${digits}0`)}。`,
          ],
        },
      ]),
  };
}

function similarTask(spec: SimilarSpec): HardTask {
  return {
    id: spec.id,
    type: 'similar',
    question: `${spec.entity}项目的${spec.attribute}编号是多少？只写一个编号。`,
    expected: [spec.code],
    render: (band, seed) =>
      layout(spec.id, seed, band, [
        {
          depth: 0.5,
          lines: [
            `${spec.farEntity}项目的${spec.attribute}编号是 ${spec.farCode}。`,
            `${spec.entity}项目的${spec.attribute}编号是 ${spec.code}。`,
            `${spec.nearEntity}项目的${spec.attribute}编号是 ${spec.nearCode}。`,
            `${spec.entity}项目的${spec.otherAttribute}编号是 ${spec.otherCode}。`,
          ],
        },
      ]),
  };
}

function longToolTask(spec: LongToolSpec): HardTask {
  return {
    id: spec.id,
    type: 'longtool',
    question: `${spec.service} 的 release_code 是什么？只写一个编号。`,
    expected: [spec.code],
    render: (band, seed) => {
      const blocks = [
        { depth: 0.06, lines: [toolBlock(spec, spec.oldService, spec.oldCode, seed, 0)] },
        { depth: 0.22, lines: [toolBlock(spec, spec.nearService, spec.nearCode, seed, 1)] },
        { depth: 0.5, lines: [toolBlock(spec, spec.service, spec.code, seed, 2)] },
        { depth: 0.68, lines: [toolBlock(spec, spec.canaryService, spec.canaryCode, seed, 3)] },
      ];
      for (let index = 4; index < 6; index += 1) {
        blocks.push({
          depth: 0.82 + index * 0.02,
          lines: [toolBlock(spec, `svc-other-${index}`, `OT-${index * 17}`, seed, index)],
        });
      }
      return layout(spec.id, seed, band, blocks, (index) => `[log] ${padEntity(index)} 采样 ${index % 97} 条，丢弃 ${index % 7} 条。`);
    },
  };
}

function sessionTask(spec: SessionSpec): HardTask {
  return {
    id: spec.id,
    type: 'session',
    question: `${spec.entity}项目的${spec.attribute}编号是多少？只写一个编号。`,
    expected: [spec.code],
    render: (band, seed) => {
      const lines = sessionLines(band, seed, spec.id, [
        { depth: 0.015, lines: [`负责人：${spec.entity}项目的${spec.attribute}编号是 ${spec.code}。`] },
        { depth: 0.45, lines: [`助手：补充一下，${spec.nearEntity}项目的${spec.attribute}编号是 ${spec.nearCode}。`] },
        { depth: 0.8, lines: [`负责人：对了，${spec.entity}项目的${spec.otherAttribute}编号是 ${spec.otherCode}。`] },
      ]);
      const text = lines.join('\n');
      const anchors = [spec.code];
      return {
        text,
        entries: lines.length,
        targetLines: lines.filter((line) => anchors.some((code) => line.includes(code))),
        contextChars: text.length,
        contextTokens: Math.ceil(text.length / 4),
      };
    },
  };
}

export const HARD_TASKS: HardTask[] = [
  ...MULTIHOP.map(multihopTask),
  ...SIMILAR.map(similarTask),
  ...LONGTOOL.map(longToolTask),
  ...SESSION.map(sessionTask),
];

/** The four shapes must all be present, and no question may leak its answer code. */
export function validateHardCorpus(tasks: HardTask[] = HARD_TASKS): string[] {
  const problems: string[] = [];
  const types = new Set(tasks.map((task) => task.type));
  for (const type of ['multihop', 'similar', 'longtool', 'session'] as const) {
    if (!types.has(type)) problems.push(`missing task type ${type}`);
  }
  for (const task of tasks) {
    if (task.expected.length === 0) problems.push(`${task.id}: no expected code`);
    for (const code of task.expected) {
      if (task.question.includes(code)) problems.push(`${task.id}: question leaks ${code}`);
      const context = task.render(6_000, 258);
      if (!context.text.includes(code)) problems.push(`${task.id}: ${code} not in rendered text at 6000`);
    }
  }
  return problems;
}

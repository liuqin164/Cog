import { createHash } from 'node:crypto';

import type { BuiltContext, Fact, Task } from './types.ts';

export const BANDS = [6_000, 12_000, 24_000, 48_000] as const;
export const FACTS_PER_TASK = 5;

const ENTITIES = [
  '青岚', '白桦', '赤霄', '玄圃', '流萤', '长庚', '子规', '沧澜', '扶摇', '重明',
  '陆吾', '毕方', '椒图', '螭吻', '睚眦', '狴犴', '狻猊', '赑屃', '鸱吻', '麒麟',
];

const ATTRIBUTES = [
  '备份保留期', '部署窗口', '值班负责人', '灰度比例', '回滚时限',
  '告警阈值', '审计周期', '密钥轮换', '容量上限', '演练频率',
  '数据保留期', '发布窗口', '审批人', '采样比例', '重试上限',
  '超时时间', '归档周期', '巡检频率', '并发上限', '冷却时间',
];

const OTHER_ENTITIES = Array.from({ length: 200 }, (_, index) => `项目${String(index + 1).padStart(4, '0')}`);
const OTHER_ATTRIBUTES = [
  '审计周期', '密钥轮换', '容量上限', '演练频率', '数据保留期', '发布窗口', '审批人',
  '采样比例', '重试上限', '超时时间', '归档周期', '巡检频率', '并发上限', '冷却时间',
  '资源配额', '监控间隔', '日志级别', '同步批次',
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRST';

function questionFor(entity: string, facts: Fact[]): string {
  return `请按顺序给出${entity}项目以下${facts.length}项配置的编号：${facts.map((fact) => fact.attribute).join('、')}。只写${facts.length}个编号，用逗号分隔，不要解释。`;
}

export const TASKS: Task[] = ENTITIES.map((entity, index) => {
  const attributes = Array.from({ length: FACTS_PER_TASK }, (_, offset) => ATTRIBUTES[(index * FACTS_PER_TASK + offset) % ATTRIBUTES.length]!);
  const facts = attributes.map((attribute, offset) => ({
    entity,
    attribute,
    code: `K${LETTERS[index]}-${index * FACTS_PER_TASK + offset + 10}`,
  }));
  return { id: `t${String(index + 1).padStart(2, '0')}`, index, entity, facts, question: questionFor(entity, facts) };
});

/** Every target entity+attribute pair, used to keep distractors from sharing both cues. */
function targetPairs(task: Task): Set<string> {
  return new Set(task.facts.map((fact) => `${fact.entity}\u0000${fact.attribute}`));
}

/**
 * A distractor shares at most one cue with a target: it is the target entity with another
 * attribute, another entity with a target attribute, or neither. No distractor is the target pair.
 */
function distractorLine(task: Task, index: number): string {
  const targetAttributes = new Set(task.facts.map((fact) => fact.attribute));
  const otherAttributes = OTHER_ATTRIBUTES.filter((attribute) => !targetAttributes.has(attribute));
  const mode = index % 5;
  let entity: string;
  let attribute: string;
  if (mode < 2) {
    entity = task.entity;
    attribute = otherAttributes[(index + task.index) % otherAttributes.length]!;
  } else if (mode < 4) {
    entity = OTHER_ENTITIES[(index + task.index) % OTHER_ENTITIES.length]!;
    attribute = task.facts[index % task.facts.length]!.attribute;
  } else {
    entity = OTHER_ENTITIES[(index * 7 + task.index) % OTHER_ENTITIES.length]!;
    attribute = otherAttributes[(index * 3 + task.index) % otherAttributes.length]!;
  }
  const code = `P${String(index % 10_000).padStart(4, '0')}-${index % 97}`;
  return `${entity}项目的${attribute}编号是 ${code}。`;
}

function factLine(fact: Fact): string {
  return `${fact.entity}项目的${fact.attribute}编号是 ${fact.code}。`;
}

function shuffled<T>(items: T[], seed: number, taskId: string, band: number): T[] {
  return items
    .map((item, index) => ({
      item,
      hash: createHash('sha256').update(`${seed}:${taskId}:${band}:${index}`).digest('hex'),
    }))
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))
    .map((entry) => entry.item);
}

/**
 * One context: a single recall block sized to the shell's `targetTokens * 4` characters.
 * The five target lines sit at fixed relative depths (10/30/50/70/90%) so depth is not a
 * function of the band.
 */
export function buildContext(task: Task, band: number, seed: number): BuiltContext {
  const targetLines = task.facts.map(factLine);
  const targetChars = targetLines.reduce((sum, line) => sum + line.length + 1, 0);
  const budget = Math.max(0, band * 4 - targetChars);
  const distractors: string[] = [];
  let chars = 0;
  let index = 0;
  while (chars < budget) {
    const line = distractorLine(task, index);
    distractors.push(line);
    chars += line.length + 1;
    index += 1;
  }

  const ordered = shuffled(distractors, seed, task.id, band);
  const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
  for (const [offset, line] of targetLines.entries()) {
    const position = Math.floor(ordered.length * fractions[offset]!) + offset;
    ordered.splice(position, 0, line);
  }

  const text = ordered.join('\n');
  const pairs = targetPairs(task);
  const unique = new Set(ordered.filter((line) => task.facts.some((fact) => line === factLine(fact))).map((line) => line));
  if (unique.size !== task.facts.length) throw new Error(`target lines missing for ${task.id} at ${band}`);
  for (const fact of task.facts) {
    if (!text.includes(factLine(fact))) throw new Error(`target ${fact.code} missing for ${task.id} at ${band}`);
  }
  if (pairs.size !== task.facts.length) throw new Error(`duplicate target pair for ${task.id}`);

  return {
    text,
    entries: ordered.length,
    targetLines,
    contextChars: text.length,
    contextTokens: Math.ceil(text.length / 4),
  };
}

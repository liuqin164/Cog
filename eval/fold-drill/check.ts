/**
 * Deterministic scoring for the #254 fold/drill experiment.
 *
 * Correctness reads the required final line (`答案：<value>`). Hallucination is
 * the fixed rule from the ticket: a detail value in the answer that does not
 * occur anywhere in that task's ledger. The value extractors are deliberately
 * narrow; README records what they cannot see.
 */
import { ACTION_FAMILIES, NAME_POOL, autoExpandMatches, normalize } from './corpus.ts';
import type { Arm, DetailType, FoldTask } from './types.ts';

export const ARMS: Arm[] = ['full', 'folded_key', 'folded_auto'];
export const DETAIL_TYPES: DetailType[] = ['number', 'name', 'constraint', 'step'];

export interface Verdict {
  answerLine: string;
  correct: boolean;
  hallucinated: boolean;
  reason: string;
}

const ABSTENTIONS = ['不知道', '无法确定', '无法回答', '未提供', '没有提到', '材料中没有', '无法判断', '不确定'];

function canonNumber(raw: string): string {
  return String(Number(raw.replace(/,/gu, '')));
}

function numbersIn(text: string): string[] {
  const cleaned = text.normalize('NFKC').replace(/第\s*\d+\s*步/gu, ' ');
  return [...cleaned.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/gu)].map((match) => canonNumber(match[0]!));
}

function canonDay(raw: string): string {
  const last = raw.at(-1)!;
  return last === '天' ? '周日' : `周${last}`;
}

function timeTokens(text: string): Set<string> {
  const normalized = text.normalize('NFKC');
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/(?:星期|周)[一二三四五六日天]/gu)) tokens.add(canonDay(match[0]!));
  for (const match of normalized.matchAll(/(\d{1,2})(?::(\d{1,2})|点(?:(\d{1,2})分?)?)/gu)) {
    const hour = Number(match[1]);
    const minute = match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? Number(match[3]) : 0;
    tokens.add(`${hour}:${String(minute).padStart(2, '0')}`);
  }
  return tokens;
}

function namesIn(text: string): string[] {
  const normalized = normalize(text);
  return NAME_POOL.filter((name) => normalized.includes(normalize(name)));
}

function actionFamiliesIn(text: string): number[] {
  const normalized = normalize(text);
  return ACTION_FAMILIES.map((family, index) => (family.some((word) => normalized.includes(normalize(word))) ? index : -1)).filter(
    (index) => index >= 0,
  );
}

function answerLineOf(content: string): string {
  const matches = [...content.matchAll(/答案\s*[：:]\s*([^\n]+)/gu)];
  return matches.at(-1)?.[1]?.trim() ?? '';
}

function ledgerOf(task: FoldTask): string {
  return task.turns.map((turn) => turn.text).join('\n');
}

function groupsHit(task: FoldTask, answer: string): boolean {
  const normalized = normalize(answer);
  return task.checks.every((group) => group.some((term) => normalized.includes(normalize(term))));
}

export function classify(task: FoldTask, content: string): Verdict {
  const answerLine = answerLineOf(content);
  const ledger = ledgerOf(task);
  const ledgerNormalized = normalize(ledger);
  const ledgerNumbers = new Set(numbersIn(ledger));
  const ledgerTimes = timeTokens(ledger);
  const ledgerNames = new Set(namesIn(ledger));
  const ledgerActions = new Set(actionFamiliesIn(ledger));

  let correct = false;
  if (answerLine) {
    if (task.number !== undefined) {
      const numbers = numbersIn(answerLine);
      correct = numbers.length > 0 && Number(numbers[0]) === task.number;
    } else {
      correct = groupsHit(task, answerLine);
    }
  }

  let hallucinated = false;
  const reasons: string[] = [];

  const unknownNumber = numbersIn(content).find((number) => !ledgerNumbers.has(number));
  if (unknownNumber !== undefined) {
    hallucinated = true;
    reasons.push(`number ${unknownNumber} not in ledger`);
  }

  const unknownName = namesIn(content).find((name) => !ledgerNames.has(name));
  if (unknownName !== undefined) {
    hallucinated = true;
    reasons.push(`name ${unknownName} not in ledger`);
  }

  const unknownTime = [...timeTokens(content)].find((token) => !ledgerTimes.has(token));
  if (unknownTime !== undefined) {
    hallucinated = true;
    reasons.push(`time ${unknownTime} not in ledger`);
  }

  if (task.type === 'step') {
    const unknownAction = actionFamiliesIn(content).find((index) => !ledgerActions.has(index));
    if (unknownAction !== undefined) {
      hallucinated = true;
      reasons.push(`action ${ACTION_FAMILIES[unknownAction]![0]} not in ledger`);
    }
  }

  if (task.type === 'name' && !correct && answerLine) {
    const bare = normalize(answerLine).replace(/[，。；、,;.!?！？：:“”"'「」『』（）()]/gu, '');
    if (
      bare.length > 0 &&
      bare.length <= 12 &&
      !ABSTENTIONS.includes(bare) &&
      !ledgerNormalized.includes(bare)
    ) {
      hallucinated = true;
      reasons.push(`answer ${bare} not in ledger`);
    }
  }

  return {
    answerLine,
    correct,
    hallucinated,
    reason: reasons.length > 0 ? reasons.join('; ') : correct ? 'ok' : 'wrong',
  };
}

export interface CorpusStats {
  tasks: number;
  byType: Record<DetailType, number>;
  autoExpandHits: number;
  autoExpandMisses: number;
  avgTurns: number;
  avgChars: number;
}

export function corpusStats(tasks: FoldTask[]): CorpusStats {
  const byType = Object.fromEntries(DETAIL_TYPES.map((type) => [type, 0])) as Record<DetailType, number>;
  let autoExpandHits = 0;
  let chars = 0;
  for (const task of tasks) {
    byType[task.type] += 1;
    chars += task.turns.reduce((sum, turn) => sum + turn.text.length, 0);
    if (task.details.some((detail) => autoExpandMatches(task, detail.key, task.question))) autoExpandHits += 1;
  }
  return {
    tasks: tasks.length,
    byType,
    autoExpandHits,
    autoExpandMisses: tasks.length - autoExpandHits,
    avgTurns: tasks.length === 0 ? 0 : tasks.reduce((sum, task) => sum + task.turns.length, 0) / tasks.length,
    avgChars: tasks.length === 0 ? 0 : chars / tasks.length,
  };
}

export function validateCorpus(tasks: FoldTask[]): string[] {
  const problems: string[] = [];
  if (tasks.length !== 24) problems.push(`expected 24 tasks, found ${tasks.length}`);
  const ids = new Set<string>();
  const keys = new Set<string>();
  const stats = corpusStats(tasks);
  for (const type of DETAIL_TYPES) {
    if (stats.byType[type] !== 6) problems.push(`expected 6 ${type} tasks, found ${stats.byType[type]}`);
  }
  if (stats.autoExpandHits < 18) problems.push(`expected at least 18 auto-expansion hits, found ${stats.autoExpandHits}`);
  if (stats.autoExpandMisses < 3) problems.push(`expected at least 3 auto-expansion misses, found ${stats.autoExpandMisses}`);

  for (const task of tasks) {
    if (ids.has(task.id)) problems.push(`${task.id}: duplicate task id`);
    ids.add(task.id);
    if (task.details.length !== 3) problems.push(`${task.id}: expected 3 folded details, found ${task.details.length}`);
    if (!task.targetKey) problems.push(`${task.id}: empty target key`);
    if (!task.checks.length || task.checks.some((group) => group.length === 0)) {
      problems.push(`${task.id}: empty check group`);
    }
    if (!task.question.trim()) problems.push(`${task.id}: empty question`);
    if (normalize(task.question).includes(normalize(task.expected))) {
      problems.push(`${task.id}: question contains the expected value`);
    }
    if (task.number !== undefined && Number(task.expected) !== task.number) {
      problems.push(`${task.id}: expected "${task.expected}" does not match number ${task.number}`);
    }
    if (task.number !== undefined && task.type !== 'number' && task.type !== 'constraint') {
      problems.push(`${task.id}: numeric answer on a ${task.type} task`);
    }

    const target = task.details.find((detail) => detail.key === task.targetKey);
    if (!target) {
      problems.push(`${task.id}: target key is not in details`);
      continue;
    }
    const targetTurn = task.turns.find((turn) => turn.id === target.turnId);
    if (!targetTurn) {
      problems.push(`${task.id}: target turn ${target.turnId} is missing`);
    } else {
      if (!targetTurn.text.startsWith(target.stubQuote)) {
        problems.push(`${task.id}: target stub is not an exact prefix of ${target.turnId}`);
      }
      if (!targetTurn.text.includes(task.expected)) {
        problems.push(`${task.id}: target turn does not contain the expected value`);
      }
      if (normalize(target.stubQuote).includes(normalize(task.expected))) {
        problems.push(`${task.id}: target stub still contains the expected value`);
      }
      if (targetTurn.id !== task.turns[1]!.id) problems.push(`${task.id}: target detail is not the early turn`);
    }
    if (task.turns.length - 2 < 10) problems.push(`${task.id}: fewer than 10 turns after the target detail`);

    const matched = task.details.filter((detail) => autoExpandMatches(task, detail.key, task.question));
    if (matched.length > 1) problems.push(`${task.id}: auto-expansion matches ${matched.length} stubs`);
    if (matched.length === 1 && matched[0]!.key !== task.targetKey) {
      problems.push(`${task.id}: auto-expansion matches a distractor`);
    }

    for (const detail of task.details) {
      if (keys.has(detail.key)) problems.push(`${detail.key}: duplicate detail key`);
      keys.add(detail.key);
      if (!detail.entityTerms.length) problems.push(`${detail.key}: no entity terms`);
      const turn = task.turns.find((entry) => entry.id === detail.turnId);
      if (!turn) {
        problems.push(`${detail.key}: missing turn ${detail.turnId}`);
        continue;
      }
      if (!turn.text.startsWith(detail.stubQuote)) {
        problems.push(`${detail.key}: stub is not an exact prefix of ${detail.turnId}`);
      }
      if (detail.stubQuote.length >= turn.text.length) {
        problems.push(`${detail.key}: stub did not fold anything`);
      }
    }
  }
  return problems;
}

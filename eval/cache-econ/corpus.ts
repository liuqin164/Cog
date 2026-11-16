/**
 * The #259 C4 cache-economics corpus.
 *
 * Four sessions, one per detail type, each a 23-pair working conversation.
 * The target detail is in pair 2 and two same-type distractors are in pairs 12
 * and 21. The remaining pairs are filler paragraphs. The ledger is fixed: the
 * assistant replies are scripted, so the three arms see the same conversation
 * and only the fold projection differs.
 *
 * A fold stub is the kernel `SessionDigest` shape: entryId (the key), an exact
 * prefix quote of the pair's user turn, and sourceRefs. The value lives only in
 * the omitted suffix, so a folded arm has to call read_memory to recover it.
 */
import { createHash } from 'node:crypto';

import { TASKS } from '../fold-drill/corpus.ts';
import type { FoldTask, Turn } from '../fold-drill/types.ts';
import { FILLER } from '../fold-drill/corpus.ts';
import type { DetailType, Pair, Session } from './types.ts';

export const PAIR_COUNT = 23;
const DETAIL_TYPES: DetailType[] = ['number', 'name', 'constraint', 'step'];

const ACKS = [
  '收到，已记录。',
  '明白，记下了。',
  '收到，继续。',
  '好，这一轮已归档。',
  '记下了，下一项。',
  '收到，保持这个结论。',
  '明白，已写入纪要。',
  '收到，按这个执行。',
];

function hashOf(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function fillerFor(sessionId: string, pair: number, count: number): string {
  const digest = hashOf(`${sessionId}:${pair}`);
  const start = digest.readUInt32BE(0) % FILLER.length;
  return Array.from({ length: count }, (_, index) => FILLER[(start + index * 5) % FILLER.length]!).join('');
}

function ackFor(sessionId: string, pair: number): string {
  return ACKS[hashOf(`${sessionId}:ack:${pair}`).readUInt8(0) % ACKS.length]!;
}

function pairOf(sessionId: string, index: number, user: string, stubQuote: string): Pair {
  return {
    id: `${sessionId}-p${String(index).padStart(2, '0')}`,
    key: `digest:${sessionId}-p${String(index).padStart(2, '0')}`,
    user,
    assistant: ackFor(sessionId, index),
    stubQuote,
  };
}

function buildSession(base: FoldTask, index: number): Session {
  const id = `c0${index + 1}-${base.type}`;
  const setting = base.turns[0]!;
  const targetDetail = base.details.find((detail) => detail.key === base.targetKey)!;
  const targetTurn = base.turns.find((turn) => turn.id === targetDetail.turnId)!;
  const distractorDetails = base.details.filter((detail) => detail.key !== base.targetKey);
  const distractorTurns = distractorDetails.map((detail) => base.turns.find((turn) => turn.id === detail.turnId)!);
  const detailsByPair = new Map<number, { turn: Turn; detail: (typeof base.details)[number] }>([
    [2, { turn: targetTurn, detail: targetDetail }],
    [12, { turn: distractorTurns[0]!, detail: distractorDetails[0]! }],
    [21, { turn: distractorTurns[1]!, detail: distractorDetails[1]! }],
  ]);

  const pairs: Pair[] = [];
  for (let pair = 1; pair <= PAIR_COUNT; pair += 1) {
    if (pair === 1) {
      pairs.push(pairOf(id, pair, `${setting.text}\n${fillerFor(id, pair, 30)}`, setting.text));
      continue;
    }
    const detail = detailsByPair.get(pair);
    if (detail) {
      pairs.push(pairOf(id, pair, `${detail.turn.text}\n${fillerFor(id, pair, 30)}`, detail.detail.stubQuote));
      continue;
    }
    const user = fillerFor(id, pair, 36);
    pairs.push(pairOf(id, pair, user, user.slice(0, 24)));
  }

  return {
    id,
    type: base.type,
    baseTaskId: base.id,
    pairs,
    targetKey: `digest:${id}-p02`,
    question: base.question,
    expected: base.expected,
    checks: base.checks,
    ...(base.number === undefined ? {} : { number: base.number }),
  };
}

export const SESSIONS: Session[] = DETAIL_TYPES.map((type, index) => {
  const base = TASKS.find((task) => task.type === type)!;
  return buildSession(base, index);
});

/** The scoring task: the replayed ledger, so filler numbers are not hallucinations. */
export function scoringTask(session: Session): FoldTask {
  const turns: Turn[] = session.pairs.flatMap((pair) => [
    { id: `${pair.id}-u`, speaker: 'owner', text: pair.user },
    { id: `${pair.id}-a`, speaker: 'assistant', text: pair.assistant },
  ]);
  const target = session.pairs.find((pair) => pair.key === session.targetKey)!;
  return {
    id: session.id,
    type: session.type,
    turns,
    details: [
      {
        key: target.key,
        turnId: `${target.id}-u`,
        stubQuote: target.stubQuote,
        entityTerms: [session.expected],
      },
    ],
    targetKey: session.targetKey,
    question: session.question,
    expected: session.expected,
    checks: session.checks,
    ...(session.number === undefined ? {} : { number: session.number }),
  };
}

export function validateSessions(sessions: Session[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const session of sessions) {
    if (session.pairs.length !== PAIR_COUNT) {
      problems.push(`${session.id}: expected ${PAIR_COUNT} pairs, found ${session.pairs.length}`);
    }
    const target = session.pairs.find((pair) => pair.key === session.targetKey);
    if (!target) {
      problems.push(`${session.id}: target key is missing`);
    } else {
      if (!target.user.startsWith(target.stubQuote)) problems.push(`${session.id}: target stub is not an exact prefix`);
      if (!target.user.includes(session.expected)) problems.push(`${session.id}: target pair does not contain the expected value`);
      if (target.stubQuote.includes(session.expected)) problems.push(`${session.id}: target stub still contains the expected value`);
    }
    if (!session.question.trim()) problems.push(`${session.id}: empty question`);
    if (session.question.includes(session.expected)) problems.push(`${session.id}: question contains the expected value`);
    for (const pair of session.pairs) {
      if (keys.has(pair.key)) problems.push(`${pair.key}: duplicate key`);
      keys.add(pair.key);
      if (!pair.user.startsWith(pair.stubQuote)) problems.push(`${pair.id}: stub is not an exact prefix`);
      if (pair.stubQuote.length >= pair.user.length) problems.push(`${pair.id}: stub did not fold anything`);
    }
  }
  return problems;
}

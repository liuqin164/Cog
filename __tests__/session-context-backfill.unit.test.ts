import { describe, expect, test } from 'bun:test';

import {
  SESSION_CONTEXT_LANE_PRIORITY,
  assembleSessionContext,
  buildSessionDigest,
  sessionTokens,
  type SessionTurn,
} from '../src/session/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const TURN = '今天继续整理书架和旧照片，把上周的会议记录也归档了，顺便确认一下我的项目代号是什么，还有几份文档需要按日期重新排列，晚点再处理。';

function turns(count: number): SessionTurn[] {
  const text = (TURN + TURN).slice(0, 120);
  return Array.from({ length: count }, (_, index) => ({
    eventId: `evt-${String(index).padStart(6, '0')}`,
    projectId: 'p',
    sessionId: 's',
    threadId: 's',
    turnId: `run:${index}`,
    agentId: 'a',
    speaker: index % 2 === 0 ? 'owner' : 'agent',
    role: index % 2 === 0 ? 'user' : 'assistant',
    channel: 'terminal',
    text: index === 0 ? `${text} 项目代号是青岚。` : text,
    occurredAt: T0 + index * 1_000,
    globalSeq: index,
  }));
}

function assemble(count: number) {
  const digest = buildSessionDigest(turns(count), { sessionId: 's', tailTurns: 8 });
  return assembleSessionContext({
    projectId: 'p',
    agentId: 'a',
    sessionId: 's',
    targetTokens: 6_000,
    tailTurns: 8,
    pinned: ['你是 Cog，一个常驻的伙伴。'],
    profile: ['主人喜欢简洁。'],
    workingSet: ['整理书架'],
    recall: [
      { id: 'evt-r0', text: digest.tail.at(-1)!.text, anchorEvent: digest.tail.at(-1)!.eventId },
      { id: 'evt-r1', text: digest.tail.at(-2)!.text, anchorEvent: digest.tail.at(-2)!.eventId },
      { id: 'evt-r2', text: '项目代号是青岚。', anchorEvent: 'evt-000000' },
    ],
  }, digest);
}

describe('the lane cliff has a backfill (#316)', () => {
  test('recall is sacrificed last, then the digest', () => {
    expect(SESSION_CONTEXT_LANE_PRIORITY.recall).toBeGreaterThan(SESSION_CONTEXT_LANE_PRIORITY.digest);
    expect(SESSION_CONTEXT_LANE_PRIORITY.recall).toBeGreaterThan(SESSION_CONTEXT_LANE_PRIORITY.working_set);
  });

  for (const count of [120, 300, 1_000]) {
    test(`${count} turns: the assembly stays inside the target and above half of it`, () => {
      const assembly = assemble(count);
      const recall = assembly.lanes.find((lane) => lane.lane === 'recall')!;
      const working = assembly.lanes.find((lane) => lane.lane === 'working_set')!;
      expect(assembly.usedTokens).toBeLessThanOrEqual(assembly.targetTokens);
      expect(sessionTokens(assembly.text)).toBeLessThanOrEqual(assembly.targetTokens);
      expect(assembly.usedTokens / assembly.targetTokens).toBeGreaterThanOrEqual(0.5);
      expect(recall.status).toBe('included');
      expect(recall.items.length).toBeGreaterThan(0);
      expect(working.status).toBe('included');
      expect(working.items.length).toBeGreaterThan(0);
    });
  }

  test('a partly restored lane keeps the ids it left out browseable', () => {
    const assembly = assemble(1_000);
    const digest = assembly.lanes.find((lane) => lane.lane === 'digest')!;
    const decision = assembly.decisionTrace.find((entry) => entry.lane === 'digest')!;
    expect(digest.status).toBe('included');
    expect(digest.browseIds.length).toBeGreaterThan(0);
    expect(decision.action).toBe('trimmed');
    expect(decision.browseIds).toEqual(digest.browseIds.slice(-20));
    expect(digest.text).toContain('[digest: browse-only');
  });

  test('a prohibition stays verbatim when the digest is under pressure', () => {
    const many = turns(300);
    many[0] = { ...many[0]!, text: '绝对不能把密钥写进日志。' };
    const digest = buildSessionDigest(many, { sessionId: 's', tailTurns: 8 });
    const assembly = assembleSessionContext({
      projectId: 'p',
      agentId: 'a',
      sessionId: 's',
      targetTokens: 900,
      tailTurns: 8,
      pinned: ['你是 Cog。'],
      profile: ['主人喜欢简洁。'],
    }, digest);
    const lane = assembly.lanes.find((entry) => entry.lane === 'digest')!;
    expect(lane.items.some((item) => item.text.includes('绝对不能'))).toBe(true);
    expect(lane.text).toContain('绝对不能把密钥写进日志。');
  });
});

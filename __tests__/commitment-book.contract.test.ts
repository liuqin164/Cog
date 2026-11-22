import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import {
  COMMITMENT_API_METHODS,
  COMMITMENT_CONTRACT_VERSION,
  COMMITMENT_ENTRY_FIELDS,
  COMMITMENT_ERROR_CODES,
  COMMITMENT_EVENT_TYPES,
  COMMITMENT_MAX_SNOOZES,
  COMMITMENT_OWNERS,
  COMMITMENT_STATUSES,
  recognizeCommitments,
} from '../src/commitment/index.js';
import {
  COMMITMENT_SEED_NEGATIVES,
  COMMITMENT_SEED_NOW,
  COMMITMENT_SEED_POSITIVES,
} from './fixtures/commitment-seed.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * The F16 commitment-book contract (#193), asserted against the document it claims to implement.
 *
 * The acceptance: promises enter with owner/content/due asserted item by item; non-promises do not;
 * the seed set clears 90% precision and recall; an arrived promise is announced once (query twice);
 * completion closes it and keeps the evidence turn; ambiguous evidence earns exactly one question;
 * and the agent's own arrived promise appears in the session wake assembly through F14's API.
 */

const scratch = makeTempDir('cogmem-commitment-contract-');
const dbPath = join(scratch, 'memory.db');
let kernel: MemoryKernel;

beforeAll(() => {
  kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
});

afterAll(() => {
  kernel.close();
});

const DAY = 24 * 60 * 60 * 1000;
const markdown = readFileSync(fileURLToPath(new URL('../docs/commitments.md', import.meta.url)), 'utf8');

function sectionAfter(heading: string): string {
  return markdown.split(heading)[1]?.split(/\n#{2,3} /)[0] ?? '';
}

function backtickedFirstColumn(section: string): string[] {
  return [...section.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9_.-]*)`/gmu)].map((match) => match[1]!);
}

function say(input: { projectId: string; text: string; role?: 'user' | 'assistant' | 'other'; occurredAt: number; threadId?: string; sessionId?: string }) {
  return kernel.recordRawEvent({
    projectId: input.projectId,
    threadId: input.threadId ?? `t-${input.projectId}`,
    sessionId: input.sessionId,
    role: input.role ?? 'user',
    content: input.text,
    occurredAt: input.occurredAt,
  });
}

describe('the contract document and the frozen lists agree', () => {
  test('the owner and status tables are exactly their frozen lists, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## Owners (frozen)'))).toEqual([...COMMITMENT_OWNERS]);
    expect(backtickedFirstColumn(sectionAfter('## Statuses (frozen)'))).toEqual([...COMMITMENT_STATUSES]);
  });

  test('the face table is exactly COMMITMENT_API_METHODS, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## The face (frozen)'))).toEqual([...COMMITMENT_API_METHODS]);
  });

  test('the entry-field table is exactly COMMITMENT_ENTRY_FIELDS, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## Entry fields (frozen)'))).toEqual([...COMMITMENT_ENTRY_FIELDS]);
  });

  test('the book-event table is exactly COMMITMENT_EVENT_TYPES, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## Book events (frozen)'))).toEqual([...COMMITMENT_EVENT_TYPES]);
  });

  test('the error table is exactly COMMITMENT_ERROR_CODES, in order', () => {
    expect(backtickedFirstColumn(sectionAfter('## Errors (frozen)'))).toEqual([...COMMITMENT_ERROR_CODES]);
  });

  test('the snooze cap table is COMMITMENT_MAX_SNOOZES', () => {
    const row = [...sectionAfter('## Snooze rules (frozen)').matchAll(/^\|\s*`maxSnoozes`\s*\|\s*`(\d+)`/gmu)][0];
    expect(Number(row?.[1])).toBe(COMMITMENT_MAX_SNOOZES);
  });

  test('every frozen method exists and the version is 1', () => {
    expect(COMMITMENT_CONTRACT_VERSION).toBe(1);
    for (const method of COMMITMENT_API_METHODS) {
      expect(typeof (kernel.commitments as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });
});

describe('the seed evaluation gate', () => {
  test('显式承诺的准确率与召回率各 ≥90%，正负样例都备', () => {
    let truePositives = 0;
    let falseNegatives = 0;
    let falsePositives = 0;
    for (const sample of COMMITMENT_SEED_POSITIVES) {
      const got = recognizeCommitments({ text: sample.text, role: sample.role, occurredAt: COMMITMENT_SEED_NOW });
      const hit = got.some((signal) => signal.owner === sample.owner
        && (sample.due === 'none' || (sample.due === 'condition' ? Boolean(signal.dueCondition) : Boolean(signal.dueAt))));
      if (hit) truePositives += 1;
      else falseNegatives += 1;
    }
    for (const sample of COMMITMENT_SEED_NEGATIVES) {
      const got = recognizeCommitments({ text: sample.text, role: sample.role, occurredAt: COMMITMENT_SEED_NOW });
      if (got.length > 0) falsePositives += 1;
    }
    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);
    // Reported by the suite so the round's numbers are visible, not inferred.
    console.log(`[F16 seed] positive=${COMMITMENT_SEED_POSITIVES.length} negative=${COMMITMENT_SEED_NEGATIVES.length} `
      + `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

describe('a promise enters with owner, content and due, item by item', () => {
  test('用户 / 智能体 / 第三方各自的承诺入册正确', () => {
    const projectId = 'commitment-owners';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    say({ projectId, text: '我会在周五前把报告整理好。', role: 'assistant', occurredAt: now + 1_000 });
    say({ projectId, text: '客服承诺周五前回复我。', occurredAt: now + 2_000 });
    const result = kernel.commitments.compile({ projectId, now: now + 3_000 });
    expect(result.opened).toBe(3);

    const book = kernel.commitments.list({ projectId, now: now + 3_000 });
    const user = book.find((entry) => entry.owner === 'user')!;
    const agent = book.find((entry) => entry.owner === 'agent')!;
    const third = book.find((entry) => entry.owner === 'third-party')!;
    expect(user.content).toContain('文件');
    expect(user.dueAt).toBe(Date.UTC(2026, 10, 16, 18));
    expect(user.confidence).toBe('explicit');
    expect(agent.content).toContain('报告');
    expect(agent.dueAt).toBeGreaterThan(now);
    expect(third.content).toContain('客服');
    // A reported promise is recorded, but not as the promiser's own explicit word.
    expect(third.confidence).toBe('tentative');

    // 谁 / 何事 / 何时 are on the entry, and the source turn is walkable.
    for (const entry of book) {
      expect(entry.sourceRefs.length).toBeGreaterThan(0);
      expect(kernel.eventStore.getEvent(entry.sourceRefs[0]!.eventId!)).toBeTruthy();
    }
  });

  test('非承诺陈述（闲聊、假设、转述他人计划、问句、习惯、过去）不误入', () => {
    const projectId = 'commitment-negatives';
    const now = Date.UTC(2026, 10, 15, 9);
    const talk = [
      '今天好累。',
      '如果明天下雨，我就不去了。',
      '他说他明天要去跑步。',
      '你明天能发我一份吗？',
      '我一般周五交报告。',
      '我昨天已经把文件发你了。',
      '我可能会晚点到。',
      '明天记得带伞。',
    ];
    talk.forEach((text, index) => say({ projectId, text, occurredAt: now + index * 1_000 }));
    kernel.commitments.compile({ projectId, now: now + 10_000 });
    expect(kernel.commitments.list({ projectId, now: now + 10_000 })).toEqual([]);
  });

  test('条件承诺带 dueCondition 而不是伪造的到期时刻', () => {
    const projectId = 'commitment-condition';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '等发货后我再联系你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });
    const entry = kernel.commitments.list({ projectId, now: now + 1_000 })[0]!;
    expect(entry.dueCondition).toContain('发货');
    expect(entry.dueAt).toBeUndefined();
    expect(entry.status).toBe('pending');
  });
});

describe('an arrived promise is announced once', () => {
  test('到期只浮现一次，重复查询不重发', () => {
    const projectId = 'commitment-once';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });

    const due = Date.UTC(2026, 10, 16, 19); // an hour past the 18:00 due instant
    const first = kernel.commitments.surfaceDue({ projectId, now: due });
    const second = kernel.commitments.surfaceDue({ projectId, now: due + 1_000 });
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe('overdue');
    expect(first[0]!.reason).toContain('due:overdue');
    expect(second).toEqual([]);

    // The same mark is what F6's proactive candidate reads, so the shell cannot re-announce it.
    const p2 = 'commitment-once-f6';
    say({ projectId: p2, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId: p2, now: now + 1_000 });
    const surfaced = kernel.surfacing.candidates({ projectId: p2, channel: 'proactive', now: due });
    const again = kernel.surfacing.candidates({ projectId: p2, channel: 'proactive', now: due + 1_000 });
    expect(surfaced.candidates.some((candidate) => candidate.source === 'commitment')).toBe(true);
    expect(again.candidates.some((candidate) => candidate.source === 'commitment')).toBe(false);
  });

  test('dismiss 后本次到期不再浮现，承诺仍在册', () => {
    const projectId = 'commitment-dismiss';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });
    const entry = kernel.commitments.list({ projectId, now: now + 1_000 })[0]!;
    const due = now + DAY + 60 * 60 * 1000;
    kernel.commitments.dismiss({ projectId, commitmentId: entry.commitmentId, now: due - 1_000 });
    expect(kernel.commitments.surfaceDue({ projectId, now: due })).toEqual([]);
    expect(kernel.commitments.list({ projectId, now: due })).toHaveLength(1);
  });
});

describe('snooze defers an announced promise to the caller-chosen instant', () => {
  function announced(projectId: string, now: number) {
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });
    const entry = kernel.commitments.list({ projectId, now: now + 1_000 })[0]!;
    expect(kernel.commitments.surfaceDue({ projectId, now: entry.dueAt! })).toHaveLength(1);
    return entry;
  }

  test('调用方给定的 resume 时刻被原样记下，到点前静默、到点只浮一次', () => {
    const projectId = 'commitment-snooze-time';
    const now = Date.UTC(2026, 10, 15, 9);
    const entry = announced(projectId, now);
    const due = entry.dueAt!;
    const resumeAt = due + 2 * 60 * 60 * 1000;

    const snoozed = kernel.commitments.snooze({
      projectId, commitmentId: entry.commitmentId, resumeAt, reason: '用户说一小时后', now: due + 1_000,
    });
    expect(snoozed.resumeAt).toBe(resumeAt);
    expect(snoozed.snoozeCount).toBe(1);
    // The promise is not closed and its own status is unchanged by the deferral.
    expect(snoozed.status).toBe('overdue');

    const row = kernel.commitments.audit({ projectId, commitmentId: entry.commitmentId })
      .find((candidate) => candidate.eventType === 'COMMITMENT_SNOOZED')!;
    expect(row.payload.resumeAt).toBe(resumeAt);
    expect(row.payload.reason).toBe('用户说一小时后');

    expect(kernel.commitments.surfaceDue({ projectId, now: resumeAt - 1 })).toEqual([]);
    expect(kernel.commitments.surfaceDue({ projectId, now: resumeAt })).toHaveLength(1);
    expect(kernel.commitments.surfaceDue({ projectId, now: resumeAt + 1 })).toEqual([]);
  });

  test('resume 必须是未来时刻；未浮现的承诺不能顺延', () => {
    const projectId = 'commitment-snooze-guards';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });
    const entry = kernel.commitments.list({ projectId, now: now + 1_000 })[0]!;
    const due = entry.dueAt!;

    expect(() => kernel.commitments.snooze({
      projectId, commitmentId: entry.commitmentId, resumeAt: due, now: due,
    })).toThrow('commitment_not_surfaced');

    kernel.commitments.surfaceDue({ projectId, now: due });
    expect(() => kernel.commitments.snooze({
      projectId, commitmentId: entry.commitmentId, resumeAt: due, now: due,
    })).toThrow('invalid_commitment_resume');
    expect(() => kernel.commitments.snooze({
      projectId, commitmentId: entry.commitmentId, resumeAt: Number.NaN, now: due,
    })).toThrow('invalid_commitment_resume');
  });

  test('同一原始到期最多 3 次，第 4 次拒绝且不再有主动浮现', () => {
    const projectId = 'commitment-snooze-cap';
    const now = Date.UTC(2026, 10, 15, 9);
    const entry = announced(projectId, now);
    const hour = 60 * 60 * 1000;
    let occurrence = entry.dueAt!;
    for (let index = 0; index < COMMITMENT_MAX_SNOOZES; index += 1) {
      if (index > 0) expect(kernel.commitments.surfaceDue({ projectId, now: occurrence })).toHaveLength(1);
      kernel.commitments.snooze({
        projectId, commitmentId: entry.commitmentId, resumeAt: occurrence + hour, now: occurrence + 1,
      });
      occurrence += hour;
    }
    // The third resume is the last occurrence the book announces.
    expect(kernel.commitments.surfaceDue({ projectId, now: occurrence })).toHaveLength(1);
    expect(() => kernel.commitments.snooze({
      projectId, commitmentId: entry.commitmentId, resumeAt: occurrence + hour, now: occurrence + 2,
    })).toThrow('commitment_snooze_limit');
    expect(kernel.commitments.surfaceDue({ projectId, now: occurrence + hour })).toEqual([]);
    expect(kernel.commitments.list({ projectId, now: occurrence + hour })[0]!.snoozeCount).toBe(3);
  });

  test('snooze 不写 F7 反馈行，ignore 计数与冷却不变', () => {
    const projectId = 'commitment-snooze-f7';
    const now = Date.UTC(2026, 10, 15, 9);
    const entry = announced(projectId, now);
    const due = entry.dueAt!;
    const before = kernel.surfacingFeedback.state({ projectId, now: due })
      .types.find((type) => type.type === 'commitment')!;
    kernel.commitments.snooze({
      projectId, commitmentId: entry.commitmentId, resumeAt: due + 60 * 60 * 1000, now: due + 1_000,
    });
    const after = kernel.surfacingFeedback.state({ projectId, now: due + 2_000 })
      .types.find((type) => type.type === 'commitment')!;
    expect(after).toEqual(before);
    expect(after.consecutiveIgnored).toBe(0);
    expect(after.level).toBe(0);
    expect(after.cooldownUntil).toBeNull();
  });

  test('dismiss 与 snooze 标记互不串扰', () => {
    const now = Date.UTC(2026, 10, 15, 9);
    const hour = 60 * 60 * 1000;

    // A snooze then a dismiss: the dismiss silences the resume occurrence.
    const first = 'commitment-snooze-then-dismiss';
    const firstEntry = announced(first, now);
    const firstResume = firstEntry.dueAt! + hour;
    kernel.commitments.snooze({
      projectId: first, commitmentId: firstEntry.commitmentId, resumeAt: firstResume, now: firstEntry.dueAt! + 1,
    });
    kernel.commitments.dismiss({ projectId: first, commitmentId: firstEntry.commitmentId, now: firstEntry.dueAt! + 2 });
    expect(kernel.commitments.surfaceDue({ projectId: first, now: firstResume })).toEqual([]);

    // A dismiss then a snooze: the snooze creates a new occurrence the dismiss does not cover.
    const second = 'commitment-dismiss-then-snooze';
    const secondEntry = announced(second, now);
    const secondResume = secondEntry.dueAt! + hour;
    kernel.commitments.dismiss({ projectId: second, commitmentId: secondEntry.commitmentId, now: secondEntry.dueAt! + 1 });
    kernel.commitments.snooze({
      projectId: second, commitmentId: secondEntry.commitmentId, resumeAt: secondResume, now: secondEntry.dueAt! + 2,
    });
    expect(kernel.commitments.surfaceDue({ projectId: second, now: secondResume })).toHaveLength(1);
  });

  test('resume 再浮现仍走 F18 路由', () => {
    const projectId = 'commitment-snooze-f18';
    const now = Date.UTC(2026, 10, 15, 9);
    const entry = announced(projectId, now);
    const resumeAt = entry.dueAt! + 2 * 60 * 60 * 1000;
    kernel.commitments.snooze({
      projectId, commitmentId: entry.commitmentId, resumeAt, now: entry.dueAt! + 1_000,
    });
    const resumed = kernel.surfacing.candidates({ projectId, channel: 'proactive', now: resumeAt });
    const candidate = resumed.candidates.find((item) => item.source === 'commitment')!;
    expect(candidate).toBeTruthy();
    const decision = kernel.deliveryRouter.route({
      projectId,
      candidate,
      occasion: 'private',
      userState: 'night-dnd',
      channel: { reachability: 'online', interruptibility: 'high' },
      // The router's existing F7 downgrade is what lets a night-dnd arrival queue for the summary.
      feedback: { level: 3, stopped: false },
      now: resumeAt,
    });
    expect(decision.destination).toBe('morning-summary');
  });

  test('重启后 SNOOZED 保持，resume 前静默、到点一次', () => {
    const scratch = makeTempDir('cogmem-commitment-snooze-');
    const dbPath = join(scratch, 'memory.db');
    const projectId = 'commitment-snooze-restart';
    const now = Date.UTC(2026, 10, 15, 9);
    const resumeAt = Date.UTC(2026, 10, 17, 8);

    const first = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
    try {
      first.recordRawEvent({ projectId, threadId: 't', role: 'user', content: '我明天把文件发你。', occurredAt: now });
      first.commitments.compile({ projectId, now: now + 1_000 });
      const entry = first.commitments.list({ projectId, now: now + 1_000 })[0]!;
      expect(first.commitments.surfaceDue({ projectId, now: entry.dueAt! })).toHaveLength(1);
      first.commitments.snooze({
        projectId, commitmentId: entry.commitmentId, resumeAt, now: entry.dueAt! + 1_000,
      });
    } finally {
      first.close();
    }

    const second = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
    try {
      const entry = second.commitments.list({ projectId, now: resumeAt - 1 })[0]!;
      expect(entry.resumeAt).toBe(resumeAt);
      expect(entry.snoozeCount).toBe(1);
      expect(second.commitments.surfaceDue({ projectId, now: resumeAt - 1 })).toEqual([]);
      expect(second.commitments.surfaceDue({ projectId, now: resumeAt })).toHaveLength(1);
      expect(second.commitments.surfaceDue({ projectId, now: resumeAt + 1 })).toEqual([]);
    } finally {
      second.close();
    }
  });
});

describe('completion closes the promise and keeps the evidence', () => {
  test('完成提及自动销账且 sourceRefs 指回完成回合', () => {
    const projectId = 'commitment-complete';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });
    const opened = kernel.commitments.list({ projectId, now: now + 1_000 })[0]!;

    const done = say({ projectId, text: '文件已经发了。', occurredAt: now + DAY + 2 * 60 * 60 * 1000 });
    const compiled = kernel.commitments.compile({ projectId, now: now + DAY + 3 * 60 * 60 * 1000 });
    expect(compiled.closed).toBe(1);
    const closed = kernel.commitments.list({ projectId, now: now + DAY + 3 * 60 * 60 * 1000 })[0]!;
    expect(closed.status).toBe('completed');
    expect(closed.closedAt).toBe(done.occurredAt);
    expect(closed.sourceRefs.map((ref) => ref.eventId)).toContain(done.eventId);
    expect(closed.sourceRefs.map((ref) => ref.eventId)).toContain(opened.sourceRefs[0]!.eventId!);

    // Idempotent: compiling again does not append a second close.
    const again = kernel.commitments.compile({ projectId, now: now + DAY + 4 * 60 * 60 * 1000 });
    expect(again.closed).toBe(0);
    expect(kernel.commitments.audit({ projectId }).filter((row) => row.eventType === 'COMMITMENT_CLOSED')).toHaveLength(1);
  });

  test('completed artifact metadata closes by naming the commitment', () => {
    const projectId = 'commitment-artifact';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });
    const entry = kernel.commitments.list({ projectId, now: now + 1_000 })[0]!;
    const artifact = kernel.recordTaskEvent({
      projectId, threadId: 't-artifact', content: 'uploaded file', occurredAt: now + DAY,
      metadata: { completesCommitment: entry.commitmentId },
    });
    kernel.commitments.compile({ projectId, now: now + DAY + 1_000 });
    const closed = kernel.commitments.list({ projectId, now: now + DAY + 1_000 })[0]!;
    expect(closed.status).toBe('completed');
    expect(closed.sourceRefs.map((ref) => ref.eventId)).toContain(artifact.eventId);
  });

  test('取消也走关闭，且证据必须是本项目的真实回合', () => {
    const projectId = 'commitment-cancel';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把文件发你。', occurredAt: now });
    kernel.commitments.compile({ projectId, now: now + 1_000 });
    const entry = kernel.commitments.list({ projectId, now: now + 1_000 })[0]!;
    const word = say({ projectId, text: '算了，不用发了。', occurredAt: now + 2_000 });
    const cancelled = kernel.commitments.cancel({ projectId, commitmentId: entry.commitmentId, evidenceEventId: word.eventId, now: now + 3_000 });
    expect(cancelled.status).toBe('cancelled');
    expect(() => kernel.commitments.cancel({ projectId, commitmentId: entry.commitmentId, evidenceEventId: 'missing' }))
      .toThrow('invalid_commitment_evidence');
  });
});

describe('ambiguous completion evidence earns exactly one question', () => {
  test('暧昧证据只问一次，不连环催', () => {
    const projectId = 'commitment-ask-once';
    const now = Date.UTC(2026, 10, 15, 9);
    say({ projectId, text: '我明天把报告交上去。', occurredAt: now });
    say({ projectId, text: '报告应该已经交了。', occurredAt: now + DAY });
    kernel.commitments.compile({ projectId, now: now + DAY + 1_000 });
    const first = kernel.commitments.askOnce({ projectId, now: now + DAY + 1_000 });
    const second = kernel.commitments.askOnce({ projectId, now: now + DAY + 2_000 });
    expect(first).toHaveLength(1);
    expect(first[0]!.question).toContain('完成了吗');
    expect(second).toEqual([]);
    // It stays open: an ambiguous report is not evidence enough to close it.
    expect(kernel.commitments.list({ projectId, now: now + DAY + 2_000 })[0]!.status).not.toBe('completed');
  });
});

describe("the agent's own promise arrives in its wake assembly", () => {
  test('智能体自己的承诺到期出现在唤醒组装里（经 F14 open-loop port）', async () => {
    const projectId = 'commitment-wake';
    const now = Date.now();
    const sessionId = 'wake-hermes';
    await kernel.appendEpisodeMessageAsync({
      projectId, sessionId, sourceAgent: 'hermes', role: 'assistant',
      text: '我明天把结果发你。', timestamp: now - 3 * DAY,
    });
    await kernel.appendEpisodeMessageAsync({
      projectId, sessionId: 'wake-pi', sourceAgent: 'pi', role: 'assistant',
      text: '我明天把发票寄给你。', timestamp: now - 3 * DAY,
    });
    kernel.commitments.compile({ projectId, now: now - 2 * DAY });

    // Reading the wake context is pure: it must not consume the announce-once mark.
    expect(kernel.commitments.dueForAgent({ projectId, agentId: 'hermes', now }).map((entry) => entry.content))
      .toEqual(['我明天把结果发你']);
    expect(kernel.commitments.dueForAgent({ projectId, agentId: 'pi', now }).map((entry) => entry.content))
      .toEqual(['我明天把发票寄给你']);
    expect(kernel.commitments.dueForAgent({ projectId, agentId: 'hermes', now })).toHaveLength(1);
    expect(kernel.commitments.surfaceDue({ projectId, now })).toHaveLength(2);

    const assembly = kernel.sessionContext.assemble({
      projectId, agentId: 'hermes', sessionId, targetTokens: 4_000, now,
    });
    const working = assembly.lanes.find((lane) => lane.lane === 'working_set')!;
    expect(working.items.some((item) => item.text.includes('承诺：') && item.text.includes('结果'))).toBe(true);
    expect(working.items.find((item) => item.text.includes('承诺：'))?.sourceRefs?.length).toBeGreaterThan(0);
    // F14's lane order is untouched: this entered through its open-loop port, not a new lane.
    expect(assembly.lanes.map((lane) => lane.lane)).toEqual(['pinned', 'profile', 'digest', 'working_set', 'recall', 'tail']);
  });
});

describe('a busy ledger still sees its newest turn', () => {
  test('5000 条 tool 事件之后的新承诺仍入册，并只提醒一次', () => {
    const projectId = 'commitment-aging';
    const now = Date.UTC(2026, 10, 15, 9);
    kernel.eventStore.getDatabase().transaction(() => {
      for (let index = 0; index < 5000; index += 1) {
        kernel.recordTaskEvent({
          projectId, threadId: 't-aging', content: `tool ${index}`, rawEventType: 'tool_call', occurredAt: now + index,
        });
      }
    })();
    say({ projectId, text: '我明天把文件发你。', occurredAt: now + 5000 });
    const compiledAt = now + 6000;
    expect(kernel.commitments.compile({ projectId, now: compiledAt }).opened).toBe(1);
    const entries = kernel.commitments.list({ projectId, now: compiledAt });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toContain('文件');
    expect(kernel.commitments.surfaceDue({ projectId, now: entries[0]!.dueAt! })).toHaveLength(1);
    expect(kernel.commitments.surfaceDue({ projectId, now: entries[0]!.dueAt! })).toHaveLength(0);
  }, 30_000);
});

import { describe, expect, test } from 'bun:test';
import type Database from 'bun:sqlite';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import {
  assembleSessionContext,
  buildDeepCardEntry,
  createSessionDeepCompiler,
  digestAnchors,
  planDeepSegments,
  type SessionDigestEntry,
  type SessionTurn,
} from '../src/session/index.js';
import { makeTempDir } from './helpers/tmp.js';

const GAP = 30 * 60_000;
const T0 = Date.UTC(2026, 10, 23, 1, 0, 0);

function turn(index: number, at: number, text = `第 ${index} 轮：整理文档，检查第 ${index} 节。`): SessionTurn {
  return {
    eventId: `evt-${index}`,
    projectId: 'p',
    sessionId: 's',
    threadId: 's',
    turnId: `run-${index}:0`,
    agentId: 'a',
    speaker: index % 2 === 0 ? 'owner' : 'agent',
    role: index % 2 === 0 ? 'user' : 'assistant',
    channel: 'terminal',
    text,
    occurredAt: at,
    globalSeq: index,
  };
}

function continuous(count: number, start = T0, step = 1_000): SessionTurn[] {
  return Array.from({ length: count }, (_, index) => turn(index, start + index * step));
}

describe('deterministic episode segmentation (#474)', () => {
  test('a continuous run closes on the gap to now and is one segment', () => {
    const turns = continuous(20);
    const segments = planDeepSegments(turns, [], T0 + 20_000 + GAP + 1);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.turns).toHaveLength(20);
    expect(segments[0]!.declared).toBe(false);
  });

  test('an idle gap splits two work segments', () => {
    const first = continuous(10);
    const second = continuous(10, T0 + 10_000 + GAP + 1).map((item, index) => ({
      ...item,
      eventId: `evt-late-${index}`,
    }));
    const segments = planDeepSegments([...first, ...second], [], T0 + 20_000 + GAP * 2);
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.turns.length)).toEqual([10, 10]);
  });

  test('a task end is a hard boundary and marks the segment declared', () => {
    const turns = continuous(20);
    const segments = planDeepSegments(turns, [T0 + 10_500], T0 + 20_000 + GAP + 1);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.declared).toBe(true);
    expect(segments[1]!.declared).toBe(false);
  });

  test('an active run is not closed before the gap', () => {
    const turns = continuous(20);
    expect(planDeepSegments(turns, [], T0 + 20_000 + 60_000)).toHaveLength(0);
  });

  test('short runs never become cards', () => {
    const turns = continuous(7);
    expect(planDeepSegments(turns, [], T0 + 7_000 + GAP + 1)).toHaveLength(0);
  });

  test('a task start splits the chat before it and only the declared run is skipped (#498)', () => {
    const turns = continuous(25);
    const segments = planDeepSegments(turns, [T0 + 24_500], T0 + 24_500 + GAP + 1, undefined, [T0 + 14_500]);
    expect(segments.map((segment) => segment.turns.length)).toEqual([15, 10]);
    expect(segments.map((segment) => segment.declared)).toEqual([false, true]);
  });

  test('a task end at the last turn millisecond is a boundary (#498)', () => {
    const turns = continuous(20);
    const segments = planDeepSegments(turns, [T0 + 19_000], T0 + 19_000 + GAP + 1);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.declared).toBe(true);
  });
});

describe('the DREAMING boundary compiles one card per closed undeclared segment (#474)', () => {
  test('captured turns become exactly one deep entry with every source ref and verbatim anchors', async () => {
    const dir = makeTempDir('cogmem-deep-card-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'deep-project';
    const agentId = 'deep-agent';
    const sessionId = 'deep-session';
    const backend = new KernelAgentMemoryBackend(kernel);
    const decision = '决定：由「小明」负责文档迁移，预算 12,500 元，日期 2026-11-19。';
    const eventIds: string[] = [];
    try {
      for (let index = 0; index < 24; index += 1) {
        const captured = await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: index === 0 ? decision : `第 ${index} 轮：继续整理文档，待办第 ${index} 项。`,
          occurredAt: T0 + index * 1_000,
        });
        eventIds.push(captured.eventId);
      }

      const night = await kernel.runDreamTick({ projectId, now: T0 + 24_000 + GAP + 1_000 });
      expect(night.deepCards?.created).toBe(1);

      const digest = kernel.sessionContext.digest({ projectId, agentId, sessionId });
      const cards = digest.entries.filter((entry) => entry.kind === 'deep');
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card.sourceRefs).toEqual(eventIds);
      expect(card.text).toContain('做了什么：');
      expect(card.text).toContain('遗留问题：');
      expect(card.text).toContain('指针：');
      expect(card.text).not.toContain('后有纠正');
      const claimLines = card.text.split('\n').filter((line) => !line.startsWith('指针：')).join('\n');
      const source = decision + '\n' + Array.from({ length: 24 }, (_, index) => `第 ${index} 轮：继续整理文档，待办第 ${index} 项。`).join('\n');
      for (const anchor of digestAnchors(claimLines)) expect(source.includes(anchor)).toBe(true);

      const again = await kernel.runDreamTick({ projectId, now: T0 + 24_000 + GAP + 2_000 });
      expect(again.deepCards?.created).toBe(0);
      expect(kernel.sessionContext.digest({ projectId, agentId, sessionId }).entries.filter((entry) => entry.kind === 'deep')).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  test('a declared task end is left to the task stub, not carded', async () => {
    const dir = makeTempDir('cogmem-deep-declared-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'declared-project';
    const agentId = 'declared-agent';
    const sessionId = 'declared-session';
    const backend = new KernelAgentMemoryBackend(kernel);
    try {
      for (let index = 0; index < 20; index += 1) {
        await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：声明内的工作。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      kernel.recordRawEvent({
        projectId,
        sessionId,
        threadId: sessionId,
        sourceId: `${agentId}:${sessionId}`,
        role: 'system',
        rawEventType: 'task_event',
        content: 'task completed: release/5.0',
        occurredAt: T0 + 20_000,
        metadata: { kind: 'task-procedure' },
      });
      const night = await kernel.runDreamTick({ projectId, now: T0 + 20_000 + GAP + 1_000 });
      expect(night.deepCards?.created).toBe(0);
      expect(kernel.sessionContext.digest({ projectId, agentId, sessionId }).entries.filter((entry) => entry.kind === 'deep')).toHaveLength(0);
    } finally {
      kernel.close();
    }
  });

  test('a next-day session of the same agent sees the card', async () => {
    const dir = makeTempDir('cogmem-deep-next-day-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'next-day-project';
    const agentId = 'next-day-agent';
    const sessionId = 'day-one:2026-11-23';
    const backend = new KernelAgentMemoryBackend(kernel);
    try {
      for (let index = 0; index < 12; index += 1) {
        await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：继续整理文档。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      const compiled = await kernel.sessionContext.compileEpisodeCards({
        projectId,
        agentId,
        sessionId,
        now: T0 + 12_000 + GAP + 1,
      });
      expect(compiled.created).toHaveLength(1);
      const nextDay = kernel.sessionContext.digest({ projectId, agentId, sessionId: 'day-two:2026-11-24' });
      expect(nextDay.entries.filter((entry) => entry.kind === 'deep')).toHaveLength(1);
    } finally {
      kernel.close();
    }
  });

  test('chat before a declared task is carded and the task run is not (#498)', async () => {
    const dir = makeTempDir('cogmem-deep-start-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'start-project';
    const agentId = 'start-agent';
    const sessionId = 'start-session';
    const backend = new KernelAgentMemoryBackend(kernel);
    const chatIds: string[] = [];
    try {
      for (let index = 0; index < 15; index += 1) {
        const captured = await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：闲聊。`,
          occurredAt: T0 + index * 1_000,
        });
        chatIds.push(captured.eventId);
      }
      kernel.recordToolCall({
        projectId,
        sessionId,
        threadId: sessionId,
        sourceId: `${agentId}:${sessionId}`,
        toolName: 'declare_task',
        input: { action: 'start' },
        occurredAt: T0 + 14_500,
      });
      for (let index = 15; index < 25; index += 1) {
        await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：声明内的工作。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      kernel.recordRawEvent({
        projectId,
        sessionId,
        threadId: sessionId,
        sourceId: `${agentId}:${sessionId}`,
        role: 'system',
        rawEventType: 'task_event',
        content: 'task completed: chat/cleanup',
        occurredAt: T0 + 24_500,
        metadata: { kind: 'task-procedure' },
      });
      const compiled = await kernel.sessionContext.compileEpisodeCards({
        projectId,
        agentId,
        sessionId,
        now: T0 + 24_500 + GAP + 1,
      });
      expect(compiled.created).toHaveLength(1);
      expect(compiled.created[0]!.sourceRefs).toEqual(chatIds);
      expect(compiled.declaredSkipped).toBe(1);
      const again = await kernel.sessionContext.compileEpisodeCards({
        projectId,
        agentId,
        sessionId,
        now: T0 + 24_500 + GAP + 2,
      });
      expect(again.created).toHaveLength(0);
    } finally {
      kernel.close();
    }
  });

  test('a task declared on one day and ended on the next is not carded on either side (#498)', async () => {
    const dir = makeTempDir('cogmem-deep-midnight-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'midnight-project';
    const agentId = 'midnight-agent';
    const dayOne = 'midnight:2026-11-23';
    const dayTwo = 'midnight:2026-11-24';
    const dayTwoStart = T0 + 3_600_000;
    const backend = new KernelAgentMemoryBackend(kernel);
    const chatIds: string[] = [];
    const afterIds: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const captured = await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId: dayOne,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：任务前的闲聊。`,
          occurredAt: T0 + index * 1_000,
        });
        chatIds.push(captured.eventId);
      }
      kernel.recordToolCall({
        projectId,
        sessionId: dayOne,
        threadId: dayOne,
        sourceId: `${agentId}:${dayOne}`,
        toolName: 'declare_task',
        input: { action: 'start' },
        occurredAt: T0 + 9_500,
      });
      for (let index = 10; index < 20; index += 1) {
        await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId: dayOne,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：跨午夜任务。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      for (let index = 20; index < 30; index += 1) {
        await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId: dayTwo,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：跨午夜任务。`,
          occurredAt: dayTwoStart + (index - 20) * 1_000,
        });
      }
      kernel.recordRawEvent({
        projectId,
        sessionId: dayTwo,
        threadId: dayTwo,
        sourceId: `${agentId}:${dayTwo}`,
        role: 'system',
        rawEventType: 'task_event',
        content: 'task completed: midnight/migration',
        occurredAt: dayTwoStart + 9_500,
        metadata: { kind: 'task-procedure' },
      });
      for (let index = 0; index < 10; index += 1) {
        const captured = await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId: dayTwo,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：任务后的闲聊。`,
          occurredAt: dayTwoStart + 20_000 + index * 1_000,
        });
        afterIds.push(captured.eventId);
      }
      const now = dayTwoStart + 30_000 + GAP + 1;
      const first = await kernel.sessionContext.compileEpisodeCards({ projectId, agentId, sessionId: dayOne, now });
      expect(first.created).toHaveLength(1);
      expect(first.created[0]!.sourceRefs).toEqual(chatIds);
      expect(first.declaredSkipped).toBe(1);
      const second = await kernel.sessionContext.compileEpisodeCards({ projectId, agentId, sessionId: dayTwo, now });
      expect(second.created).toHaveLength(1);
      expect(second.created[0]!.sourceRefs).toEqual(afterIds);
      expect(second.declaredSkipped).toBe(1);
    } finally {
      kernel.close();
    }
  });
});

describe('cards enter the lane, auto-expand, drill down, and leave on forget (#474)', () => {
  test('the next day names an anchor: the card is in working_set and mem: opens the ledger row', async () => {
    const dir = makeTempDir('cogmem-deep-expand-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'expand-project';
    const agentId = 'expand-agent';
    const sessionId = 'expand-session';
    const backend = new KernelAgentMemoryBackend(kernel);
    const decision = '决定：由「小明」负责文档迁移，预算 12,500 元，日期 2026-11-19。';
    let firstEventId = '';
    try {
      for (let index = 0; index < 24; index += 1) {
        const captured = await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: index === 0 ? decision : `第 ${index} 轮：继续整理文档，待办第 ${index} 项。`,
          occurredAt: T0 + index * 1_000,
        });
        if (index === 0) firstEventId = captured.eventId;
      }
      await kernel.runDreamTick({ projectId, now: T0 + 24_000 + GAP + 1_000 });

      const digest = kernel.sessionContext.digest({ projectId, agentId, sessionId });
      const card = digest.entries.find((entry) => entry.kind === 'deep')!;
      const assembly = backend.assembleSessionContext({
        projectId,
        agentId,
        sessionId,
        targetTokens: 200_000,
        recentText: ['昨天那份文档，小明负责的预算 12,500 元那件，怎么样了？'],
      });
      const working = assembly.lanes.find((lane) => lane.lane === 'working_set')!;
      expect(working.items.some((item) => item.id === card.entryId && item.autoExpanded === true)).toBe(true);
      expect(assembly.autoExpanded).toContain(card.entryId);
      expect(assembly.lanes.find((lane) => lane.lane === 'digest')!.text).toContain('情节卡（本段）');
      expect(card.text).toContain(`mem:${firstEventId}`);

      const row = kernel.factStore.getDatabase()
        .query('SELECT json_extract(payload_json, \'$.text\') AS text FROM memory_events WHERE event_id = ?')
        .get(firstEventId) as { text?: string } | null;
      expect(row?.text).toBe(decision);
    } finally {
      kernel.close();
    }
  });

  test('forgetting the covered window deletes the card and leaves no residue in any table', async () => {
    const dir = makeTempDir('cogmem-deep-forget-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'forget-project';
    const agentId = 'forget-agent';
    const sessionId = 'forget-session';
    const backend = new KernelAgentMemoryBackend(kernel);
    const marker = 'ZQXDEEPCARD7742';
    let card: SessionDigestEntry | undefined;
    try {
      for (let index = 0; index < 24; index += 1) {
        await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: index === 0 ? `决定：${marker} 由「小明」负责，预算 12,500 元。` : `第 ${index} 轮：${marker} 继续整理，待办第 ${index} 项。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      await kernel.runDreamTick({ projectId, now: T0 + 24_000 + GAP + 1_000 });
      const db = kernel.factStore.getDatabase();
      card = kernel.sessionContext.digest({ projectId, agentId, sessionId }).entries.find((entry) => entry.kind === 'deep');
      expect(card).toBeTruthy();
      expect(count(db, 'session_deep_cards')).toBe(1);

      kernel.sovereignty.deleteRange({ projectId, start: T0 - 1_000, end: T0 + 24_000 + 1_000 });
      expect(count(db, 'session_deep_cards')).toBe(0);
      expect(residue(db, [card!.entryId, marker])).toEqual([]);
    } finally {
      kernel.close();
    }
  });
});

describe('the model compiler keeps the anchor discipline (#474)', () => {
  const entries: SessionDigestEntry[] = Array.from({ length: 8 }, (_, index) => ({
    entryId: `digest:evt-${index}`,
    kind: 'turn',
    sessionId: 's',
    occurredAt: T0 + index,
    speaker: index % 2 === 0 ? 'owner' : 'agent',
    text: index === 0 ? '决定：由「小明」负责，预算 12,500 元。' : `第 ${index} 轮。`,
    sourceRefs: [`evt-${index}`],
    anchor: index === 0,
  }));

  test('a model answer that paraphrases an anchor falls back to the exact ledger text', async () => {
    const compiler = createSessionDeepCompiler(async () => JSON.stringify({ did: '「小明」负责，预算 13,000 元。', open: '无' }));
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    expect(card!.text).not.toContain('13,000');
    expect(card!.text).toContain('小明');
    expect(card!.text).toContain('12,500');
  });

  test('a model answer that copies the anchors is accepted', async () => {
    const compiler = createSessionDeepCompiler(async () =>
      JSON.stringify({ did: '「小明」负责迁移，预算 12,500 元。', open: '待办：下一次核对。' }));
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    expect(card!.text).toContain('「小明」负责迁移，预算 12,500 元。');
  });

  test('a card entry keeps every covered source ref', () => {
    const card = buildDeepCardEntry({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 }, '做了什么。', '无');
    expect(card.kind).toBe('deep');
    expect(card.sourceRefs).toEqual(entries.map((entry) => entry.sourceRefs[0]!));
  });
});

describe('a corrected episode card names the later correction (#499)', () => {
  test('a corrects_previous turn annotates the card it covers', async () => {
    const dir = makeTempDir('cogmem-deep-corrected-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'corrected-project';
    const agentId = 'corrected-agent';
    const sessionId = 'corrected-session';
    const backend = new KernelAgentMemoryBackend(kernel);
    let correctionId = '';
    try {
      for (let index = 0; index < 24; index += 1) {
        const text = index === 0
          ? '决定：由「小明」负责文档迁移，预算 12,500 元。'
          : index === 10 ? '不对，预算改成 9,000 元，负责人还是「小明」。'
            : `第 ${index} 轮：继续整理文档，待办第 ${index} 项。`;
        const captured = await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text,
          occurredAt: T0 + index * 1_000,
        });
        if (index === 10) correctionId = captured.eventId;
      }
      await kernel.runDreamTick({ projectId, now: T0 + 24_000 + GAP + 1_000 });

      const card = kernel.sessionContext.digest({ projectId, agentId, sessionId }).entries.find((entry) => entry.kind === 'deep')!;
      expect(card).toBeDefined();
      expect(card.sourceRefs).toContain(correctionId);
      expect(card.text).toContain(`后有纠正：mem:${correctionId}`);
      const lane = backend.assembleSessionContext({
        projectId, agentId, sessionId, targetTokens: 200_000, tailTurns: 4,
      }).lanes.find((item) => item.lane === 'digest')!;
      expect(lane.text).toContain(`后有纠正：mem:${correctionId}`);
    } finally {
      kernel.close();
    }
  });

  test('a PROFILE_ENTRY_CORRECTED row annotates the card built from its replaced evidence', async () => {
    const dir = makeTempDir('cogmem-deep-profile-corrected-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const projectId = 'profile-corrected-project';
    const agentId = 'profile-corrected-agent';
    const sessionId = 'profile-corrected-session';
    const backend = new KernelAgentMemoryBackend(kernel);
    let sourceId = '';
    try {
      for (let index = 0; index < 24; index += 1) {
        const captured = await backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: index === 0 ? '我喜欢喝乌龙茶。' : `第 ${index} 轮：继续整理文档。`,
          occurredAt: T0 + index * 1_000,
        });
        if (index === 0) sourceId = captured.eventId;
      }
      kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'likes',
        objectValue: { raw: '喝乌龙茶', type: 'string' },
        confidence: 0.9,
        sourceType: 'user_input',
        extractionReason: 'explicit_user_statement',
        sourceEventId: sourceId,
        validFrom: T0,
      }, T0);
      kernel.profile.compile({ projectId, ledger: 'preferences', now: T0 + 1 });
      const entry = kernel.profile.entries({ projectId, ledger: 'preferences' }).find((item) => item.value === '喝乌龙茶')!;
      expect(entry.sourceRefs[0]!.eventId).toBe(sourceId);
      await kernel.runDreamTick({ projectId, now: T0 + 24_000 + GAP + 1_000 });

      const correction = kernel.recordRawEvent({
        projectId,
        threadId: sessionId,
        role: 'user',
        content: '其实我不喝乌龙茶了，现在喜欢红茶。',
        occurredAt: T0 + 24_000 + GAP + 2_000,
      });
      kernel.profile.correct({
        projectId,
        ledger: 'preferences',
        key: entry.key,
        value: '喝红茶',
        correctionEventId: correction.eventId,
        now: T0 + 24_000 + GAP + 3_000,
      });

      const card = kernel.sessionContext.digest({ projectId, agentId, sessionId }).entries.find((item) => item.kind === 'deep')!;
      expect(card.sourceRefs).toContain(sourceId);
      expect(card.text).toContain(`后有纠正：mem:${correction.eventId}`);
    } finally {
      kernel.close();
    }
  });
});

describe('an episode card names its producer (#496)', () => {
  const entries: SessionDigestEntry[] = Array.from({ length: 8 }, (_, index) => ({
    entryId: `digest:evt-${index}`,
    kind: 'turn',
    sessionId: 's',
    occurredAt: T0 + index,
    speaker: index % 2 === 0 ? 'owner' : 'agent',
    text: index === 0 ? '决定：由「小明」负责，预算 12,500 元。' : `第 ${index} 轮。`,
    sourceRefs: [`evt-${index}`],
    anchor: index === 0,
  }));

  test('an accepted model card carries the model header and id prefix', async () => {
    const compiler = createSessionDeepCompiler(async () =>
      JSON.stringify({ did: '「小明」负责迁移，预算 12,500 元。', open: '待办：下一次核对。' }));
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    expect(card!.entryId).toBe('digest:card:model:evt-0');
    expect(card!.text.startsWith('情节卡（模型整理，未经核实）\n')).toBe(true);
  });

  test('the deterministic card keeps the rule header and id prefix', async () => {
    const compiler = createSessionDeepCompiler(async () =>
      JSON.stringify({ did: '「小明」负责，预算 13,000 元。', open: '无' }));
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    expect(card!.entryId).toBe('digest:card:rule:evt-0');
    expect(card!.text.startsWith('情节卡（本段）\n')).toBe(true);
  });

  test('the digest lane renders the model marker and drills to the first event', async () => {
    const compiler = createSessionDeepCompiler(async () =>
      JSON.stringify({ did: '「小明」负责迁移，预算 12,500 元。', open: '待办：下一次核对。' }));
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    const assembly = assembleSessionContext(
      { projectId: 'p', agentId: 'a', sessionId: 's', targetTokens: 200_000 },
      { sessionId: 's', entries: [card!], tail: [], truncated: false },
    );
    const lane = assembly.lanes.find((item) => item.lane === 'digest')!;
    expect(lane.text).toContain('情节卡（模型整理，未经核实）');
    expect(lane.text).toContain('anchorEvent=evt-0');
  });
});

describe('verbatim anchors are set members and truncation respects code points (#497)', () => {
  function entriesWith(text: string): SessionDigestEntry[] {
    return Array.from({ length: 8 }, (_, index) => ({
      entryId: `digest:evt-${index}`,
      kind: 'turn',
      sessionId: 's',
      occurredAt: T0 + index,
      speaker: index % 2 === 0 ? 'owner' : 'agent',
      text: index === 0 ? text : `第 ${index} 轮。`,
      sourceRefs: [`evt-${index}`],
      anchor: index === 0,
    }));
  }

  test('a number cut by truncation is not a verbatim anchor', async () => {
    const entries = entriesWith('决定：由「小明」负责，预算 1,500,000 元。');
    const compiler = createSessionDeepCompiler(async () =>
      JSON.stringify({ did: '「小明」负责，预算 1,5 元。', open: '无' }));
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    expect(card!.entryId).toBe('digest:card:rule:evt-0');
    expect(card!.text).not.toContain('预算 1,5 元');
  });

  test('a complete number, quoted span and name still pass', async () => {
    const entries = entriesWith('决定：叫小明负责，预算 12,500 元，引用「原文片段」。');
    const compiler = createSessionDeepCompiler(async () =>
      JSON.stringify({ did: '叫小明负责，预算 12,500 元，引用「原文片段」。', open: '无' }));
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    expect(card!.entryId).toBe('digest:card:model:evt-0');
    expect(card!.text).toContain('叫小明负责，预算 12,500 元，引用「原文片段」。');
  });

  test('deterministic truncation does not leave half a number', async () => {
    const entries = entriesWith(`${'x'.repeat(170)}预算 1,500,000 元`);
    const compiler = createSessionDeepCompiler(async () => {
      throw new Error('unreachable');
    });
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    const didLine = card!.text.split('\n').find((line) => line.startsWith('做了什么：'))!;
    expect(didLine).not.toContain('1,5');
  });

  test('truncation never splits a surrogate pair', async () => {
    const entries = entriesWith(`${'a'.repeat(179)}😀 tail`);
    const compiler = createSessionDeepCompiler(async () => {
      throw new Error('unreachable');
    });
    const [card] = await compiler.compile({ projectId: 'p', agentId: 'a', sessionId: 's', entries, now: T0 + 10_000 });
    expect(card!.text).toContain('😀');
    expect(card!.text).not.toContain('\uFFFD');
    expect(hasLoneSurrogate(card!.text)).toBe(false);
  });
});

function count(db: Database, table: string): number {
  return Number((db.query(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c?: number } | null)?.c ?? 0);
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function residue(db: Database, needles: readonly string[]): string[] {
  const tables = (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((row) => row.name);
  const hits: string[] = [];
  for (const table of tables) {
    let rows: unknown[];
    try {
      rows = db.query(`SELECT * FROM "${table}"`).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      const text = JSON.stringify(row);
      if (needles.some((needle) => text.includes(needle))) hits.push(table);
    }
  }
  return [...new Set(hits)];
}

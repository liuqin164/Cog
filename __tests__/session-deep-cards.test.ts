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

function count(db: Database, table: string): number {
  return Number((db.query(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c?: number } | null)?.c ?? 0);
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

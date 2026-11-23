import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type Database from 'bun:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { parseCommitmentDue } from '../src/commitment/index.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import {
  DEGRADATION_DAY_MS,
  DEGRADATION_HOUR_MS,
  generateDegradationCorpus,
  seedDegradationCorpus,
  type DegradationCorpus,
} from './fixtures/degradation-corpus.js';
import { makeTempDir } from './helpers/tmp.js';

const RECALL_P95_CAP_MS = 2_000;
const CHECKPOINT_BYTES_CAP = 64 * 1024 * 1024;

const dir = makeTempDir('cogmem-degradation-');
const dbPath = join(dir, 'memory.db');

let kernel: MemoryKernel;
let backend: KernelAgentMemoryBackend;
let corpus: DegradationCorpus;
let brevityCanonicalKey: string;
let teaCanonicalKey: string;
let promiseAt: number;

function p95(values: number[]): number {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function checkpointBytes(): number {
  const walPath = `${dbPath}-wal`;
  const wal = existsSync(walPath) ? statSync(walPath).size : 0;
  return statSync(dbPath).size + wal;
}

function rowsHolding(db: Database, needle: string): string[] {
  const hits: string[] = [];
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !/_(?:data|idx|content|docsize|config)$/u.test(name));
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    for (const column of columns) {
      const row = db.prepare(`SELECT COUNT(*) AS value FROM "${table}" WHERE instr(CAST("${column.name}" AS TEXT), ?) > 0`).get(needle) as { value: number };
      if (Number(row.value) > 0) hits.push(`${table}.${column.name}:${row.value}`);
    }
  }
  return hits;
}

describe('R05 long-horizon degradation acceleration', () => {
  beforeAll(() => {
    corpus = generateDegradationCorpus();
    kernel = createMemoryKernel({ dbPath, projectTimeZone: corpus.timeZone });
    backend = new KernelAgentMemoryBackend(kernel);
    seedDegradationCorpus(kernel, corpus);

    const stableEvent = corpus.eventsList[0]!;
    kernel.factStore.insertFacts([{
      neuronId: stableEvent.eventId,
      subject: 'owner',
      predicateFamily: 'lives_in',
      object: '东京都世田谷区三丁目十二号',
      validFrom: corpus.startAt,
      certaintyLevel: 'certain',
      confidence: 0.95,
      status: 'verified',
      sourceText: stableEvent.text,
    }]);
    teaCanonicalKey = kernel.beliefStore.upsert({
      projectId: corpus.projectId,
      scope: 'project',
      subject: 'owner',
      predicate: 'likes',
      objectValue: { raw: '乌龙茶', normalized: '乌龙茶', type: 'string' },
      confidence: 0.9,
      sourceType: 'user_input',
      extractionReason: 'preference_signal',
      sourceEventId: corpus.anchors.teaEventId,
      validFrom: corpus.eventsList[1]!.occurredAt,
    }).belief.canonicalKey;
    brevityCanonicalKey = kernel.beliefStore.upsert({
      projectId: corpus.projectId,
      scope: 'project',
      subject: 'owner',
      predicate: 'prefers',
      objectValue: { raw: '简短回答', normalized: '简短回答', type: 'string' },
      confidence: 0.9,
      sourceType: 'user_input',
      extractionReason: 'preference_signal',
      sourceEventId: corpus.anchors.brevityEventId,
      validFrom: corpus.eventsList[2]!.occurredAt,
    }).belief.canonicalKey;
    kernel.profile.compile({ projectId: corpus.projectId, now: corpus.startAt + 1_000 });

    kernel.factStore.insertFacts(corpus.eventsList.slice(5, 605).map((event, index) => ({
      neuronId: event.eventId,
      subject: 'owner',
      predicateFamily: 'recent_item',
      object: `noise-${index}`,
      validFrom: event.occurredAt,
      certaintyLevel: 'certain',
      confidence: 0.9,
      status: 'verified',
      sourceText: event.text,
    })));
    kernel.profile.compile({ projectId: corpus.projectId, now: corpus.endAt });

    promiseAt = corpus.endAt - DEGRADATION_HOUR_MS;
    kernel.recordRawEvent({
      projectId: corpus.projectId,
      threadId: 'promise-r05',
      role: 'user',
      content: `我明天把那份文件发你，单据号 ${corpus.anchors.newPromiseCode}。`,
      occurredAt: promiseAt,
    });
  }, 120_000);

  afterAll(() => {
    kernel.close();
  });

  test('a new promise at the end of 10k events is recognized and surfaces exactly once', () => {
    const compiled = kernel.commitments.compile({
      projectId: corpus.projectId,
      now: promiseAt + 1_000,
    });
    expect(compiled.opened).toBe(1);
    expect(compiled.entries).toBe(1);

    const entries = kernel.commitments.list({ projectId: corpus.projectId, now: promiseAt + 1_000 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.owner).toBe('user');
    expect(entries[0]!.content).toContain(corpus.anchors.newPromiseCode);
    expect(entries[0]!.dueAt).toBe(
      parseCommitmentDue(`我明天把那份文件发你，单据号 ${corpus.anchors.newPromiseCode}。`, promiseAt, corpus.timeZone).dueAt,
    );

    const due = entries[0]!.dueAt! + DEGRADATION_HOUR_MS;
    expect(kernel.commitments.surfaceDue({ projectId: corpus.projectId, now: due })).toHaveLength(1);
    expect(kernel.commitments.surfaceDue({ projectId: corpus.projectId, now: due + 1_000 })).toHaveLength(0);
  });

  test('a correction is immediate, supersedes only the corrected claim, and leaves no receipt flood', () => {
    const tea = kernel.profile.entries({ projectId: corpus.projectId, ledger: 'preferences' })
      .find((entry) => entry.value === '乌龙茶')!;
    const correction = kernel.recordRawEvent({
      projectId: corpus.projectId,
      threadId: 'correction-r05',
      role: 'user',
      content: '其实我改喝红茶了，偏好代号 PREF-TEA-471。',
      occurredAt: corpus.startAt + 45 * DEGRADATION_DAY_MS,
    });
    const corrected = kernel.profile.correct({
      projectId: corpus.projectId,
      ledger: 'preferences',
      key: tea.key,
      value: '喝红茶',
      correctionEventId: correction.eventId,
      now: correction.occurredAt + 1_000,
    });
    expect(corrected.value).toBe('喝红茶');

    const preferences = kernel.profile.entries({ projectId: corpus.projectId, ledger: 'preferences' });
    expect(preferences.map((entry) => entry.value)).not.toContain('乌龙茶');
    expect(preferences.some((entry) => entry.value === '喝红茶')).toBe(true);
    expect(preferences.some((entry) => entry.value === '简短回答' && entry.status === 'current')).toBe(true);
    expect(kernel.profile.history({ projectId: corpus.projectId, entryId: tea.entryId }).map((entry) => entry.status))
      .toEqual(['current', 'superseded']);

    expect(kernel.beliefStore.findByCanonicalKey(brevityCanonicalKey, corpus.projectId)
      .some((belief) => belief.status === 'active' && String(belief.objectValue.raw) === '简短回答')).toBe(true);
    expect(kernel.beliefStore.findByCanonicalKey(teaCanonicalKey, corpus.projectId)
      .some((belief) => belief.status === 'superseded' && String(belief.objectValue.raw) === '乌龙茶')).toBe(true);
    expect(kernel.profile.recall({ projectId: corpus.projectId, query: '简短', now: corpus.endAt })
      .some((entry) => entry.value === '简短回答')).toBe(true);

    const receipts = (): number => kernel.profile.audit({ projectId: corpus.projectId })
      .filter((entry) => entry.eventType === 'PROFILE_LEDGER_RECOMPILED').length;
    const before = receipts();
    for (let tick = 0; tick < 5; tick += 1) {
      kernel.profile.compile({ projectId: corpus.projectId, now: corpus.endAt + tick * 1_000 });
    }
    expect(receipts()).toBe(before);
  }, 120_000);

  test('the day-0 stable fact and the oldest raw event survive 90 days and 600 newer facts', () => {
    const stable = kernel.profile.entries({ projectId: corpus.projectId, ledger: 'facts' })
      .find((entry) => entry.value.includes('世田谷'));
    expect(stable).toBeDefined();
    expect(stable!.recordedAt).toBe(corpus.startAt);
    expect(corpus.endAt - stable!.recordedAt).toBeGreaterThanOrEqual(89 * DEGRADATION_DAY_MS);

    const oldest = kernel.eventStore.searchRawEvents(corpus.anchors.stableFactCode, {
      projectId: corpus.projectId,
      limit: 5,
      orderBy: 'relevance',
    });
    expect(oldest.some((event) => String((event.payload as { text?: string }).text ?? '').includes(corpus.anchors.stableFactCode))).toBe(true);
    const newest = kernel.eventStore.searchRawEvents(corpus.anchors.newPromiseCode, {
      projectId: corpus.projectId,
      limit: 5,
      orderBy: 'relevance',
    });
    expect(newest.some((event) => String((event.payload as { text?: string }).text ?? '').includes(corpus.anchors.newPromiseCode))).toBe(true);
    const cjk = kernel.eventStore.searchRawEvents('星屑', {
      projectId: corpus.projectId,
      limit: 5,
      orderBy: 'relevance',
    });
    expect(cjk.some((event) => String((event.payload as { text?: string }).text ?? '').includes(corpus.anchors.cjkCode))).toBe(true);
  });

  test('recall p95 and the persisted checkpoint stay under their calibrated caps', () => {
    const queries = [
      `单据号 ${corpus.anchors.newPromiseCode}`,
      '张伟 重构 模块',
      'item 42 refactor module',
      '移行 モジュール 77',
      '星屑 联络人',
      'D-9999 单据',
    ];
    backend.recall({ projectId: corpus.projectId, agentId: 'hermes', query: queries[0]!, limit: 8, now: corpus.endAt });
    const samples: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (const query of queries) {
        const started = performance.now();
        backend.recall({ projectId: corpus.projectId, agentId: 'hermes', query, limit: 8, now: corpus.endAt });
        samples.push(performance.now() - started);
      }
    }
    kernel.factStore.getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = checkpointBytes();
    const measured = p95(samples);
    console.log(`[R05] recall p95=${measured.toFixed(1)}ms cap=${RECALL_P95_CAP_MS}ms checkpoint=${(bytes / 1024 / 1024).toFixed(1)}MB cap=${CHECKPOINT_BYTES_CAP / 1024 / 1024}MB`);
    expect(measured).toBeLessThanOrEqual(RECALL_P95_CAP_MS);
    expect(bytes).toBeLessThanOrEqual(CHECKPOINT_BYTES_CAP);
  }, 120_000);

  test('/forget leaves zero rows, CJK terms, and secret bytes', () => {
    const result = kernel.sovereignty.deleteRange({
      projectId: corpus.projectId,
      start: 0,
      end: Date.now() + DEGRADATION_DAY_MS,
    });
    expect(result.deleted.events).toBeGreaterThanOrEqual(corpus.events);

    const db = kernel.factStore.getDatabase();
    expect(Number((db.prepare(`SELECT COUNT(*) AS value FROM memory_events WHERE event_id LIKE 'evt-r05-%'`).get() as { value: number }).value)).toBe(0);
    expect(rowsHolding(db, corpus.anchors.secret)).toEqual([]);
    expect(rowsHolding(db, corpus.anchors.cjkSecret)).toEqual([]);
    expect(Number((db.prepare(`SELECT COUNT(*) AS value FROM memory_events WHERE thread_id IN ('promise-r05', 'correction-r05')`).get() as { value: number }).value)).toBe(0);
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM memory_events_fts').get() as { value: number }).value)).toBe(0);
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM memory_event_cjk_terms').get() as { value: number }).value)).toBe(0);
    expect(Number((db.prepare(`SELECT COUNT(*) AS value FROM memory_events_fts WHERE memory_events_fts MATCH '岚雾'`).get() as { value: number }).value)).toBe(0);
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM facts').get() as { value: number }).value)).toBe(0);
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM beliefs').get() as { value: number }).value)).toBe(0);
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM memory_event_cjk_terms WHERE term IN (?, ?)').get('岚雾', '雾雨') as { value: number }).value)).toBe(0);

    for (const path of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      expect(bytes.includes(Buffer.from(corpus.anchors.secret))).toBe(false);
    }
  }, 120_000);
});

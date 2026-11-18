import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import {
  SESSION_DIGEST_MAX_TURNS,
  SessionContextService,
  type SessionContextAssembly,
} from '../src/session/index.js';
import { makeTempDir } from './helpers/tmp.js';

const TURNS = 10_000;
const PROJECT = 'p-rotation';
const AGENT = 'agent-rotation';
const SESSION = 's-rotation';
const SEED = '项目代号是青岚，决定在 2026-11-19 迁移。';
const BODY = '今天继续整理书架和旧照片，把上周的会议记录也归档了，顺便确认一下还有几份文档需要按日期重新排列。';
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

let kernel: MemoryKernel;
let backend: KernelAgentMemoryBackend;

beforeAll(() => {
  const dir = makeTempDir('cogmem-session-rotation-');
  kernel = createMemoryKernel({ dbPath: `${dir}/memory.db`, projectTimeZone: 'UTC' });
  backend = new KernelAgentMemoryBackend(kernel);
  const db = kernel.factStore.getDatabase();
  const insert = db.prepare(`
    INSERT INTO memory_events (
      event_id, global_seq, stream_id, stream_type, event_type, event_version, project_id,
      project_scope, source_id, thread_id, session_id, turn_id, role, occurred_at,
      payload_json, payload_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < TURNS; index += 1) {
      const eventId = `evt-${String(index).padStart(6, '0')}`;
      insert.run(
        eventId, index + 1, `stream-${index}`, 'conversation', 'RAW_EVENT_RECORDED', 1,
        PROJECT, PROJECT, `${AGENT}:${SESSION}`, SESSION, SESSION, `run-${index}:0`,
        index % 2 === 0 ? 'user' : 'assistant', T0 + index * 1000,
        JSON.stringify({
          text: index === 0 ? SEED : BODY,
          metadata: {
            captureLane: 'conversation',
            speaker: index % 2 === 0 ? 'owner' : 'agent',
            sourceAgent: AGENT,
          },
        }),
        `hash-${index}`, T0 + index * 1000,
      );
    }
  })();
});

afterAll(() => {
  kernel.close();
});

describe('the session digest rotates (#322)', () => {
  test('the session index exists and the turn read uses it, not event_type', () => {
    const db = kernel.factStore.getDatabase();
    const index = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_events_session_time'`).get() as { name?: string } | undefined;
    expect(index?.name).toBe('idx_memory_events_session_time');
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT event_id, occurred_at, global_seq
      FROM memory_events
      WHERE event_type = 'RAW_EVENT_RECORDED'
        AND project_id = ? AND session_id = ? AND source_id = ?
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.metadata.captureLane') = 'conversation'
      ORDER BY occurred_at DESC, COALESCE(global_seq, 0) DESC, event_id DESC
      LIMIT 513
    `).all(PROJECT, SESSION, `${AGENT}:${SESSION}`) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toContain('idx_memory_events_session_time');
    expect(details).not.toContain('idx_memory_events_type_time');
  });

  test('only the newest turns reach the digest; an older turn is still recallable by recall', () => {
    const digest = backend.sessionDigest({ projectId: PROJECT, agentId: AGENT, sessionId: SESSION });
    expect(digest.entries.length).toBe(SESSION_DIGEST_MAX_TURNS - 8);
    expect(digest.truncated).toBe(true);
    expect(digest.entries.some((entry) => entry.text === SEED)).toBe(false);
    expect(digest.tail.at(-1)!.text).toBe(BODY);
    const page = backend.recallSession({ projectId: PROJECT, agentId: AGENT, sessionId: SESSION, mode: 'keyword', query: '青岚', limit: 5 });
    expect(page.items.some((item) => item.text === SEED)).toBe(true);
  });

  test('a 10k-turn session assembles in p50 <= 30 ms and uses at least half the target', () => {
    const service = new SessionContextService(kernel.factStore.getDatabase());
    const times: number[] = [];
    let assembly: SessionContextAssembly | undefined;
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      assembly = service.assemble({
        projectId: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        targetTokens: 6_000,
        tailTurns: 8,
        pinned: ['你是 Cog，一个常驻的伙伴。'],
        profile: ['主人喜欢简洁。'],
        workingSet: ['整理书架'],
        recall: [{ id: 'evt-seed', text: SEED, anchorEvent: 'evt-000000' }],
      });
      times.push(performance.now() - started);
    }
    times.sort((left, right) => left - right);
    const p50 = times[Math.floor(times.length / 2)]!;
    expect(assembly!.usedTokens).toBeLessThanOrEqual(6_000);
    expect(assembly!.usedTokens / 6_000).toBeGreaterThanOrEqual(0.5);
    expect(assembly!.lanes.find((lane) => lane.lane === 'recall')!.status).toBe('included');
    expect(p50).toBeLessThanOrEqual(30);
  });
});

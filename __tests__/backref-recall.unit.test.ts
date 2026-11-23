import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { detectBackReference } from '../src/agent/BackReference.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);
const DAY = 86_400_000;
const PROJECT = 'backref-probe';
const AGENT = 'owner';

function setup() {
  const dir = makeTempDir('cogmem-backref-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'Asia/Tokyo' });
  const backend = new KernelAgentMemoryBackend(kernel);
  return { kernel, backend };
}

async function seedYesterday(backend: KernelAgentMemoryBackend): Promise<void> {
  await backend.rememberTurnWithResult({
    agentId: AGENT,
    projectId: PROJECT,
    sessionId: 'session-yesterday',
    turnId: 'yesterday:0',
    userText: '部署代号是 Orion，上线窗口周二凌晨两点。',
    assistantText: '记下了。',
    timestamp: NOW - DAY,
    ingestMode: 'immediate_compile',
  });
}

describe('deterministic back-reference detection (#472)', () => {
  test('only a reference with no content words of its own is a rewrite', () => {
    for (const query of ['刚才那个', '那个怎么样了', '上次聊的那个', '昨天聊的那个', '后来怎么样了', '它怎么样了']) {
      expect(detectBackReference(query), query).toMatchObject({ source: 'deterministic_backref' });
    }
    for (const query of ['上次说的那个部署方案', '上次部署时间改了吗', '这个项目呢', '那个耳机呢', '今天天气怎么样', '部署窗口是什么']) {
      expect(detectBackReference(query), query).toBeUndefined();
    }
  });

  test('a previous-day reference hits with context and misses without it', async () => {
    const empty = setup();
    try {
      const withoutContext = empty.backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '昨天聊的那个',
        excludeSessionId: 'session-today',
        limit: 3,
        now: NOW,
      });
      expect(withoutContext.items).toEqual([]);
    } finally {
      empty.kernel.close();
    }

    const seeded = setup();
    try {
      await seedYesterday(seeded.backend);
      const result = seeded.backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '昨天聊的那个',
        excludeSessionId: 'session-today',
        limit: 3,
        now: NOW,
      });
      expect(result.items.map((item) => item.text).join('\n')).toContain('Orion');
    } finally {
      seeded.kernel.close();
    }
  });

  test('a state follow-up anchors the current tail and orders newer evidence first', async () => {
    const { kernel, backend } = setup();
    try {
      for (let turn = 1; turn <= 10; turn += 1) {
        const userText = turn === 1
          ? '限流阈值定在每秒八百次。'
          : turn === 10 ? '刚才说的限流阈值方案。' : `普通对话第 ${turn} 轮。`;
        await backend.rememberTurnWithResult({
          agentId: AGENT,
          projectId: PROJECT,
          sessionId: 'session-today',
          turnId: `today:${turn}`,
          userText,
          assistantText: turn === 1 ? '记下了。' : turn === 10 ? '就是那个限流阈值方案。' : '好。',
          timestamp: NOW - (10 - turn) * 60_000,
          ingestMode: 'immediate_compile',
        });
      }
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '刚才那个怎么样了',
        excludeSessionId: 'session-today',
        excludeSessionTailTurns: 2,
        limit: 3,
        now: NOW,
      });
      expect(result.items[0]?.text).toContain('限流阈值');
      const times = result.items.map((item) => item.sourceAnchor?.occurredAt ?? 0);
      expect(times).toEqual([...times].sort((left, right) => right - left));

      const row = kernel.factStore.getDatabase()
        .query('SELECT payload FROM trace_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1')
        .get('recall.result') as { payload: string } | null;
      const payload = JSON.parse(row!.payload) as { rewrite?: { source?: string; terms?: string[] } };
      expect(payload.rewrite?.source).toBe('deterministic_backref');
      expect(payload.rewrite?.terms?.join(' ')).toContain('限流阈值');
    } finally {
      kernel.close();
    }
  });

  test('a rewrite with no hit returns the recent-items menu instead of an empty answer', async () => {
    const { kernel, backend } = setup();
    try {
      await backend.rememberTurnWithResult({
        agentId: AGENT,
        projectId: PROJECT,
        sessionId: 'session-today',
        turnId: 'menu:0',
        userText: '普通对话。',
        assistantText: '好。',
        timestamp: NOW,
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '刚才那个怎么样了',
        excludeSessionId: 'session-today',
        excludeSessionTailTurns: 1,
        limit: 3,
        now: NOW,
      });
      expect(result.items[0]?.source).toBe('recall_menu');
      expect(result.items[0]?.text).toContain('<recent-items>');
      expect(result.items[0]?.text).toMatch(/mem:evt-/);
    } finally {
      kernel.close();
    }
  });

  test('a normal query is unchanged by the rewrite path', async () => {
    const { kernel, backend } = setup();
    try {
      await seedYesterday(backend);
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '部署窗口是什么',
        excludeSessionId: 'session-today',
        limit: 3,
        now: NOW,
      });
      expect(result.items[0]?.text).toContain('Orion');
      const row = kernel.factStore.getDatabase()
        .query('SELECT payload FROM trace_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1')
        .get('recall.result') as { payload: string } | null;
      expect(JSON.parse(row!.payload)).not.toHaveProperty('rewrite');
    } finally {
      kernel.close();
    }
  });
});

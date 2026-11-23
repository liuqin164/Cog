import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import type { AgentRecallResult } from '../src/agent/AgentMemoryTypes.js';
import { detectBackReference } from '../src/agent/BackReference.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
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

function seedAtlasAnchor(kernel: MemoryKernel, id: string, label: string): void {
  const event = kernel.appendEpisodeMessage({
    projectId: PROJECT,
    sessionId: 'atlas-seed',
    sourceAgent: AGENT,
    role: 'user',
    text: label,
    timestamp: NOW - DAY,
  });
  kernel.memoryAtlasStore.upsertDocument({
    id,
    projectId: PROJECT,
    nodeType: 'episode',
    sourceId: id,
    label,
    summary: label,
    confidence: 0.9,
    supportCount: 1,
    status: 'active',
    evidenceEventIds: [event.eventId],
  });
  kernel.memoryAtlasStore.markProjectionClean(PROJECT);
}

function rewriteKeywords(result: AgentRecallResult): string[] {
  return result.queryPlan?.keywords ?? [];
}

describe('deterministic back-reference detection (#472)', () => {
  test('only a reference with no content words of its own is a rewrite', () => {
    for (const query of [
      '刚才那个', '那个怎么样了', '上次聊的那个', '昨天聊的那个', '后来怎么样了', '它怎么样了',
      '上次说的那件事呢', '那件事呢', '这事呢',
    ]) {
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
      const payload = JSON.parse(row!.payload) as { rewrite?: { source?: string; termCount?: number } };
      expect(payload.rewrite?.source).toBe('deterministic_backref');
      expect(payload.rewrite?.termCount).toBeGreaterThan(0);
      expect(JSON.stringify(payload)).not.toContain('限流阈值');
    } finally {
      kernel.close();
    }
  });

  test('上次 plus 后来 anchors the previous session and starts after the anchor', async () => {
    const { kernel, backend } = setup();
    try {
      const before = NOW - DAY - 60_000;
      for (const [turn, userText, at] of [
        ['before', 'Orion 计划最初只是草案。', before],
        ['first', '迁移项目 Orion 的方案先放在周三。', NOW - DAY],
        ['later', 'Orion 迁移方案改到周四了。', NOW - DAY + 60_000],
        ['after', 'Orion 迁移已经完成。', NOW - DAY + 120_000],
      ] as const) {
        await backend.rememberTurnWithResult({
          agentId: AGENT,
          projectId: PROJECT,
          sessionId: 'session-previous',
          turnId: `previous:${turn}`,
          userText,
          assistantText: '好。',
          timestamp: at,
        });
      }
      await backend.rememberTurnWithResult({
        agentId: AGENT,
        projectId: PROJECT,
        sessionId: 'session-now',
        turnId: 'now:0',
        userText: '普通对话。',
        assistantText: '好。',
        timestamp: NOW,
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '上次那个事后来怎么样了',
        sessionId: 'session-now',
        limit: 5,
        now: NOW,
      });
      const text = result.items.map((item) => item.text).join('\n');
      expect(text).toContain('Orion 迁移已经完成');
      expect(text).not.toContain('Orion 计划最初只是草案');
      expect(text).not.toContain('方案先放在周三');
    } finally {
      kernel.close();
    }
  });

  test('00:05 的刚才 still reaches the previous day 23:58', async () => {
    const { kernel, backend } = setup();
    try {
      await backend.rememberTurnWithResult({
        agentId: AGENT,
        projectId: PROJECT,
        sessionId: 'session-late',
        turnId: 'late:0',
        userText: '发布代号是北极星，窗口今晚。',
        assistantText: '记下了。',
        timestamp: Date.parse('2026-11-23T23:58:00+09:00'),
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '刚才那个',
        sessionId: 'session-late',
        limit: 3,
        now: Date.parse('2026-11-24T00:05:00+09:00'),
      });
      expect(result.items.map((item) => item.text).join('\n')).toContain('北极星');
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

  test('the recent-items menu omits an episode the occasion gate withholds', async () => {
    const { kernel, backend } = setup();
    try {
      await backend.rememberTurnWithResult({
        agentId: AGENT,
        projectId: PROJECT,
        sessionId: 'session-today',
        turnId: 'menu:clean',
        userText: '普通对话关于天气。',
        assistantText: '好。',
        timestamp: NOW,
      });
      await backend.rememberTurnWithResult({
        agentId: AGENT,
        projectId: PROJECT,
        sessionId: 'session-today',
        turnId: 'menu:third-party',
        userText: '邻居说他们家要搬去大阪。',
        assistantText: '嗯。',
        metadata: { speaker: 'other' },
        timestamp: NOW + 1000,
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '刚才那个怎么样了',
        excludeSessionId: 'session-today',
        excludeSessionTailTurns: 2,
        limit: 3,
        now: NOW,
      });
      expect(result.items[0]?.source).toBe('recall_menu');
      expect(result.items[0]?.text).toContain('天气');
      expect(result.items[0]?.text).not.toContain('邻居');
    } finally {
      kernel.close();
    }
  });

  test('a recall whose only hit the occasion gate withheld returns no menu', async () => {
    const { kernel, backend } = setup();
    try {
      await backend.rememberTurnWithResult({
        agentId: AGENT,
        projectId: PROJECT,
        sessionId: 'session-yesterday',
        turnId: 'withheld:0',
        userText: '邻居说他们家要搬去大阪。',
        assistantText: '嗯。',
        metadata: { speaker: 'other' },
        timestamp: NOW - DAY,
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '昨天聊的那个',
        excludeSessionId: 'session-today',
        limit: 3,
        now: NOW,
      });
      expect(result.items).toEqual([]);
      expect(result.decisionTrace?.suppressed).toContainEqual({ reason: 'occasion_third_party', count: 1 });
    } finally {
      kernel.close();
    }
  });

  test('a secret-marked anchor event is not tokenized into the trace', async () => {
    const { kernel, backend } = setup();
    try {
      kernel.eventStore.append({
        streamType: 'thread',
        streamId: 'session-secret',
        eventType: 'RAW_EVENT_RECORDED',
        projectId: PROJECT,
        threadId: 'session-secret',
        sessionId: 'session-secret',
        threadSeq: 1,
        eventOrdinal: 1,
        role: 'user',
        sourceId: `${AGENT}:session-secret`,
        occurredAt: NOW - DAY,
        payload: {
          text: '部署口令是 zephyr-nine，别外传。',
          metadata: { sourceAgent: AGENT, secretFindings: { total: 1, byKind: { github_token: 1 } } },
        },
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '昨天聊的那个',
        excludeSessionId: 'session-today',
        limit: 3,
        now: NOW,
      });
      expect(JSON.stringify(result.items)).not.toContain('zephyr');
      const row = kernel.factStore.getDatabase()
        .query('SELECT payload FROM trace_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1')
        .get('recall.result') as { payload: string } | null;
      const payload = JSON.parse(row!.payload) as { rewrite?: { termCount?: number } };
      expect(payload.rewrite?.termCount).toBe(0);
      expect(row!.payload).not.toContain('zephyr');
    } finally {
      kernel.close();
    }
  });

  test('a life-sensitive anchor event is not tokenized into the trace', async () => {
    const { kernel, backend } = setup();
    try {
      kernel.eventStore.append({
        streamType: 'thread',
        streamId: 'session-life',
        eventType: 'RAW_EVENT_RECORDED',
        projectId: PROJECT,
        threadId: 'session-life',
        sessionId: 'session-life',
        threadSeq: 1,
        eventOrdinal: 1,
        role: 'user',
        sourceId: `${AGENT}:session-life`,
        occurredAt: NOW - DAY,
        payload: {
          text: '我的工资是保密数字，别记录。',
          metadata: {
            sourceAgent: AGENT,
            lifeSensitivityFindings: {
              total: 1,
              byCategory: { finance: 1 },
              byTier: { private: 1 },
              byKind: { finance_personal: 1 },
            },
          },
        },
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '昨天聊的那个',
        excludeSessionId: 'session-today',
        limit: 3,
        now: NOW,
      });
      expect(JSON.stringify(result.items)).not.toContain('工资');
      const row = kernel.factStore.getDatabase()
        .query('SELECT payload FROM trace_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1')
        .get('recall.result') as { payload: string } | null;
      const payload = JSON.parse(row!.payload) as { rewrite?: { termCount?: number } };
      expect(payload.rewrite?.termCount).toBe(0);
      expect(row!.payload).not.toContain('工资');
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

describe('back-reference anchor state (#490)', () => {
  test('one session anchor does not leak into another session', () => {
    const { kernel, backend } = setup();
    try {
      seedAtlasAnchor(kernel, 'episode:anchor-a', '海象协议上线窗口');
      backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '海象协议上线窗口',
        excludeSessionId: 'session-a',
        recordBackReferenceAnchor: true,
        limit: 3,
        now: NOW,
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '它怎么样了',
        excludeSessionId: 'session-b',
        limit: 3,
        now: NOW,
      });
      expect(rewriteKeywords(result)).not.toContain('anchor-a');
    } finally {
      kernel.close();
    }
  });

  test('tool searches and background recalls leave the automatic-lane anchor alone', () => {
    const { kernel, backend } = setup();
    try {
      seedAtlasAnchor(kernel, 'episode:anchor-a', '海象协议上线窗口');
      seedAtlasAnchor(kernel, 'episode:anchor-b', '鲸鱼协议上线窗口');
      backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '海象协议上线窗口',
        excludeSessionId: 'session-a',
        recordBackReferenceAnchor: true,
        limit: 3,
        now: NOW,
      });
      backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '鲸鱼协议上线窗口',
        excludeSessionId: 'session-a',
        limit: 3,
        now: NOW,
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '它怎么样了',
        excludeSessionId: 'session-a',
        limit: 3,
        now: NOW,
      });
      const terms = rewriteKeywords(result);
      expect(terms).toContain('anchor-a');
      expect(terms).not.toContain('anchor-b');
    } finally {
      kernel.close();
    }
  });

  test('an empty automatic recall keeps the previous anchor', () => {
    const { kernel, backend } = setup();
    try {
      seedAtlasAnchor(kernel, 'episode:anchor-a', '海象协议上线窗口');
      backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '海象协议上线窗口',
        excludeSessionId: 'session-a',
        recordBackReferenceAnchor: true,
        limit: 3,
        now: NOW,
      });
      backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '完全不存在的主题词',
        excludeSessionId: 'session-a',
        recordBackReferenceAnchor: true,
        limit: 3,
        now: NOW,
      });
      const result = backend.recall({
        agentId: AGENT,
        projectId: PROJECT,
        query: '它怎么样了',
        excludeSessionId: 'session-a',
        limit: 3,
        now: NOW,
      });
      expect(rewriteKeywords(result)).toContain('anchor-a');
    } finally {
      kernel.close();
    }
  });
});

describe('approval short replies are not back-references (#516)', () => {
  test('approval phrases do not rewrite, while question and state phrases still do', () => {
    for (const query of ['就这个', '这个吧', '它挺好']) {
      expect(detectBackReference(query), query).toBeUndefined();
    }
    for (const query of ['它怎么样了', '这个呢', '那个怎么样了']) {
      expect(detectBackReference(query), query).toMatchObject({ source: 'deterministic_backref' });
    }
  });

  test('approval phrases neither rewrite nor open the fallback menu', async () => {
    const { kernel, backend } = setup();
    try {
      await seedYesterday(backend);
      for (const query of ['就这个', '这个吧', '它挺好']) {
        const result = backend.recall({
          agentId: AGENT,
          projectId: PROJECT,
          query,
          excludeSessionId: 'session-today',
          excludeSessionTailTurns: 1,
          limit: 3,
          now: NOW,
        });
        expect(result.items.some((item) => item.source === 'recall_menu'), query).toBe(false);
        const row = kernel.factStore.getDatabase()
          .query('SELECT payload FROM trace_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1')
          .get('recall.result') as { payload: string } | null;
        expect(JSON.parse(row!.payload), query).not.toHaveProperty('rewrite');
      }
    } finally {
      kernel.close();
    }
  });
});

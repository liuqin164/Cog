import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const DEPLOY = '部署窗口是周二凌晨两点。';
const CAT = '我家的猫叫年糕。';

async function seeded(): Promise<{ backend: KernelAgentMemoryBackend; projectId: string; close: () => void }> {
  const dir = makeTempDir('cogmem-recall-floor-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
  const backend = new KernelAgentMemoryBackend(kernel, { agentId: 'owner' });
  const projectId = 'floor-probe';
  const facts: Array<[string, string]> = [
    ['old-deploy', DEPLOY],
    ['old-cat', CAT],
    ['old-approval', '客户数据导出必须经过安全审批，审批人是林晓。'],
  ];
  for (const [sessionId, userText] of facts) {
    await backend.rememberTurnWithResult({
      agentId: 'owner',
      projectId,
      sessionId,
      threadId: sessionId,
      userText,
      assistantText: '记下了。',
      timestamp: NOW,
    });
  }
  return { backend, projectId, close: () => kernel.close() };
}

describe('the general relevance floor (#321)', () => {
  test('unrelated questions do not dredge up old facts', async () => {
    const { backend, projectId, close } = await seeded();
    try {
      for (const query of ['明天午饭吃什么好', '今天心情不错', '帮我把这段文字改得更简洁']) {
        const result = backend.recall({ agentId: 'owner', projectId, query, limit: 3, now: NOW });
        expect(result.items, query).toEqual([]);
        expect(result.decisionTrace?.zeroExplanation, query).toBeDefined();
      }
    } finally {
      close();
    }
  });

  test('a weak but real match survives; a fact with no content cue in common does not', async () => {
    const { backend, projectId, close } = await seeded();
    try {
      // The approval fact shares three content characters; the deployment and cat facts share
      // none. A weak match is still a match at the floor.
      const result = backend.recall({
        agentId: 'owner',
        projectId,
        query: '谁签字放行数据导出？',
        limit: 3,
        now: NOW,
      });
      const text = result.items.map((item) => item.text).join('\n');
      expect(text).toContain('客户数据');
      expect(text).not.toContain('部署窗口');
    } finally {
      close();
    }
  });

  test('excludeSessionId drops the current session while keeping older memory', async () => {
    const { backend, projectId, close } = await seeded();
    try {
      const current = '仅本会话知道的口令是蓝鸟。';
      await backend.rememberTurnWithResult({
        agentId: 'owner',
        projectId,
        sessionId: 'current-session',
        threadId: 'current-session',
        userText: current,
        assistantText: '记下了。',
        timestamp: NOW + 1_000,
      });
      const result = backend.recall({
        agentId: 'owner',
        projectId,
        query: current,
        limit: 5,
        now: NOW + 2_000,
        excludeSessionId: 'current-session',
      });
      expect(result.items.map((item) => item.text).join('\n')).not.toContain('蓝鸟');
    } finally {
      close();
    }
  });
});

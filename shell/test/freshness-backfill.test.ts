import { describe, expect, test } from 'bun:test';

import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const FRESHNESS = { intervalMs: 0, embeddingBatch: 16, bindingBatch: 50 };
const VECTOR = new Float32Array([1, 0]);

function embedder(embedBatch?: (texts: string[]) => Promise<Float32Array[]>) {
  return {
    dimensions: VECTOR.length,
    modelId: 'test-embedding',
    embedBatch: embedBatch ?? (async (texts: string[]) => texts.map(() => VECTOR)),
    embed: async () => VECTOR,
    embedSync: () => VECTOR,
  };
}

async function seedBacklog(shell: CompanionShell, at: number) {
  const projectId = shell.config.projectId;
  const raw = (input: { threadId: string; role: 'user' | 'assistant'; content: string; rawEventType?: 'tool_call' }) =>
    shell.kernel.recordRawEvent({ projectId, sessionId: 'seed', sourceId: 'test', occurredAt: at, ...input });
  const lowSignal = await shell.backend.rememberTurnWithResult({
    agentId: shell.config.agentId,
    projectId,
    sessionId: 'seed',
    userText: '嗯。',
    assistantText: '在。',
    timestamp: at,
    ingestMode: 'selective_compile',
  });
  expect(lowSignal.compiled).toBe(false);
  raw({ threadId: 'tool', role: 'assistant', rawEventType: 'tool_call', content: '{"tool":"read"}' });
  raw({ threadId: 'assistant', role: 'assistant', content: '还没被编译的回复。' });
  raw({ threadId: 'bind', role: 'user', content: 'MoneyPrinterTurbo 项目的部署策略需要离线优先，并且按照发布事件做时间线分类。' });
  raw({ threadId: 'bind', role: 'user', content: 'Cogmem memory write pipeline 需要写入时回看旧记忆，并绑定到同一个分类路径。' });
}

describe('resident freshness backfill (#388)', () => {
  test('one tick embeds and binds the backlog and publishes the readings', async () => {
    const shell = makeShell(makeTempDir('freshness-tick-'), undefined, { freshness: FRESHNESS }, { embeddingProvider: embedder() });
    await shell.start();
    try {
      const projectId = shell.config.projectId;
      const at = shell.now() - 10 * 60_000;
      await seedBacklog(shell, at);
      expect(shell.residentTick.freshness).toBeUndefined();
      expect(shell.kernel.getEmbeddingBacklog(projectId)).toEqual({ count: 6, oldestAt: at });
      expect(shell.kernel.countUnboundBindableRawEvents(projectId)).toBe(2);

      await shell.tick(shell.now());

      expect(shell.residentTick.freshness).toMatchObject({
        unembeddedEvents: 0,
        oldestUnembeddedAgeMs: 0,
        unboundEvents: 0,
      });
      expect(shell.kernel.eventEmbeddingStore.getProgress(projectId)).toMatchObject({ total: 6, completed: 6 });
      expect(shell.kernel.listMemoryBindings({ projectId }).length).toBeGreaterThanOrEqual(2);
      expect(shell.trace.read().some((record) => record.kind === 'freshness_backfill')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('health and a turn answer while the backfill is waiting on the embedder', async () => {
    let release!: () => void;
    let released = false;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        released = true;
        resolve();
      };
    });
    const shell = makeShell(
      makeTempDir('freshness-yield-'),
      new ScriptedProvider([{ text: '在。', toolCalls: [] }]),
      {
        http: { enabled: true, port: 0, hostname: '127.0.0.1' },
        freshness: FRESHNESS,
      },
      {
        embeddingProvider: embedder(async (texts) => {
          calls += 1;
          await gate;
          return texts.map(() => VECTOR);
        }),
      },
    );
    await shell.start();
    try {
      expect(shell.httpUrl).toBeDefined();
      await seedBacklog(shell, shell.now());
      const tick = shell.tick(shell.now());
      await waitUntil(() => calls > 0);

      const healthStarted = performance.now();
      const response = await fetch(`${shell.httpUrl}/health`);
      const healthMs = performance.now() - healthStarted;
      expect(response.status).toBe(200);
      expect(healthMs).toBeLessThan(500);

      const turnStarted = performance.now();
      await shell.submit('在吗？');
      const turnMs = performance.now() - turnStarted;
      expect(released).toBe(false);
      expect(turnMs).toBeLessThan(5_000);

      release();
      await tick;
      const after = await (await fetch(`${shell.httpUrl}/health`)).json() as { freshness?: { unboundEvents?: number } | null };
      expect(after.freshness?.unboundEvents).toBe(0);
    } finally {
      release();
      await shell.stop();
    }
  });

  test('a failed turn embedding lands in the same backlog and is retried by the tick', async () => {
    let down = true;
    const shell = makeShell(
      makeTempDir('freshness-queue-failure-'),
      undefined,
      { freshness: FRESHNESS },
      {
        embeddingProvider: embedder(async (texts) => {
          if (down) throw new Error('embedding_down');
          return texts.map(() => VECTOR);
        }),
      },
    );
    await shell.start();
    try {
      const projectId = shell.config.projectId;
      const result = await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId,
        sessionId: shell.config.sessionId,
        userText: 'Cogmem memory write pipeline 需要写入时回看旧记忆，并绑定到同一个分类路径。',
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      expect(result.compiled).toBe(true);
      await waitUntil(() => shell.kernel.pipelineMetrics.getNonFatalCount('event_embedding_failed', { projectId }) > 0);
      expect(shell.kernel.getEmbeddingBacklog(projectId).count).toBe(2);

      down = false;
      await shell.tick(shell.now());
      expect(shell.residentTick.freshness).toMatchObject({ unembeddedEvents: 0, oldestUnembeddedAgeMs: 0 });
    } finally {
      await shell.stop();
    }
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { RouteStore } from '../src/model/routes.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const DREAM_ALL_DAY = { runKernelNight: true, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 24 };
/** Seed the episode two hours before the Night so the boundary sees the idle gap and seals it. */
const BASE = new Date('2026-01-01T12:00:00Z').getTime();
const NIGHT = BASE + 2 * 60 * 60_000;

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** An OpenAI-compatible memory model that answers the candidate prompt with one user preference. */
function startModelServer(usage = { prompt_tokens: 100, completion_tokens: 50 }): { url: string; calls: () => number } {
  let calls = 0;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls += 1;
      const body = await request.json() as { messages: Array<{ role: string; content: string }> };
      const userPrompt = JSON.parse(body.messages.find((message) => message.role === 'user')!.content) as {
        rawLedgerEvents?: Array<{ eventId: string; role?: string }>;
        events?: Array<{ eventId: string; role?: string }>;
      };
      const events = userPrompt.rawLedgerEvents ?? userPrompt.events ?? [];
      const userIds = events.filter((event) => event.role === 'user').map((event) => event.eventId);
      const content = JSON.stringify({
        userPreferenceCandidates: [{
          statement: '用户要求不要碰事实同伴库。',
          confidence: 0.9,
          evidenceEventIds: userIds,
        }],
      });
      return Response.json({ choices: [{ message: { content } }], usage });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls: () => calls };
}

describe('Dream route A in the shell', () => {
  test('the memory role follows the active custom route and calls its provider', async () => {
    const model = startModelServer();
    const dir = makeTempDir();
    const store = new RouteStore(join(dir, 'data', 'routes.json')).load();
    store.add({ name: 'owner-model', baseUrl: model.url, apiKey: 'test-key', model: 'test-model' });
    store.setActive('owner-model');
    const shell = makeShell(dir, undefined, {
      dream: DREAM_ALL_DAY,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await shell.start();
    try {
      const clock = shell.host.getService<{ dreamTargetDate(at?: number): string }>('clock');
      const dayThread = `companion-day:${clock.dreamTargetDate(NIGHT)}`;
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        threadId: dayThread,
        turnId: 'custom-route-seed',
        userText: '请以后始终记住：不要碰事实同伴库。',
        assistantText: '记下了。',
        timestamp: BASE,
        ingestMode: 'raw_then_dream',
      });

      const health = await (await fetch(`${shell.httpUrl}/health`)).json() as {
        memoryModel: { route: string; baseUrl: string; state: string };
      };
      expect(health.memoryModel.route).toBe('owner-model');
      expect(health.memoryModel.baseUrl).toBe(new URL(model.url).toString());
      expect(health.memoryModel.state).toBe('reachable');

      await shell.runDream(NIGHT);
      expect(model.calls()).toBeGreaterThan(0);
      expect(shell.trace.read().some((record) => record.kind === 'dream_model_usage')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('an unreachable memory model is visible, traced, and counts as a failed night', async () => {
    const dir = makeTempDir();
    const store = new RouteStore(join(dir, 'data', 'routes.json')).load();
    store.add({ name: 'dead-model', baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', model: 'test-model' });
    store.setActive('dead-model');
    const shell = makeShell(dir, undefined, {
      dream: DREAM_ALL_DAY,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await shell.start();
    try {
      const clock = shell.host.getService<{ dreamTargetDate(at?: number): string }>('clock');
      for (let day = 0; day < 3; day += 1) {
        const at = BASE + day * 24 * 60 * 60_000;
        await shell.backend.rememberTurnWithResult({
          agentId: shell.config.agentId,
          projectId: shell.config.projectId,
          sessionId: shell.config.sessionId,
          threadId: `companion-day:${clock.dreamTargetDate(at + 2 * 60 * 60_000)}`,
          turnId: `dead-model-seed-${day}`,
          userText: `第 ${day + 1} 天：请以后始终记住不要碰事实同伴库。`,
          assistantText: '记下了。',
          timestamp: at,
          ingestMode: 'raw_then_dream',
        });
        await shell.runDream(at + 2 * 60 * 60_000);
      }

      const trace = shell.trace.read();
      expect(trace.some((record) => record.kind === 'memory_model_unavailable')).toBe(true);
      expect(shell.currentStatus().memoryModel).toMatchObject({
        route: 'dead-model',
        state: 'unreachable',
      });
      expect(shell.currentStatus().memoryModel?.line).toContain('夜间整合不会用模型');

      const health = await (await fetch(`${shell.httpUrl}/health`)).json() as {
        memoryModel: { state: string; line: string };
      };
      expect(health.memoryModel.state).toBe('unreachable');
      expect(health.memoryModel.line).toContain('夜间整合不会用模型');

      const streak = shell.kernel.health.check({ record: false }).checks.find((check) => check.id === 'dream_streak');
      expect(streak?.status).toBe('degraded');
      expect((streak?.detail as { streak: number }).streak).toBe(3);
      const runs = shell.kernel.factStore.getDatabase()
        .prepare(`SELECT status FROM episode_dream_runs`)
        .all() as Array<{ status: string }>;
      expect(runs).toHaveLength(3);
      expect(runs.every((run) => run.status === 'partial')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('the memory model proposes a review candidate with llm_inference provenance', async () => {
    const model = startModelServer();
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), {
      dream: DREAM_ALL_DAY,
      model: { baseUrl: model.url, apiKey: 'test-key', model: 'test-model', timeoutMs: 5_000 },
    });
    await shell.start();
    try {
      const clock = shell.host.getService<{ dreamTargetDate(at?: number): string }>('clock');
      const date = clock.dreamTargetDate(NIGHT);
      const dayThread = `companion-day:${date}`;
      const seed = await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        threadId: dayThread,
        turnId: 'route-a-seed',
        userText: '请以后始终记住：不要碰事实同伴库。',
        assistantText: '记下了。',
        timestamp: BASE,
        ingestMode: 'raw_then_dream',
      });

      await shell.runDream(NIGHT);
      expect(model.calls()).toBeGreaterThan(0);

      const candidates = shell.kernel.listDreamCandidates({
        projectId: shell.config.projectId,
        candidateTypes: ['user_preference'],
        limit: 20,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.status).toBe('needs_confirmation');
      expect(candidates[0]!.statusReason).toBe('llm_inference_requires_user_review');
      expect((candidates[0]!.content as Record<string, unknown>).sourceType).toBe('llm_inference');
      const evidence = candidates[0]!.evidence as Array<{ eventId?: string }>;
      expect(evidence.map((item) => item.eventId)).toEqual([seed.rawEventIds[0]!]);

      // Nothing was promoted: the candidate is waiting for `memory review`.
      expect(shell.kernel.factStore.getDatabase()
        .prepare(`SELECT COUNT(*) AS count FROM beliefs WHERE source_type='llm_inference'`)
        .get()).toEqual({ count: 0 });

      // The model role alone must not claim a semantic index while embedding is deterministic.
      expect(shell.kernel.semanticIndexEnabled()).toBe(false);
      expect(shell.backend.recall({
        query: '事实同伴库', projectId: shell.config.projectId, agentId: shell.config.agentId, limit: 3,
      }).semanticIndex).toBe(false);

      const usage = shell.trace.read().filter((record) => record.kind === 'dream_model_usage');
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.every((record) => record.estimated === false)).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('the nightly cap stops model calls, keeps rule candidates, and charges the day counter', async () => {
    const model = startModelServer({ prompt_tokens: 100, completion_tokens: 50 });
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), {
      dream: DREAM_ALL_DAY,
      nightBudget: { maxTokensPerNight: 10 },
      model: { baseUrl: model.url, apiKey: 'test-key', model: 'test-model', timeoutMs: 5_000 },
    });
    await shell.start();
    try {
      const clock = shell.host.getService<{ dreamTargetDate(at?: number): string }>('clock');
      const dayThread = `companion-day:${clock.dreamTargetDate(NIGHT)}`;
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        threadId: dayThread,
        turnId: 'route-a-budget',
        userText: '请以后始终记住：不要碰事实同伴库。',
        assistantText: '记下了。',
        timestamp: BASE,
        ingestMode: 'raw_then_dream',
      });

      await shell.runDream(NIGHT);
      const modelCandidates = shell.kernel.listDreamCandidates({ projectId: shell.config.projectId, limit: 200 })
        .filter((candidate) => JSON.stringify(candidate.content).includes('llm_dream_curator_candidate'));
      expect(modelCandidates).toHaveLength(0);
      expect(shell.kernel.listDreamCandidates({ projectId: shell.config.projectId, limit: 200 }).length).toBeGreaterThan(0);
      expect(shell.trace.read().some((record) => record.kind === 'dream_model_budget_exceeded' && record.reason === 'night_token_budget')).toBe(true);
      expect(shell.trace.read().some((record) => record.kind === 'dream_model_degraded')).toBe(true);
      expect(shell.machine.runtime.costDayTokens ?? 0).toBeGreaterThanOrEqual(150);
    } finally {
      await shell.stop();
    }
  });
});

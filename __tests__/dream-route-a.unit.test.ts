import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * Route A's contract: the model proposes, the CPU/reviewer decides. A model candidate is
 * `llm_inference`, carries only evidence from the supplied ledger, and cannot become durable
 * memory until a user confirmation is reviewed.
 */
async function seed() {
  const dir = makeTempDir('cogmem-dream-route-a-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), vectorBackend: 'sqlite-vec' });
  const backend = new KernelAgentMemoryBackend(kernel);
  const preference = await backend.rememberTurnWithResult({
    agentId: 'openclaw', projectId: 'demo', sessionId: 'session-a',
    userText: '请以后始终用中文回复。',
    assistantText: '好。',
    ingestMode: 'raw_then_dream',
  });
  const goal = await backend.rememberTurnWithResult({
    agentId: 'openclaw', projectId: 'demo', sessionId: 'session-a',
    userText: '长期目标是让记忆可审计。',
    assistantText: '会保留证据链。',
    ingestMode: 'raw_then_dream',
  });
  const assistantOnly = await backend.rememberTurnWithResult({
    agentId: 'openclaw', projectId: 'demo', sessionId: 'session-a',
    userText: '今天天气不错。',
    assistantText: '我喜欢把记忆做成黑盒。',
    ingestMode: 'raw_then_dream',
  });
  return { kernel, preference, goal, assistantOnly };
}

test('fixed corpus: the model proposes the expected candidates with legal evidence', async () => {
  const { kernel, preference, goal, assistantOnly } = await seed();
  try {
    const preferenceEvent = preference.rawEventIds[0]!;
    const goalEvent = goal.rawEventIds[0]!;
    const assistantEvent = assistantOnly.rawEventIds[1]!;

    await kernel.runDreamCurator({
      projectId: 'demo',
      limit: 20,
      generateText: async () => JSON.stringify({
        userPreferenceCandidates: [{
          statement: '用户希望始终用中文回复。',
          confidence: 0.9,
          evidenceEventIds: [preferenceEvent],
        }],
        longTermGoalCandidates: [{
          statement: '用户的目标是让记忆可审计。',
          confidence: 0.88,
          evidenceEventIds: [goalEvent],
        }],
        // Assistant-only evidence is not user evidence, and a forged id is not evidence at all.
        boundaryCandidates: [{
          statement: '用户要求黑盒。',
          confidence: 0.95,
          evidenceEventIds: [assistantEvent],
        }],
        failureLessonCandidates: [{
          statement: '伪造证据不应进入候选。',
          confidence: 0.99,
          evidenceEventIds: ['evt-forged'],
        }],
      }),
    });

    const candidates = kernel.listDreamCandidates({
      projectId: 'demo',
      candidateTypes: ['user_preference', 'long_term_goal', 'boundary', 'failure_lesson'],
      limit: 50,
    });
    const types = candidates.map((candidate) => candidate.candidateType).sort();
    const expected = ['long_term_goal', 'user_preference'];
    expect(types).toEqual(expected);
    expect(types.filter((type) => expected.includes(type)).length / types.length).toBe(1);
    expect(types.filter((type) => expected.includes(type)).length / expected.length).toBe(1);

    const legal = new Set([preferenceEvent, goalEvent]);
    for (const candidate of candidates) {
      expect(candidate.status).toBe('needs_confirmation');
      expect(candidate.statusReason).toBe('llm_inference_requires_user_review');
      expect((candidate.content as Record<string, unknown>).sourceType).toBe('llm_inference');
      const evidence = candidate.evidence as Array<{ eventId?: string }>;
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.every((item) => typeof item.eventId === 'string' && legal.has(item.eventId))).toBe(true);
    }

    // `memory govern` does not touch review candidates. Even with the assistant-only and forged
    // buckets in the model's answer, the model created no durable llm_inference belief.
    kernel.promoteDreamCandidates({ projectId: 'demo', limit: 100 });
    const promotedFromModel = kernel.factStore.getDatabase()
      .prepare(`SELECT COUNT(*) AS count FROM beliefs WHERE source_type='llm_inference'`)
      .get() as { count: number };
    expect(promotedFromModel.count).toBe(0);
  } finally {
    kernel.close();
  }
});

test('model candidates are not promoted by govern; review keeps llm_inference provenance', async () => {
  const { kernel, preference } = await seed();
  try {
    const eventId = preference.rawEventIds[0]!;
    await kernel.runDreamCurator({
      projectId: 'demo',
      limit: 20,
      generateText: async () => JSON.stringify({
        userPreferenceCandidates: [{
          statement: '用户希望始终用中文回复。',
          confidence: 0.9,
          evidenceEventIds: [eventId],
        }],
      }),
    });
    const candidate = kernel.listDreamCandidates({
      projectId: 'demo', candidateTypes: ['user_preference'], limit: 10,
    })[0]!;

    kernel.promoteDreamCandidates({ projectId: 'demo', limit: 50 });
    expect(kernel.listDreamCandidates({ projectId: 'demo', candidateTypes: ['user_preference'], limit: 10 })[0]!.status)
      .toBe('needs_confirmation');

    const confirmation = kernel.eventStore.append({
      eventId: 'evt-owner-confirm', streamId: 'session-a', streamType: 'thread', eventType: 'MESSAGE',
      rawEventType: 'message', projectId: 'demo', role: 'user', payload: { text: '我确认这个偏好。' },
    });
    const reviewed = kernel.reviewDreamCandidate({
      candidateId: candidate.candidateId,
      projectId: 'demo',
      action: 'approve',
      actor: 'owner',
      reason: 'user confirmed this preference',
      confirmationEventId: confirmation.eventId,
    });
    const belief = kernel.factStore.getDatabase()
      .prepare(`SELECT source_type FROM beliefs WHERE id=?`)
      .get(reviewed.decision?.targetId || '') as { source_type?: string } | null;
    expect(belief?.source_type).toBe('llm_inference');
  } finally {
    kernel.close();
  }
});

test('fault injection writes no fake model candidate and leaves the recall contract alone', async () => {
  const cases: Array<{ name: string; generateText: () => Promise<string> }> = [
    { name: 'timeout', generateText: async () => { throw new Error('provider timeout'); } },
    { name: 'non-json', generateText: async () => 'not json' },
    {
      name: 'forged-event',
      generateText: async () => JSON.stringify({
        userPreferenceCandidates: [{
          statement: '伪造证据的候选。',
          confidence: 0.99,
          evidenceEventIds: ['evt-forged'],
        }],
      }),
    },
  ];
  for (const scenario of cases) {
    const { kernel } = await seed();
    try {
      const backend = new KernelAgentMemoryBackend(kernel);
      const recall = () => backend.recall({ query: '中文回复', projectId: 'demo', agentId: 'openclaw', limit: 3 });
      const before = recall().semanticIndex;
      await kernel.runDreamCurator({ projectId: 'demo', limit: 20, generateText: scenario.generateText });
      const modelCandidates = kernel.listDreamCandidates({ projectId: 'demo', limit: 200 })
        .filter((candidate) => JSON.stringify(candidate.content).includes('llm_dream_curator_candidate'));
      expect(modelCandidates).toHaveLength(0);
      expect(kernel.semanticIndexEnabled()).toBe(before);
      expect(recall().semanticIndex).toBe(before);
      expect(kernel.listDreamCandidates({ projectId: 'demo', statuses: ['needs_confirmation'], limit: 200 })
        .filter((candidate) => candidate.statusReason === 'llm_inference_requires_user_review')).toHaveLength(0);

      kernel.promoteDreamCandidates({ projectId: 'demo', limit: 100 });
      const promotedFromModel = kernel.factStore.getDatabase()
        .prepare(`SELECT COUNT(*) AS count FROM beliefs WHERE source_type='llm_inference'`)
        .get() as { count: number };
      expect(promotedFromModel.count).toBe(0);
    } finally {
      kernel.close();
    }
  }
});

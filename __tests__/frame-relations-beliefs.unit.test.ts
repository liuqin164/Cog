import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { stageFrameRelationCandidates } from '../src/belief/FrameRelationBeliefs.js';
import { deterministicFrameFallback } from '../src/semantic/DeterministicFrameFallback.js';
import { DeepWriteCandidateStore } from '../src/store/DeepWriteCandidateStore.js';
import { makeTempDir } from './helpers/tmp.js';

function createKernel(): MemoryKernel {
  return createMemoryKernel({ dbPath: join(makeTempDir('cogmem-frame-beliefs-'), 'memory.db') });
}

function seedEvent(
  kernel: MemoryKernel,
  text = '我喜欢钓鱼。',
  when: { eventId?: string; occurredAt?: number } = {},
): { eventId: string; episodeId: string; occurredAt: number } {
  const eventId = when.eventId ?? 'evt-1';
  const occurredAt = when.occurredAt ?? Date.UTC(2026, 5, 5, 12, 0, 0);
  const event = kernel.eventStore.append({
    eventId,
    streamId: 'session-1',
    streamType: 'thread',
    eventType: 'MESSAGE',
    rawEventType: 'message',
    projectId: 'p',
    sessionId: 'session-1',
    threadId: 'session-1',
    role: 'user',
    occurredAt,
    localDate: new Date(occurredAt).toISOString().slice(0, 10),
    payload: { text },
  });
  kernel.appendRawEventToEpisode(event, { projectId: 'p', sessionId: 'session-1', sourceAgent: 'test', now: occurredAt });
  const link = kernel.memoryFrameStore.getDatabase()
    .prepare('SELECT episode_id FROM memory_episode_events WHERE event_id=?')
    .get(eventId) as { episode_id?: string } | null;
  return { eventId, episodeId: link?.episode_id ?? '', occurredAt };
}

function frameWith(
  evidence: { eventId: string; episodeId: string; occurredAt: number },
  relations: Array<{ sourceFrameNodeId: string; relationType: string; targetFrameNodeId: string }>,
) {
  const base = deterministicFrameFallback({
    projectId: 'p',
    episodeId: evidence.episodeId,
    events: [{ eventId: evidence.eventId, occurredAt: evidence.occurredAt } as never],
    now: evidence.occurredAt,
  });
  return {
    ...base,
    sourceAuthority: 'processor' as const,
    needsReview: false,
    evidenceEventIds: [evidence.eventId],
    nodes: [
      ...base.nodes,
      { frameNodeId: 'n-actor', dimension: 'actor' as const, label: '用户', confidence: 0.9, evidenceEventIds: [evidence.eventId] },
      { frameNodeId: 'n-fishing', dimension: 'object' as const, label: '钓鱼', confidence: 0.9, evidenceEventIds: [evidence.eventId] },
      { frameNodeId: 'n-hiking', dimension: 'object' as const, label: '登山', confidence: 0.9, evidenceEventIds: [evidence.eventId] },
      { frameNodeId: 'n-li', dimension: 'actor' as const, label: '李四', confidence: 0.9, evidenceEventIds: [evidence.eventId] },
      { frameNodeId: 'n-wang', dimension: 'actor' as const, label: '王五', confidence: 0.9, evidenceEventIds: [evidence.eventId] },
    ],
    relations: relations.map((relation) => ({ ...relation, confidence: 0.9, evidenceEventIds: [evidence.eventId] })),
  };
}

function publish(kernel: MemoryKernel, frame: ReturnType<typeof frameWith>): void {
  const saved = kernel.memoryFrameStore.save({ frame, sourceFingerprint: 'fp', publishStatus: 'active' });
  expect(kernel.memoryFrameStore.publish(saved.frameId, 'staged', 'active')).toBe(true);
}

function confirm(kernel: MemoryKernel, candidateId: string, eventId: string, text: string) {
  const confirmation = kernel.eventStore.append({
    eventId, streamId: 'session-1', streamType: 'thread', eventType: 'MESSAGE',
    rawEventType: 'message', projectId: 'p', role: 'user', payload: { text },
  });
  return kernel.reviewDreamCandidate({
    candidateId,
    projectId: 'p',
    action: 'approve',
    actor: 'owner',
    reason: 'owner confirmed the relation',
    confirmationEventId: confirmation.eventId,
  });
}

test('a published frame stages its relations as needs_confirmation candidates, not beliefs', () => {
  const kernel = createKernel();
  try {
    const evidence = seedEvent(kernel);
    publish(kernel, frameWith(evidence, [{ sourceFrameNodeId: 'n-actor', relationType: 'LIKES', targetFrameNodeId: 'n-fishing' }]));

    expect(kernel.beliefStore.findByCanonicalKey('用户|preference.LIKES|project', 'p')).toHaveLength(0);
    const candidates = kernel.listDreamCandidates({ projectId: 'p', candidateTypes: ['relations'], limit: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      status: 'needs_confirmation',
      promotionTargetType: 'belief',
      content: { from: '用户', to: '钓鱼', relationType: 'LIKES', source: 'llm_inference' },
    });
    expect(kernel.countDreamCandidates({ projectId: 'p', statuses: ['needs_confirmation'] })).toBe(1);
  } finally {
    kernel.close();
  }
});

test('a frame waiting for review stages no relation candidate', () => {
  const kernel = createKernel();
  try {
    const evidence = seedEvent(kernel);
    kernel.memoryFrameStore.save({
      frame: frameWith(evidence, [{ sourceFrameNodeId: 'n-actor', relationType: 'LIKES', targetFrameNodeId: 'n-fishing' }]),
      sourceFingerprint: 'fp',
      publishStatus: 'needs_confirmation',
    });
    expect(kernel.listDreamCandidates({ projectId: 'p', candidateTypes: ['relations'], limit: 10 })).toHaveLength(0);
  } finally {
    kernel.close();
  }
});

test('review confirmation promotes the relation into the belief path', () => {
  const kernel = createKernel();
  try {
    const evidence = seedEvent(kernel);
    publish(kernel, frameWith(evidence, [{ sourceFrameNodeId: 'n-actor', relationType: 'LIKES', targetFrameNodeId: 'n-fishing' }]));
    const candidate = kernel.listDreamCandidates({ projectId: 'p', candidateTypes: ['relations'], limit: 10 })[0]!;

    expect(kernel.promoteDreamCandidates({ projectId: 'p', limit: 20 }).promotedCandidates).toBe(0);
    const reviewed = confirm(kernel, candidate.candidateId, 'evt-confirm-like', '对，我喜欢钓鱼。');
    expect(reviewed.candidate.status).toBe('promoted');
    expect(reviewed.decision).toMatchObject({ targetType: 'belief' });

    const beliefs = kernel.beliefStore.findByCanonicalKey('用户|preference.LIKES|project', 'p');
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]!.objectValue.raw).toBe('钓鱼');
    expect(beliefs[0]!.sourceType).toBe('llm_inference');
    expect(beliefs[0]!.status).toBe('active');
  } finally {
    kernel.close();
  }
});

test('confirmed relationships coexist instead of superseding each other', () => {
  const kernel = createKernel();
  try {
    const evidence = seedEvent(kernel);
    publish(kernel, frameWith(evidence, [
      { sourceFrameNodeId: 'n-actor', relationType: 'FRIEND_OF', targetFrameNodeId: 'n-li' },
      { sourceFrameNodeId: 'n-actor', relationType: 'FRIEND_OF', targetFrameNodeId: 'n-wang' },
    ]));
    const candidates = kernel.listDreamCandidates({ projectId: 'p', candidateTypes: ['relations'], limit: 10 });
    expect(candidates).toHaveLength(2);
    for (const [index, candidate] of candidates.entries()) {
      confirm(kernel, candidate.candidateId, `evt-confirm-friend-${index}`, `对，我们是朋友 ${index}。`);
    }
    const friends = kernel.beliefStore.findByCanonicalKey('用户|FRIEND_OF|project|李四', 'p')
      .concat(kernel.beliefStore.findByCanonicalKey('用户|FRIEND_OF|project|王五', 'p'));
    expect(friends.map((row) => row.objectValue.raw).sort()).toEqual(['李四', '王五']);
    expect(friends.every((row) => row.status === 'active')).toBe(true);
  } finally {
    kernel.close();
  }
});

test('an unknown relation name survives review as RELATED_TO', () => {
  const kernel = createKernel();
  try {
    const evidence = seedEvent(kernel);
    const frame = frameWith(evidence, [{ sourceFrameNodeId: 'n-actor', relationType: 'ADMIRES', targetFrameNodeId: 'n-li' }]);
    publish(kernel, frame as ReturnType<typeof frameWith>);
    const candidate = kernel.listDreamCandidates({ projectId: 'p', candidateTypes: ['relations'], limit: 10 })[0]!;
    expect(candidate.content).toMatchObject({ relationType: 'RELATED_TO', to: '李四' });
    confirm(kernel, candidate.candidateId, 'evt-confirm-related', '对，我欣赏李四。');
    const beliefs = kernel.beliefStore.findByCanonicalKey('用户|RELATED_TO|project|李四', 'p');
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]!.objectValue.raw).toBe('李四');
  } finally {
    kernel.close();
  }
});

test('staging the same frame twice does not duplicate its candidates', () => {
  const kernel = createKernel();
  try {
    const evidence = seedEvent(kernel);
    const frame = frameWith(evidence, [{ sourceFrameNodeId: 'n-actor', relationType: 'LIKES', targetFrameNodeId: 'n-fishing' }]);
    const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
    const first = stageFrameRelationCandidates(store, frame as never, 1_000);
    const second = stageFrameRelationCandidates(store, frame as never, 2_000);
    expect(first.staged).toBe(1);
    expect(second.staged).toBe(0);
    expect(second.skipped).toContainEqual({ relation: '*', reason: 'already_recorded' });
  } finally {
    kernel.close();
  }
});

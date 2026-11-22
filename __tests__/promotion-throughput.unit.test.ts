import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { DeepWriteCandidateStore } from '../src/store/DeepWriteCandidateStore.js';
import { makeTempDir } from './helpers/tmp.js';

const DAY = 24 * 60 * 60 * 1000;

function candidateSet(projectId: string, runId: string, eventId: string, now: number) {
  const evidence = [eventId];
  return [
    {
      runId, candidateType: 'semantic_relation', status: 'candidate' as const, confidence: 0.9,
      content: { projectId, sourceEventId: eventId, targetEventId: eventId }, evidence,
      promotionTargetType: 'semantic_relation', createdAt: now - 400,
    },
    {
      runId, candidateType: 'facts', status: 'candidate' as const, confidence: 0.9,
      content: { projectId, source: 'explicit_user_statement', subject: 'owner', predicateFamily: 'drinks', object: 'tea' },
      evidence, createdAt: now - 300,
    },
    {
      runId, candidateType: 'preferences', status: 'candidate' as const, confidence: 0.9,
      content: { projectId, source: 'explicit_user_statement', value: 'tea' }, evidence, createdAt: now - 200,
    },
    {
      runId, candidateType: 'correction', status: 'candidate' as const, confidence: 0.9,
      content: { projectId, source: 'explicit_user_statement', correctedClaimKey: 'owner.drinks' },
      evidence, createdAt: now - 100,
    },
  ];
}

test('promotion consumes correction, then preference, before fact and organization (#433)', () => {
  const dir = makeTempDir('cogmem-promotion-priority-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), vectorBackend: 'sqlite-vec' });
  const now = Date.now();
  const projectId = 'promotion-priority';
  const event = kernel.recordRawEvent({ projectId, threadId: 't-priority', role: 'user', content: '我改喝红茶了。' });
  const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
  const run = store.insertRun({
    projectId, sourceNeuronIds: [event.eventId], mode: 'episode',
    promptHash: 'p', outputHash: 'o', status: 'succeeded', createdAt: now - 5_000,
  });
  const rows = store.insertCandidates(candidateSet(projectId, run.runId, event.eventId, now));

  const result = kernel.promoteDreamCandidates({ projectId, limit: 2, now });

  expect(result.decisions).toHaveLength(2);
  expect(store.getCandidate(rows[3]!.candidateId)!.status).toBe('promoted');
  expect(store.getCandidate(rows[2]!.candidateId)!.status).toBe('promoted');
  expect(store.getCandidate(rows[1]!.candidateId)!.status).toBe('candidate');
  expect(store.getCandidate(rows[0]!.candidateId)!.status).toBe('candidate');
  kernel.close();
});

test('candidate TTL retires stale rows without deleting them, and health reports the oldest age (#433)', () => {
  const dir = makeTempDir('cogmem-promotion-ttl-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), vectorBackend: 'sqlite-vec' });
  const now = Date.now();
  const projectId = 'promotion-ttl';
  const event = kernel.recordRawEvent({ projectId, threadId: 't-ttl', role: 'user', content: '记一下。' });
  const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
  const run = store.insertRun({
    projectId, sourceNeuronIds: [event.eventId], mode: 'episode',
    promptHash: 'p', outputHash: 'o', status: 'succeeded', createdAt: now - 41 * DAY,
  });
  const base = {
    runId: run.runId, candidateType: 'semantic_tags', status: 'candidate' as const, confidence: 0.9,
    content: { projectId }, evidence: [event.eventId], promotionTargetType: 'semantic_tags',
  };
  const [stale, fresh] = store.insertCandidates([
    { ...base, createdAt: now - 40 * DAY },
    { ...base, createdAt: now - 2 * DAY },
  ]);

  const health = kernel.getHealthStatus();
  expect(health.backlog.candidateQueue.oldestCandidateAgeMs).toBeGreaterThanOrEqual(40 * DAY);

  const result = kernel.promoteDreamCandidates({ projectId, now, candidateTtlMs: 30 * DAY, limit: 100 });

  expect(result.expiredCandidates).toBe(1);
  const retired = store.getCandidate(stale!.candidateId)!;
  expect(retired.status).toBe('superseded');
  expect(retired.statusReason).toBe('candidate_ttl_expired');
  expect(store.getCandidate(fresh!.candidateId)!.status).toBe('promoted');
  kernel.close();
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { candidateContentHash } from '../src/governance/CandidateReviewService.js';
import { startObservatoryServer, type ObservatoryServerHandle } from '../src/observatory/HttpServer.js';
import { OBSERVATORY_TOKEN_HEADER, ensureObservatoryToken } from '../src/observatory/token.js';
import { DeepWriteCandidateStore } from '../src/store/DeepWriteCandidateStore.js';
import { makeTempDir } from './helpers/tmp.js';

const PROJECT = 'observatory-candidates';
const scratch = makeTempDir('cogmem-observatory-candidates-');
const dbPath = join(scratch, 'memory.db');
let kernel: MemoryKernel;
let handle: ObservatoryServerHandle;
let token: string;

beforeAll(async () => {
  token = ensureObservatoryToken(scratch);
  kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  kernel.eventStore.append({
    eventId: 'evt-candidate-evidence',
    streamId: 'review',
    streamType: 'thread',
    eventType: 'MESSAGE',
    rawEventType: 'message',
    projectId: PROJECT,
    role: 'user',
    payload: { text: '候选证据。' },
  });
  seedCandidate('cand-promote', 1_000, { topicPath: 'review/promote' });
  seedCandidate('cand-reject', 2_000, { topicPath: 'review/reject' });
  seedCandidate('cand-defer', 3_000, { topicPath: 'review/defer' });
  seedCandidate('cand-stale', 4_000, { topicPath: 'review/stale' });
  for (let index = 0; index < 21; index += 1) {
    seedCandidate(`cand-batch-${index}`, 5_000 + index, { topicPath: `review/batch-${index}` });
  }
  handle = await startObservatoryServer({ kernel, port: 0 });
});

afterAll(() => {
  handle.stop();
  kernel.close();
  rmSync(scratch, { recursive: true, force: true });
});

function seedCandidate(candidateId: string, createdAt: number, content: Record<string, unknown>): void {
  const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
  store.insertRun({
    runId: `run-${candidateId}`,
    projectId: PROJECT,
    sourceNeuronIds: ['evt-candidate-evidence'],
    mode: 'episode',
    promptHash: 'prompt',
    outputHash: 'output',
    status: 'succeeded',
  });
  store.insertCandidates([{
    candidateId,
    runId: `run-${candidateId}`,
    candidateType: 'semantic_tags',
    status: 'needs_confirmation',
    confidence: 0.8,
    content,
    evidence: [{ eventId: 'evt-candidate-evidence', role: 'user' }],
    statusReason: 'manual_review_required',
    createdAt,
  }]);
}

function base(): string {
  return handle.url.replace(/\/$/u, '');
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:7338',
      [OBSERVATORY_TOKEN_HEADER]: token,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function candidate(candidateId: string): Promise<{ candidateId: string; status: string; contentHash: string }> {
  const response = await fetch(`${base()}/candidates?project=${PROJECT}`);
  const body = await response.json() as { candidates: Array<{ candidateId: string; status: string; contentHash: string }> };
  const found = body.candidates.find((item) => item.candidateId === candidateId);
  if (!found) throw new Error(`candidate_not_listed:${candidateId}`);
  return found;
}

describe('the observatory candidate review face (#473)', () => {
  test('the list returns needs-confirmation candidates nearest expiry first with a content hash', async () => {
    const response = await fetch(`${base()}/candidates?project=${PROJECT}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { candidates: Array<{ candidateId: string; contentHash: string }> };
    expect(body.candidates[0]?.candidateId).toBe('cand-promote');
    expect(body.candidates[1]?.candidateId).toBe('cand-reject');
    expect(body.candidates[2]?.candidateId).toBe('cand-defer');
    expect(body.candidates[0]?.contentHash).toBe(candidateContentHash({ topicPath: 'review/promote' }));
  });

  test('cross-origin, non-JSON and untokened writes are refused before the service runs', async () => {
    const body = { projectId: PROJECT, contentHash: (await candidate('cand-promote')).contentHash };
    const crossOrigin = await post('/candidates/cand-promote/promote', body, { origin: 'https://evil.example' });
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json() as { error: string }).error).toBe('cross_origin_write_refused');

    const plain = await fetch(`${base()}/candidates/cand-promote/promote`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example', [OBSERVATORY_TOKEN_HEADER]: token },
      body: JSON.stringify(body),
    });
    expect(plain.status).toBe(415);

    const missing = await post('/candidates/cand-promote/promote', body, { [OBSERVATORY_TOKEN_HEADER]: '' });
    expect(missing.status).toBe(403);
    expect((await missing.json() as { error: string }).error).toBe('invalid_observatory_token');

    const wrong = await post('/candidates/cand-promote/promote', body, { [OBSERVATORY_TOKEN_HEADER]: 'wrong' });
    expect(wrong.status).toBe(403);
    expect((await wrong.json() as { error: string }).error).toBe('invalid_observatory_token');
    expect((await candidate('cand-promote')).status).toBe('needs_confirmation');
  });

  test('a stale content hash is refused and leaves the candidate untouched', async () => {
    const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
    const current = store.getCandidate('cand-stale')!;
    const staleHash = candidateContentHash(current.content);
    store.updateCandidateReviewData('cand-stale', {
      content: { topicPath: 'review/stale-changed' },
      evidence: current.evidence,
      promotionTargetType: current.promotionTargetType,
      promotionTargetId: current.promotionTargetId,
      status: 'needs_confirmation',
      statusReason: 'manual_review_required',
    });

    const response = await post('/candidates/cand-stale/reject', { projectId: PROJECT, contentHash: staleHash });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('candidate_content_changed');
    expect(store.getCandidate('cand-stale')?.status).toBe('needs_confirmation');
  });

  test('promote, reject and defer each move the candidate and write surface=observatory audit rows', async () => {
    const promoteHash = (await candidate('cand-promote')).contentHash;
    const promoted = await post('/candidates/cand-promote/promote', {
      projectId: PROJECT,
      contentHash: promoteHash,
      reason: 'owner-approved',
    });
    expect(promoted.status).toBe(200);
    const promotedBody = await promoted.json() as {
      review: { action: string; surface?: string };
      candidate: { status: string };
    };
    expect(promotedBody.review.action).toBe('approve');
    expect(promotedBody.review.surface).toBe('observatory');
    expect(promotedBody.candidate.status).toBe('promoted');

    const rejected = await post('/candidates/cand-reject/reject', {
      projectId: PROJECT,
      contentHash: (await candidate('cand-reject')).contentHash,
    });
    expect(rejected.status).toBe(200);
    expect((await rejected.json() as { candidate: { status: string } }).candidate.status).toBe('rejected');

    const reviewAfter = Date.now() + 86_400_000;
    const deferred = await post('/candidates/cand-defer/defer', {
      projectId: PROJECT,
      contentHash: (await candidate('cand-defer')).contentHash,
      reviewAfter,
    });
    expect(deferred.status).toBe(200);
    const deferredBody = await deferred.json() as {
      review: { action: string; reviewAfter?: number; surface?: string };
      candidate: { status: string; reviewAfter?: number };
    };
    expect(deferredBody.review.action).toBe('defer');
    expect(deferredBody.review.reviewAfter).toBe(reviewAfter);
    expect(deferredBody.review.surface).toBe('observatory');
    expect(deferredBody.candidate.status).toBe('needs_confirmation');
    expect(deferredBody.candidate.reviewAfter).toBe(reviewAfter);

    const reviews = kernel.listDreamCandidateReviews({ projectId: PROJECT, limit: 20 });
    expect(reviews.every((review) => review.surface === 'observatory')).toBe(true);
    expect(reviews.map((review) => review.action).sort()).toEqual(['approve', 'defer', 'reject']);
  });

  test('batch review refuses more than 20, and refuses to run without a second confirmation', async () => {
    const listed = await (await fetch(`${base()}/candidates?project=${PROJECT}&limit=200`)).json() as {
      candidates: Array<{ candidateId: string; contentHash: string }>;
    };
    const batch = listed.candidates.filter((item) => item.candidateId.startsWith('cand-batch-'));
    expect(batch).toHaveLength(21);

    const tooMany = await post('/candidates/batch', {
      projectId: PROJECT,
      action: 'reject',
      confirm: true,
      items: batch.map((item) => ({ candidateId: item.candidateId, contentHash: item.contentHash })),
    });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json() as { error: string }).error).toBe('batch_limit_exceeded');

    const unconfirmed = await post('/candidates/batch', {
      projectId: PROJECT,
      action: 'reject',
      items: batch.slice(0, 2).map((item) => ({ candidateId: item.candidateId, contentHash: item.contentHash })),
    });
    expect(unconfirmed.status).toBe(400);
    expect((await unconfirmed.json() as { error: string }).error).toBe('batch_confirmation_required');

    const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
    for (const item of batch.slice(0, 3)) expect(store.getCandidate(item.candidateId)?.status).toBe('needs_confirmation');
  });

  test('a confirmed batch reviews up to 20 candidates and audits each row as observatory', async () => {
    const listed = await (await fetch(`${base()}/candidates?project=${PROJECT}&limit=200`)).json() as {
      candidates: Array<{ candidateId: string; contentHash: string }>;
    };
    const batch = listed.candidates.filter((item) => item.candidateId.startsWith('cand-batch-')).slice(0, 2);
    const response = await post('/candidates/batch', {
      projectId: PROJECT,
      action: 'reject',
      confirm: true,
      reason: 'batch-owner-review',
      items: batch.map((item) => ({ candidateId: item.candidateId, contentHash: item.contentHash })),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<{ candidateId: string; candidate: { status: string } }> };
    expect(body.results).toHaveLength(2);
    expect(body.results.every((result) => result.candidate.status === 'rejected')).toBe(true);

    const reviews = kernel.listDreamCandidateReviews({ projectId: PROJECT, limit: 50 });
    for (const item of batch) {
      expect(reviews.some((review) => review.candidateId === item.candidateId && review.surface === 'observatory')).toBe(true);
    }
  });

  test('a batch with a repeated candidate id is refused before any review runs', async () => {
    const listed = await (await fetch(`${base()}/candidates?project=${PROJECT}&limit=200`)).json() as {
      candidates: Array<{ candidateId: string; contentHash: string }>;
    };
    const item = listed.candidates.find((candidate) => candidate.candidateId.startsWith('cand-batch-'))!;
    const response = await post('/candidates/batch', {
      projectId: PROJECT,
      action: 'reject',
      confirm: true,
      items: [item, item],
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('duplicate_candidate_id');
    const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
    expect(store.getCandidate(item.candidateId)?.status).toBe('needs_confirmation');
    expect(kernel.listDreamCandidateReviews({ projectId: PROJECT, candidateId: item.candidateId })).toHaveLength(0);
  });

  test('a batch that fails midway rolls back every candidate and audit row', async () => {
    const listed = await (await fetch(`${base()}/candidates?project=${PROJECT}&limit=200`)).json() as {
      candidates: Array<{ candidateId: string; contentHash: string }>;
    };
    const batch = listed.candidates.filter((item) => item.candidateId.startsWith('cand-batch-')).slice(0, 2);
    expect(batch).toHaveLength(2);
    const original = kernel.reviewDreamCandidate.bind(kernel);
    kernel.reviewDreamCandidate = ((input) => {
      if (input.candidateId === batch[1]!.candidateId) throw new Error('review_failed');
      return original(input);
    }) as typeof kernel.reviewDreamCandidate;
    try {
      const response = await post('/candidates/batch', {
        projectId: PROJECT,
        action: 'reject',
        confirm: true,
        items: batch.map((item) => ({ candidateId: item.candidateId, contentHash: item.contentHash })),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe('review_failed');
    } finally {
      kernel.reviewDreamCandidate = original;
    }
    const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
    for (const item of batch) {
      expect(store.getCandidate(item.candidateId)?.status).toBe('needs_confirmation');
      expect(kernel.listDreamCandidateReviews({ projectId: PROJECT, candidateId: item.candidateId })).toHaveLength(0);
    }
  });

  test('a failed promote leaves no orphan user confirmation event', async () => {
    const target = await candidate('cand-batch-4');
    const count = () => (kernel.factStore.getDatabase().prepare(
      `SELECT COUNT(*) AS n FROM memory_events WHERE payload_json LIKE '%candidate_promote%'`,
    ).get() as { n: number }).n;
    const before = count();
    const original = kernel.reviewDreamCandidate.bind(kernel);
    kernel.reviewDreamCandidate = ((input) => {
      if (input.candidateId === target.candidateId) throw new Error('promotion_failed');
      return original(input);
    }) as typeof kernel.reviewDreamCandidate;
    try {
      const response = await post(`/candidates/${target.candidateId}/promote`, {
        projectId: PROJECT,
        contentHash: target.contentHash,
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe('promotion_failed');
    } finally {
      kernel.reviewDreamCandidate = original;
    }
    expect(count()).toBe(before);
    expect((await candidate(target.candidateId)).status).toBe('needs_confirmation');
  });
});

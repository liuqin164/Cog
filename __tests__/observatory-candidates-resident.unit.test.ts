import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { startObservatoryServer, type ObservatoryServerHandle } from '../src/observatory/HttpServer.js';
import { OBSERVATORY_TOKEN_HEADER, ensureObservatoryToken } from '../src/observatory/token.js';
import { DeepWriteCandidateStore } from '../src/store/DeepWriteCandidateStore.js';
import { makeTempDir } from './helpers/tmp.js';

const PROJECT = 'observatory-resident';
const scratch = makeTempDir('cogmem-observatory-resident-');
const dbPath = join(scratch, 'memory.db');
let kernel: MemoryKernel;
let handle: ObservatoryServerHandle;
let token: string;

beforeAll(async () => {
  token = ensureObservatoryToken(scratch);
  writeFileSync(join(scratch, 'runtime.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  kernel.eventStore.append({
    eventId: 'evt-resident-evidence',
    streamId: 'review',
    streamType: 'thread',
    eventType: 'RAW_EVENT_RECORDED',
    rawEventType: 'message',
    projectId: PROJECT,
    role: 'user',
    payload: { text: '候选证据。' },
  });
  const store = new DeepWriteCandidateStore(kernel.factStore.getDatabase());
  store.insertRun({
    runId: 'run-resident',
    projectId: PROJECT,
    sourceNeuronIds: ['evt-resident-evidence'],
    mode: 'episode',
    promptHash: 'prompt',
    outputHash: 'output',
    status: 'succeeded',
  });
  store.insertCandidates([{
    candidateId: 'cand-resident',
    runId: 'run-resident',
    candidateType: 'semantic_tags',
    status: 'needs_confirmation',
    confidence: 0.8,
    content: { topicPath: 'review/resident' },
    evidence: [{ eventId: 'evt-resident-evidence', role: 'user' }],
    statusReason: 'manual_review_required',
    createdAt: 1_000,
  }]);
  handle = await startObservatoryServer({ kernel, port: 0 });
});

afterAll(() => {
  handle.stop();
  kernel.close();
  rmSync(scratch, { recursive: true, force: true });
});

function base(): string {
  return handle.url.replace(/\/$/u, '');
}

describe('the standalone observatory while the resident owns the database (#484)', () => {
  test('candidate reads stay available and writes point back to the resident star sea', async () => {
    const listed = await (await fetch(`${base()}/candidates?project=${PROJECT}`)).json() as {
      candidates: Array<{ candidateId: string; contentHash: string }>;
    };
    expect(listed.candidates.map((candidate) => candidate.candidateId)).toEqual(['cand-resident']);

    const response = await fetch(`${base()}/candidates/cand-resident/promote`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:7337',
        [OBSERVATORY_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ projectId: PROJECT, contentHash: listed.candidates[0]!.contentHash }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe('candidates_read_only_resident_running');
    expect(body.message).toBe('请在常驻星海操作');
    expect(new DeepWriteCandidateStore(kernel.factStore.getDatabase()).getCandidate('cand-resident')?.status).toBe('needs_confirmation');
  });
});

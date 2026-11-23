import { afterAll, describe, expect, test } from 'bun:test';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { KernelAgentMemoryBackend } from '../src/agent/index.js';
import { receiptTextReply } from '../src/store/CommitmentReceipt.js';

const kernels: MemoryKernel[] = [];

function fresh(receiptsEnabled = true): { kernel: MemoryKernel; backend: KernelAgentMemoryBackend } {
  const kernel = createMemoryKernel({ dbPath: ':memory:', projectTimeZone: 'Asia/Tokyo', receiptsEnabled });
  kernels.push(kernel);
  return { kernel, backend: new KernelAgentMemoryBackend(kernel, { agentId: 'companion' }) };
}

afterAll(() => {
  for (const kernel of kernels) kernel.close();
});

const NOW = Date.UTC(2026, 10, 24, 0, 0);
const NEXT_MONDAY = Date.UTC(2026, 10, 30, 9, 0);

async function say(backend: KernelAgentMemoryBackend, projectId: string, text: string, now = NOW) {
  return backend.rememberTurnWithResult({
    agentId: 'companion',
    projectId,
    sessionId: `s-${projectId}`,
    turnId: `${projectId}:${now}`,
    userText: text,
    timestamp: now,
  });
}

describe('the immediate commitment receipt', () => {
  test('a promise gets a receipt whose due instant is the local Monday, not a week later', async () => {
    const { backend } = fresh();
    const result = await say(backend, 'receipt-due', '我下周一之前把方案发给你。');
    expect(result.receipt?.kind).toBe('commitment');
    expect(result.receipt?.provenance).toBe('rule_extraction');
    expect(result.receipt?.dueAt).toBe(NEXT_MONDAY);
    expect(result.receipt?.text).toContain('11/30 18:00 JST');
    expect(result.receipt?.text).toContain('[对] [只是打算，不用提醒] [别记]');
  });

  test('an ambiguous hedge defaults to a tentative commitment', async () => {
    const { backend } = fresh();
    const result = await say(backend, 'receipt-ambiguous', '我周五前应该能发你。');
    expect(result.receipt?.kind).toBe('commitment');
    expect(result.receipt?.confidence).toBe('tentative');
  });

  test('ordinary talk and a disabled switch produce no receipt', async () => {
    const { backend } = fresh();
    expect((await say(backend, 'receipt-miss', '今天好累。')).receipt).toBeUndefined();
    const { backend: disabled } = fresh(false);
    expect((await say(disabled, 'receipt-off', '我明天把文件发你。')).receipt).toBeUndefined();
  });

  test('one turn carries at most one receipt', async () => {
    const { backend } = fresh();
    const result = await say(backend, 'receipt-one', '我明天把文件发你。我后天把报告交给你。');
    expect(result.receipt?.kind).toBe('commitment');
    expect(result.receipt?.content).toContain('明天');
    expect(Array.isArray(result.receipt)).toBe(false);
  });
});

describe('the receipt actions', () => {
  test('confirm goes through CandidateReviewService and opens the commitment', async () => {
    const { kernel, backend } = fresh();
    const turn = await say(backend, 'receipt-confirm', '我明天把文件发你。');
    const result = kernel.reviewCommitmentReceipt({
      projectId: 'receipt-confirm',
      sourceEventId: turn.rawEventIds[0]!,
      action: 'confirm',
      now: NOW + 1_000,
    });
    expect(result.review.action).toBe('approve');
    expect(result.review.surface).toBe('receipt');
    expect(result.commitment?.content).toContain('文件');
  });

  test('just-a-plan goes through the same service and becomes a prospective intention', async () => {
    const { kernel, backend } = fresh();
    const turn = await say(backend, 'receipt-intention', '我明天把文件发你。');
    const result = kernel.reviewCommitmentReceipt({
      projectId: 'receipt-intention',
      sourceEventId: turn.rawEventIds[0]!,
      action: 'intention',
      now: NOW + 1_000,
    });
    expect(result.review.action).toBe('reject');
    expect(result.intention?.candidateType).toBe('intention');
  });

  test('confirming an ambiguous promise opens it instead of leaving the book empty', async () => {
    const { kernel, backend } = fresh();
    const turn = await say(backend, 'receipt-confirm-ambiguous', '我周五前应该能发你。');
    const result = kernel.reviewCommitmentReceipt({
      projectId: 'receipt-confirm-ambiguous',
      sourceEventId: turn.rawEventIds[0]!,
      action: 'confirm',
      now: NOW + 1_000,
    });
    expect(result.commitment?.content).toContain('发你');
    expect(result.commitment?.confidence).toBe('tentative');
  });

  test('forget goes through the same service and leaves no open commitment', async () => {
    const { kernel, backend } = fresh();
    const turn = await say(backend, 'receipt-forget', '我明天把文件发你。');
    kernel.reviewCommitmentReceipt({
      projectId: 'receipt-forget',
      sourceEventId: turn.rawEventIds[0]!,
      action: 'forget',
      now: NOW + 1_000,
    });
    const open = kernel.commitments.list({ projectId: 'receipt-forget', now: NOW + 1_000 })
      .filter((entry) => entry.status !== 'cancelled' && entry.status !== 'completed');
    expect(open).toHaveLength(0);
  });

  test('plain text only redisplays the buttons', () => {
    expect(receiptTextReply('对')).toEqual({ redisplay: true });
    expect(receiptTextReply('只是打算')).toEqual({ redisplay: true });
    expect(receiptTextReply('别记')).toEqual({ redisplay: true });
    expect(receiptTextReply('明天见')).toBeUndefined();
  });
});

describe('the nightly classifier cannot silently reclassify a confirmed commitment', () => {
  test('a different class for the same evidence enters needs_confirmation', async () => {
    const { kernel, backend } = fresh();
    const projectId = 'receipt-nightly';
    const turn = await say(backend, projectId, '我明天把文件发你。');
    kernel.reviewCommitmentReceipt({
      projectId,
      sourceEventId: turn.rawEventIds[0]!,
      action: 'confirm',
      now: NOW + 1_000,
    });
    const store = (kernel as unknown as { deepWriteCandidateStore: {
      insertRun(input: Record<string, unknown>): { runId: string };
      insertCandidates(input: Array<Record<string, unknown>>): Array<{ status: string }>;
    } }).deepWriteCandidateStore;
    const run = store.insertRun({
      projectId,
      sourceNeuronIds: [],
      mode: 'receipt-test',
      promptHash: 'p',
      outputHash: 'o',
      status: 'succeeded',
      createdAt: NOW + 2_000,
    });
    const candidates = store.insertCandidates([{
      runId: run.runId,
      candidateType: 'temporal_fact_update',
      status: 'candidate',
      confidence: 0.9,
      content: { projectId, statement: '我明天把文件发你。' },
      evidence: [{ eventId: turn.rawEventIds[0] }],
      createdAt: NOW + 2_000,
    }]);
    expect(candidates[0]?.status).toBe('needs_confirmation');
  });
});

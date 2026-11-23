import type { CommitmentEntry } from '../commitment/index.js';
import { parseCommitmentDue } from '../commitment/index.js';
import { createHash } from 'node:crypto';
import type { ProspectiveMemoryRecord, ProspectiveMemoryService } from '../prospective/index.js';
import type { MemoryEvent } from '../types/index.js';
import type { CandidateReviewRecord, CandidateReviewStore } from './CandidateReviewStore.js';
import type { DeepWriteCandidateRecord, DeepWriteCandidateStore } from './DeepWriteCandidateStore.js';

export interface CommitmentReceiptReviewInput {
  projectId: string;
  sourceEventId: string;
  action: 'confirm' | 'intention' | 'forget';
  actor: string;
  content?: string;
  dueAt?: number;
  surface?: string;
}

export function recordCommitmentReceiptReview(
  candidates: DeepWriteCandidateStore,
  reviews: CandidateReviewStore,
  input: CommitmentReceiptReviewInput,
): CandidateReviewRecord {
  const action = input.action === 'confirm' ? 'approve' as const : 'reject' as const;
  const candidateId = `commitment-receipt:${input.sourceEventId}`;
  const candidate: DeepWriteCandidateRecord | null = candidates.getCandidate(candidateId);
  if (!candidate) {
    if (!candidates.getRun(candidateId)) {
      candidates.insertRun({
        runId: candidateId,
        projectId: input.projectId,
        sourceNeuronIds: [],
        mode: 'commitment_receipt',
        promptHash: candidateId,
        outputHash: candidateId,
        status: 'succeeded',
      });
    }
    candidates.insertCandidates([{
      candidateId,
      runId: candidateId,
      candidateType: 'commitment_receipt',
      status: 'needs_confirmation',
      confidence: 1,
      content: {
        projectId: input.projectId,
        sourceEventId: input.sourceEventId,
        statement: input.content,
        source: 'rule_extraction',
        dueAt: input.dueAt,
      },
      evidence: [{ eventId: input.sourceEventId, role: 'user' }],
    }]);
  }
  return reviews.insert({
    candidateId,
    projectId: input.projectId,
    action,
    actor: input.actor,
    reason: `commitment_receipt_${input.action}`,
    fromStatus: 'needs_confirmation',
    toStatus: action === 'approve' ? 'promoted' : 'rejected',
    surface: input.surface ?? 'receipt',
    decision: {
      kind: 'commitment_receipt',
      target: input.action,
      sourceEventId: input.sourceEventId,
      content: input.content,
      dueAt: input.dueAt,
    },
  });
}

export interface CommitmentReceiptKernelPorts {
  events: {
    getEvent(eventId: string): MemoryEvent | null;
    getProjectTimeZone(): string | undefined;
    append(input: {
      streamId: string;
      streamType: 'system';
      eventType: MemoryEvent['eventType'];
      projectId: string;
      sourceId?: string;
      occurredAt: number;
      payload: Record<string, unknown>;
    }): unknown;
  };
  commitments: {
    compile(input: { projectId: string; now: number }): unknown;
    list(input: { projectId: string; now: number }): CommitmentEntry[];
    cancel(input: { projectId: string; commitmentId: string; evidenceEventId: string; now: number }): unknown;
  };
  prospective: Pick<ProspectiveMemoryService, 'propose'>;
  review: { reviewCommitmentReceipt(input: CommitmentReceiptReviewInput): CandidateReviewRecord };
}

export function reviewKernelCommitmentReceipt(
  ports: CommitmentReceiptKernelPorts,
  input: CommitmentReceiptReviewInput & { now?: number },
): { review: CandidateReviewRecord; commitment?: CommitmentEntry; intention?: ProspectiveMemoryRecord } {
  const event = ports.events.getEvent(input.sourceEventId);
  if (!event || event.projectId !== input.projectId) throw new Error('invalid_commitment_evidence');
  const content = input.content ?? eventText(event.payload);
  const review = ports.review.reviewCommitmentReceipt({ ...input, content });
  const now = input.now ?? Date.now();
  if (input.action === 'confirm') {
    ports.commitments.compile({ projectId: input.projectId, now });
    const commitment = promiseFor(ports, input.projectId, input.sourceEventId, now)
      ?? openTentativeCommitment(ports, input, event, content, now);
    return { review, ...(commitment ? { commitment } : {}) };
  }
  if (input.action === 'intention') {
    const dueAt = input.dueAt ?? parseCommitmentDue(content, event.occurredAt, ports.events.getProjectTimeZone()).dueAt;
    const intention = ports.prospective.propose({
      projectId: input.projectId,
      candidateType: 'intention',
      canonicalKey: input.sourceEventId,
      title: content,
      evidenceEventIds: [input.sourceEventId],
      proposedBy: 'deterministic',
      dueAt,
    });
    return { review, intention };
  }
  ports.commitments.compile({ projectId: input.projectId, now });
  const commitment = promiseFor(ports, input.projectId, input.sourceEventId, now);
  if (commitment) {
    ports.commitments.cancel({
      projectId: input.projectId,
      commitmentId: commitment.commitmentId,
      evidenceEventId: input.sourceEventId,
      now,
    });
  }
  return { review };
}

function openTentativeCommitment(
  ports: CommitmentReceiptKernelPorts,
  input: CommitmentReceiptReviewInput,
  event: MemoryEvent,
  content: string,
  now: number,
): CommitmentEntry | undefined {
  if (!content) return undefined;
  const commitmentId = `commitment-${createHash('sha256')
    .update(`${input.projectId}\u0000${input.sourceEventId}\u00000`)
    .digest('hex').slice(0, 20)}`;
  const due = parseCommitmentDue(content, event.occurredAt, ports.events.getProjectTimeZone());
  ports.events.append({
    streamId: `commitment:${commitmentId}`,
    streamType: 'system',
    eventType: 'COMMITMENT_OPENED',
    projectId: input.projectId,
    sourceId: 'commitment',
    occurredAt: now,
    payload: {
      commitmentId,
      owner: event.role === 'assistant' || event.role === 'agent' ? 'agent' : 'user',
      content,
      dueAt: input.dueAt ?? due.dueAt,
      dueCondition: due.dueCondition,
      confidence: 'tentative',
      sourceRefs: [{ eventId: event.eventId }],
      openedAt: event.occurredAt,
      projectId: input.projectId,
      version: 1,
    },
  });
  return promiseFor(ports, input.projectId, input.sourceEventId, now);
}

function promiseFor(
  ports: CommitmentReceiptKernelPorts,
  projectId: string,
  sourceEventId: string,
  now: number,
): CommitmentEntry | undefined {
  return ports.commitments.list({ projectId, now })
    .find((entry) => entry.sourceRefs.some((ref) => ref.eventId === sourceEventId));
}

function eventText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

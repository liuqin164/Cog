import { createHash } from 'node:crypto';
import type Database from 'bun:sqlite';
import type { DeepWritePromotionDecision, DeepWritePromotionPolicy } from '../engine/DeepWritePromotionPolicy.js';
import type { MemoryEvent } from '../types/index.js';
import type { CandidateReviewAction, CandidateReviewRecord, CandidateReviewStore } from '../store/CandidateReviewStore.js';
import type { DeepWriteCandidateRecord, DeepWriteCandidateStore } from '../store/DeepWriteCandidateStore.js';
import { recordCommitmentReceiptReview, type CommitmentReceiptReviewInput } from '../store/CommitmentReceiptReview.js';

export interface CandidateReviewInput {
  candidateId: string;
  projectId: string;
  action: CandidateReviewAction;
  actor: string;
  reason: string;
  confirmationEventId?: string;
  targetBeliefId?: string;
  replacementCandidateId?: string;
  reviewAfter?: number;
  surface?: string;
  expectedContentHash?: string;
}

export interface CandidateReviewResult {
  review: CandidateReviewRecord;
  candidate: DeepWriteCandidateRecord;
  decision?: DeepWritePromotionDecision;
}

const CONSUMED_INPUTS: Record<CandidateReviewAction, readonly OptionalInputField[]> = {
  approve: ['confirmationEventId'],
  reject: [],
  defer: ['reviewAfter'],
  supersede: ['replacementCandidateId'],
  relink: ['confirmationEventId', 'targetBeliefId'],
};

const OPTIONAL_INPUT_FIELDS = ['confirmationEventId', 'targetBeliefId', 'replacementCandidateId', 'reviewAfter'] as const;

type OptionalInputField = typeof OPTIONAL_INPUT_FIELDS[number];

export class CandidateReviewService {
  constructor(
    private readonly db: Database,
    private readonly candidates: DeepWriteCandidateStore,
    private readonly reviews: CandidateReviewStore,
    private readonly promotion: DeepWritePromotionPolicy,
    private readonly eventLookup: (eventId: string) => MemoryEvent | null,
  ) {}

  reviewCommitmentReceipt(input: CommitmentReceiptReviewInput): CandidateReviewRecord {
    required(input.actor, 'actor');
    return recordCommitmentReceiptReview(this.candidates, this.reviews, input);
  }

  review(input: CandidateReviewInput): CandidateReviewResult {
    return this.db.transaction((): CandidateReviewResult => {
      const actor = required(input.actor, 'actor');
      const reason = required(input.reason, 'reason');
      assertConsumedInputs(input);
      const candidate = this.candidates.getCandidate(required(input.candidateId, 'candidateId'));
      if (!candidate) throw new Error('candidate_not_found');
      if (input.expectedContentHash !== undefined && candidateContentHash(candidate.content) !== input.expectedContentHash) {
        throw new Error('candidate_content_changed');
      }
      const run = this.candidates.getRun(candidate.runId);
      if (!run || run.projectId !== input.projectId) throw new Error('candidate_project_mismatch');
      if (candidate.status !== 'needs_confirmation') throw new Error('candidate_not_awaiting_confirmation');

      const fromStatus = candidate.status;
      let decision: DeepWritePromotionDecision | undefined;
      if (input.action === 'reject') {
        this.candidates.updateCandidateStatus(candidate.candidateId, 'rejected', { reason: `manual_review_rejected:${reason}` });
      } else if (input.action === 'defer') {
        if (!Number.isFinite(input.reviewAfter) || Number(input.reviewAfter) <= Date.now()) {
          throw new Error('review_after_must_be_in_the_future');
        }
        this.candidates.updateCandidateStatus(candidate.candidateId, 'needs_confirmation', {
          reason: `manual_review_deferred:${reason}`,
          reviewAfter: input.reviewAfter,
        });
      } else if (input.action === 'supersede') {
        const replacementCandidateId = input.replacementCandidateId?.trim();
        if (!replacementCandidateId) throw new Error('replacement_candidate_required');
        this.requireReplacement(replacementCandidateId, input.projectId, candidate.candidateId);
        this.candidates.updateCandidateStatus(candidate.candidateId, 'superseded', {
          type: 'replacement_candidate',
          id: replacementCandidateId,
          reason: `manual_review_superseded:${reason}`,
        });
      } else {
        const confirmation = this.requireUserConfirmation(input.confirmationEventId, input.projectId, candidate);
        let content = asObject(candidate.content);
        let targetType = candidate.promotionTargetType;
        let targetId = candidate.promotionTargetId;
        if (input.action === 'relink') {
          if (candidate.candidateType !== 'correction') throw new Error('relink_requires_correction_candidate');
          const belief = this.db.prepare(`SELECT id, canonical_key, project_id, status FROM beliefs WHERE id=?`).get(input.targetBeliefId || '') as {
            id: string; canonical_key: string; project_id?: string; status: string;
          } | null;
          if (!belief || belief.project_id !== input.projectId || belief.status !== 'active') {
            throw new Error('target_belief_not_active_in_project');
          }
          const previousTargets = [
            typeof content.targetBeliefId === 'string' ? content.targetBeliefId : null,
            ...(Array.isArray(content.correctedBeliefCandidateIds)
              ? content.correctedBeliefCandidateIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
              : []),
          ];
          const relinkedFrom = previousTargets.find((id): id is string => id !== null && id !== belief.id);
          content = {
            ...content,
            targetBeliefId: belief.id,
            correctedClaimKey: belief.canonical_key,
            correctedBeliefCandidateIds: [belief.id],
            correctionResolution: 'manual_relink',
            correctionResolutionReason: 'operator_target_belief',
            ...(relinkedFrom ? { relinkedFromBeliefId: relinkedFrom } : {}),
          };
          targetType = 'belief';
          targetId = belief.id;
        }
        const evidence = appendConfirmationEvidence(candidate.evidence, confirmation.eventId);
        this.candidates.updateCandidateReviewData(candidate.candidateId, {
          content,
          evidence,
          promotionTargetType: targetType,
          promotionTargetId: targetId,
          status: 'candidate',
          statusReason: `manual_review_${input.action}:${reason}`,
        });
        decision = this.promotion.evaluateAndApply(this.candidates.getCandidate(candidate.candidateId)!, { reviewConfirmed: true });
      }

      const reviewed = this.candidates.getCandidate(candidate.candidateId)!;
      const review = this.reviews.insert({
        candidateId: candidate.candidateId,
        projectId: input.projectId,
        action: input.action,
        actor,
        reason,
        fromStatus,
        toStatus: reviewed.status,
        confirmationEventId: input.confirmationEventId,
        targetBeliefId: input.targetBeliefId,
        replacementCandidateId: input.replacementCandidateId,
        reviewAfter: input.reviewAfter,
        surface: input.surface,
        decision: decision ? { ...decision } : {},
      });
      return { review, candidate: reviewed, decision };
    })();
  }

  private requireUserConfirmation(eventId: string | undefined, projectId: string, candidate: DeepWriteCandidateRecord): MemoryEvent {
    if (!eventId) throw new Error('confirmation_event_required');
    const event = this.eventLookup(eventId);
    if (!event) throw new Error('confirmation_event_not_found');
    if (event.projectId !== projectId) throw new Error('confirmation_event_project_mismatch');
    if (event.role !== 'user') throw new Error('confirmation_event_must_be_user');
    const evidenceIds = (Array.isArray(candidate.evidence) ? candidate.evidence : [])
      .map((item) => asObject(item).eventId)
      .filter((value): value is string => typeof value === 'string');
    if (evidenceIds.includes(event.eventId)) throw new Error('confirmation_requires_distinct_user_evidence');
    const evidenceSequences = evidenceIds.map((evidenceId) => this.eventLookup(evidenceId)?.globalSeq);
    if (event.globalSeq === undefined
      || evidenceSequences.some((sequence) => sequence === undefined)
      || event.globalSeq <= Math.max(...evidenceSequences as number[])) {
      throw new Error('confirmation_must_follow_proposal_evidence');
    }
    const priorUse = this.db.prepare(`
      SELECT candidate_id FROM deep_write_candidate_reviews
      WHERE project_id = ? AND confirmation_event_id = ? AND candidate_id <> ?
      LIMIT 1
    `).get(projectId, event.eventId, candidate.candidateId);
    if (priorUse) throw new Error('confirmation_evidence_already_used');
    return event;
  }

  private requireReplacement(candidateId: string, projectId: string, reviewedCandidateId: string): void {
    if (candidateId === reviewedCandidateId) throw new Error('replacement_candidate_must_differ');
    const replacement = this.candidates.getCandidate(candidateId);
    const run = replacement ? this.candidates.getRun(replacement.runId) : null;
    if (!replacement || run?.projectId !== projectId) throw new Error('replacement_candidate_project_mismatch');
  }
}

function assertConsumedInputs(input: CandidateReviewInput): void {
  const consumed = new Set<string>(CONSUMED_INPUTS[input.action]);
  for (const field of OPTIONAL_INPUT_FIELDS) {
    const value = input[field];
    if (consumed.has(field) || value === undefined || value === null) continue;
    throw new Error(`review_input_not_applicable:${field}`);
  }
}

function appendConfirmationEvidence(value: unknown, eventId: string): unknown[] {
  const evidence = Array.isArray(value) ? [...value] : [];
  if (!evidence.some((item) => asObject(item).eventId === eventId)) evidence.push({ eventId, role: 'user', source: 'manual_review_confirmation' });
  return evidence;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field}_required`);
  return value.trim();
}

export function candidateContentHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content ?? null)).digest('hex');
}

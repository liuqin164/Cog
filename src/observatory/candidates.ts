import { CONFIRMATION_TTL_MS, type MemoryKernel } from '../factory.js';
import { candidateContentHash } from '../governance/CandidateReviewService.js';
import type {
  ObservatoryCandidate,
  ObservatoryCandidateFace,
  ObservatoryCandidateReviewInput,
} from './routes.js';

const LIST_LIMIT = 500;
const REVIEW_LIMIT = 5_000;

export interface ObservatoryCandidateFaceOptions {
  readOnly?: boolean;
}

export function createObservatoryCandidateFace(
  kernel: MemoryKernel,
  options: ObservatoryCandidateFaceOptions = {},
): ObservatoryCandidateFace {
  const pending = (projectId?: string, limit = REVIEW_LIMIT) => kernel.listDreamCandidates({
    projectId,
    statuses: ['needs_confirmation'],
    limit,
  });

  const reviewOne = (input: ObservatoryCandidateReviewInput) => {
    const candidate = pending(input.projectId).find((entry) => entry.candidateId === input.candidateId);
    if (!candidate) throw new Error('candidate_not_found');
    if (candidateContentHash(candidate.content) !== input.contentHash) throw new Error('candidate_content_changed');
    let confirmationEventId: string | undefined;
    if (input.action === 'promote') {
      confirmationEventId = kernel.eventStore.append({
        streamId: `observatory-candidate:${input.projectId}`,
        streamType: 'system',
        eventType: 'SHELL_STATE_RECORDED',
        projectId: input.projectId,
        role: 'user',
        payload: { kind: 'candidate_promote', surface: 'observatory', candidateId: input.candidateId },
      }).eventId;
    }
    return kernel.reviewDreamCandidate({
      candidateId: input.candidateId,
      projectId: input.projectId,
      action: input.action === 'promote' ? 'approve' : input.action,
      actor: 'owner',
      reason: input.reason?.trim() || 'reviewed_in_observatory',
      confirmationEventId,
      reviewAfter: input.reviewAfter,
      surface: 'observatory',
      expectedContentHash: input.contentHash,
    });
  };

  const refuseReadOnly = (): void => {
    if (options.readOnly) throw new Error('candidates_read_only_resident_running');
  };

  return {
    readOnly: options.readOnly,
    list: ({ projectId, limit = 100 }) => pending(projectId, Math.max(1, Math.min(limit, LIST_LIMIT)))
      .map((candidate): ObservatoryCandidate => ({
        ...candidate,
        expiresAt: candidate.updatedAt + CONFIRMATION_TTL_MS,
        contentHash: candidateContentHash(candidate.content),
      }))
      .sort((left, right) => left.expiresAt - right.expiresAt || left.createdAt - right.createdAt),
    review: (input) => {
      refuseReadOnly();
      return reviewOne(input);
    },
  };
}

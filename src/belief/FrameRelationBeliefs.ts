import type { MemoryFrameV1 } from '../semantic/MemoryFrameTypes.js';
import type { DeepWriteCandidateInput, DeepWriteCandidateRecord, DeepWriteCandidateStore } from '../store/DeepWriteCandidateStore.js';
import type { BeliefStore } from './BeliefStore.js';
import type { BeliefCandidate } from '../types/index.js';

const PROJECTED_RELATIONS = new Set(['LIKES', 'FRIEND_OF', 'FAMILY_OF', 'RELATED_TO']);

export interface FrameRelationCandidateResult {
  staged: number;
  skipped: Array<{ relation: string; reason: 'not_projected' | 'unresolved_node' | 'empty_label' | 'already_recorded' }>;
}

export function stageFrameRelationCandidates(
  candidateStore: DeepWriteCandidateStore,
  frame: MemoryFrameV1,
  now: number = Date.now(),
): FrameRelationCandidateResult {
  const runId = `frame-relation-${frame.frameId}`;
  const result: FrameRelationCandidateResult = { staged: 0, skipped: [] };
  if (candidateStore.getRun(runId)) {
    result.skipped.push({ relation: '*', reason: 'already_recorded' });
    return result;
  }
  const nodes = new Map(frame.nodes.map((node) => [node.frameNodeId, node]));
  const pending: Array<Omit<DeepWriteCandidateInput, 'runId'>> = [];
  for (const relation of frame.relations) {
    if (!PROJECTED_RELATIONS.has(relation.relationType)) {
      result.skipped.push({ relation: relation.relationType, reason: 'not_projected' });
      continue;
    }
    const source = nodes.get(relation.sourceFrameNodeId);
    const target = nodes.get(relation.targetFrameNodeId);
    if (!source || !target) {
      result.skipped.push({ relation: relation.relationType, reason: 'unresolved_node' });
      continue;
    }
    const subject = source.label.trim();
    const objectValue = target.label.trim();
    if (!subject || !objectValue) {
      result.skipped.push({ relation: relation.relationType, reason: 'empty_label' });
      continue;
    }
    const evidenceId = relation.evidenceEventIds[0] ?? frame.evidenceEventIds[0];
    pending.push({
      candidateType: 'relations',
      status: 'needs_confirmation',
      publishStatus: 'needs_confirmation',
      confidence: relation.confidence,
      content: {
        projectId: frame.projectId,
        from: subject,
        to: objectValue,
        fromType: source.dimension === 'actor' ? 'person' : source.dimension,
        toType: target.dimension === 'actor' ? 'person' : target.dimension,
        relationType: relation.relationType,
        source: 'llm_inference',
        frameId: frame.frameId,
        episodeId: frame.episodeId,
      },
      promotionTargetType: 'belief',
      evidence: [{ eventId: evidenceId }],
      createdAt: now,
    });
  }
  if (pending.length === 0) return result;
  candidateStore.insertRun({
    runId,
    projectId: frame.projectId,
    sourceNeuronIds: [],
    mode: 'frame_relation_candidate_v1',
    promptHash: frame.frameId,
    outputHash: String(frame.relations.length),
    status: 'succeeded',
    createdAt: now,
  });
  result.staged = candidateStore.insertCandidates(pending.map((candidate) => ({ ...candidate, runId }))).length;
  return result;
}

export function upsertFrameRelationBelief(
  beliefStore: BeliefStore,
  provenance: { projectId: string; neuronIds: string[]; eventIds: string[] },
  candidate: DeepWriteCandidateRecord,
  content: Record<string, unknown>,
): { beliefId?: string; reason?: string } {
  const text = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = content[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  const eventId = provenance.eventIds[0];
  const subject = text(['from', 'source', 'subject']);
  const value = text(['to', 'target', 'object']);
  const relationType = text(['relationType']) ?? 'RELATED_TO';
  if (!subject || !value || (!eventId && provenance.neuronIds.length === 0)) {
    return { reason: 'relation_missing_required_fields' };
  }
  const predicate = relationType === 'LIKES' ? 'preference.LIKES' : relationType;
  const validFrom = eventId ? beliefStore.eventOccurredAt(eventId) ?? candidate.createdAt : candidate.createdAt;
  const correctionProbe: BeliefCandidate = {
    projectId: provenance.projectId,
    scope: 'project',
    subject,
    predicate,
    objectValue: { raw: value, type: 'string' },
    confidence: candidate.confidence,
    sourceType: 'llm_inference',
    validFrom,
    extractionReason: relationType === 'LIKES' ? 'preference_signal' : 'explicit_user_statement',
    ...(relationType === 'LIKES' ? {} : { canonicalKeyDiscriminator: value }),
  };
  if (beliefStore.hasNewerOwnerCorrection(correctionProbe)) {
    return { reason: 'owner_corrected' };
  }

  const result = beliefStore.upsert({
    projectId: provenance.projectId,
    scope: 'project',
    subject,
    predicate,
    objectValue: { raw: value, type: 'string' },
    confidence: candidate.confidence,
    trustScore: Math.max(0.55, candidate.confidence),
    sourceNeuronId: provenance.neuronIds[0] ?? eventId,
    ...(eventId && beliefStore.eventInProject(eventId, provenance.projectId) ? { sourceEventId: eventId } : {}),
    sourceType: 'llm_inference',
    validFrom,
    extractionReason: relationType === 'LIKES' ? 'preference_signal' : 'explicit_user_statement',
    explanation: `frame relation in ${text(['episodeId']) ?? ''}`,
    metadata: {
      source: 'deep_write',
      reviewConfirmed: true,
      deep_write_candidate_id: candidate.candidateId,
      frameId: text(['frameId']),
      episodeId: text(['episodeId']),
    },
    ...(relationType === 'LIKES' ? {} : { canonicalKeyDiscriminator: value }),
  }, candidate.createdAt);
  return result.belief
    ? { beliefId: result.belief.id }
    : { reason: result.decision.rejectReason || 'belief_rejected_by_conflict_policy' };
}

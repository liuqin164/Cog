import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { ProposalLedger } from '../src/meta/ProposalLedger.js';
import type { PolicyProposal } from '../src/meta/types.js';

function makeProposal(overrides: Partial<PolicyProposal> = {}): PolicyProposal {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    proposedAt: overrides.proposedAt ?? Date.now(),
    category: overrides.category ?? 'benchmark_threshold',
    summary: overrides.summary ?? 'proposal',
    evidence: overrides.evidence ?? [{ traceEventId: 'evt-1', note: 'evidence' }],
    suggestedChange: overrides.suggestedChange ?? { action: 'adjust' },
    status: overrides.status ?? 'pending',
    evalReport: overrides.evalReport,
    approvedAt: overrides.approvedAt,
    appliedAt: overrides.appliedAt,
    rolledBackAt: overrides.rolledBackAt,
    rejectedAt: overrides.rejectedAt,
    previousValue: overrides.previousValue,
    evalPlan: overrides.evalPlan,
    riskLevel: overrides.riskLevel ?? 'medium',
    applyMode: overrides.applyMode ?? 'patch_only'
  };
}

describe('v0.9 integration acceptance', () => {
  test('ledger apply protects the approved precondition', () => {
    const ledger = new ProposalLedger(new Database(':memory:'));
    ledger.initSchema();
    const proposal = makeProposal({ status: 'passed_eval' });
    ledger.save(proposal);

    expect(() => ledger.apply(proposal.id, {})).toThrow(Error);
  });
});

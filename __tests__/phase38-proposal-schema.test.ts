import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { ProposalLedger } from '../src/meta/ProposalLedger.js';
import type { PolicyProposal } from '../src/meta/types.js';

function makeLedger(db = new Database(':memory:')): ProposalLedger {
  const ledger = new ProposalLedger(db);
  ledger.initSchema();
  return ledger;
}

function makeProposal(overrides: Partial<PolicyProposal> = {}): PolicyProposal {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    proposedAt: overrides.proposedAt ?? Date.now(),
    category: overrides.category ?? 'context_pack_policy',
    summary: overrides.summary ?? 'proposal summary',
    evidence: overrides.evidence ?? [{ traceEventId: 'evt-1', note: 'evidence #1' }],
    suggestedChange: overrides.suggestedChange ?? { action: 'adjust' },
    status: overrides.status ?? 'pending',
    evalReport: overrides.evalReport,
    appliedAt: overrides.appliedAt,
    rejectedAt: overrides.rejectedAt,
    evalPlan: overrides.evalPlan,
    riskLevel: overrides.riskLevel,
    applyMode: overrides.applyMode
  };
}

describe('Phase 38 proposal schema', () => {
  test('PolicyProposal supports evalPlan as an array', () => {
    const proposal: PolicyProposal = makeProposal({ evalPlan: ['memory_recall', 'fast_path'] });
    expect(Array.isArray(proposal.evalPlan)).toBe(true);
    expect(proposal.evalPlan).toEqual(['memory_recall', 'fast_path']);
  });

  test('PolicyProposal supports riskLevel enum values', () => {
    const proposal: PolicyProposal = makeProposal({ riskLevel: 'high' });
    expect(proposal.riskLevel).toBeDefined();
    expect(['low', 'medium', 'high']).toContain(proposal.riskLevel!);
  });

  test('PolicyProposal supports applyMode enum values', () => {
    const proposal: PolicyProposal = makeProposal({ applyMode: 'config' });
    expect(proposal.applyMode).toBeDefined();
    expect(['config', 'patch_only']).toContain(proposal.applyMode!);
  });

  test('save and get round-trip new proposal fields', () => {
    const ledger = makeLedger();
    const proposal = makeProposal({
      id: 'roundtrip',
      category: 'benchmark_threshold',
      evalPlan: ['memory_recall', 'fast_path', 'context_pack'],
      riskLevel: 'high',
      applyMode: 'patch_only'
    });

    ledger.save(proposal);

    expect(ledger.get('roundtrip')).toEqual(proposal);
  });

  test('list returns evalPlan as a deserialized array', () => {
    const ledger = makeLedger();
    ledger.save(makeProposal({
      id: 'list-1',
      proposedAt: 1,
      evalPlan: ['memory_recall', 'fast_path'],
      riskLevel: 'low',
      applyMode: 'config'
    }));
    ledger.save(makeProposal({
      id: 'list-2',
      proposedAt: 2,
      evalPlan: ['context_pack'],
      riskLevel: 'medium',
      applyMode: 'patch_only'
    }));

    const proposals = ledger.list();

    expect(proposals[0]?.evalPlan).toEqual(['context_pack']);
    expect(proposals[1]?.evalPlan).toEqual(['memory_recall', 'fast_path']);
    expect(Array.isArray(proposals[0]?.evalPlan)).toBe(true);
  });

  test('save writes default evalPlan when the proposal omits it', () => {
    const ledger = makeLedger();
    ledger.save(makeProposal({ id: 'default-eval-plan', evalPlan: undefined }));
    expect(ledger.get('default-eval-plan')?.evalPlan).toEqual(['memory_recall']);
  });

  test('save writes default riskLevel when the proposal omits it', () => {
    const ledger = makeLedger();
    ledger.save(makeProposal({ id: 'default-risk', riskLevel: undefined }));
    expect(ledger.get('default-risk')?.riskLevel).toBe('medium');
  });

  test('save writes default applyMode when the proposal omits it', () => {
    const ledger = makeLedger();
    ledger.save(makeProposal({ id: 'default-apply', applyMode: undefined }));
    expect(ledger.get('default-apply')?.applyMode).toBe('patch_only');
  });

  test('existing rows without new fields read back with defaults', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE meta_proposals (
        id TEXT PRIMARY KEY,
        proposed_at INTEGER NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        suggested_change TEXT NOT NULL,
        status TEXT NOT NULL,
        eval_report TEXT,
        applied_at INTEGER,
        rejected_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO meta_proposals (
        id,
        proposed_at,
        category,
        summary,
        evidence,
        suggested_change,
        status,
        eval_report,
        applied_at,
        rejected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-1',
      10,
      'risk_rule',
      'legacy proposal',
      JSON.stringify([{ traceEventId: 'evt-1', note: 'legacy' }]),
      JSON.stringify({ action: 'legacy' }),
      'pending',
      null,
      null,
      null
    );

    const ledger = new ProposalLedger(db);
    ledger.initSchema();
    const proposal = ledger.get('legacy-1');

    expect(proposal?.evalPlan).toEqual(['memory_recall']);
    expect(proposal?.riskLevel).toBe('medium');
    expect(proposal?.applyMode).toBe('patch_only');
  });

  test('migration adds new columns to an existing meta_proposals table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE meta_proposals (
        id TEXT PRIMARY KEY,
        proposed_at INTEGER NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        suggested_change TEXT NOT NULL,
        status TEXT NOT NULL,
        eval_report TEXT,
        applied_at INTEGER,
        rejected_at INTEGER
      );
    `);

    const ledger = new ProposalLedger(db);
    ledger.initSchema();

    const columns = db.prepare('PRAGMA table_info(meta_proposals)').all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    // initSchema() adds the v0.9 columns via ALTER TABLE on existing tables
    expect(columnNames).toContain('eval_plan');
    expect(columnNames).toContain('risk_level');
    expect(columnNames).toContain('apply_mode');
    expect(columnNames).toContain('approved_at');
    expect(columnNames).toContain('rolled_back_at');
    expect(columnNames).toContain('previous_value');
  });

  test('migration stays idempotent when initSchema runs twice', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE meta_proposals (
        id TEXT PRIMARY KEY,
        proposed_at INTEGER NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        suggested_change TEXT NOT NULL,
        status TEXT NOT NULL,
        eval_report TEXT,
        applied_at INTEGER,
        rejected_at INTEGER
      );
    `);

    const ledger = new ProposalLedger(db);
    ledger.initSchema();
    ledger.initSchema();

    const columns = db.prepare('PRAGMA table_info(meta_proposals)').all() as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === 'eval_plan')).toHaveLength(1);
    expect(columns.filter((column) => column.name === 'risk_level')).toHaveLength(1);
    expect(columns.filter((column) => column.name === 'apply_mode')).toHaveLength(1);
  });

  test('migration preserves legacy rows and allows saving new fields afterward', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE meta_proposals (
        id TEXT PRIMARY KEY,
        proposed_at INTEGER NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        suggested_change TEXT NOT NULL,
        status TEXT NOT NULL,
        eval_report TEXT,
        applied_at INTEGER,
        rejected_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO meta_proposals (
        id,
        proposed_at,
        category,
        summary,
        evidence,
        suggested_change,
        status,
        eval_report,
        applied_at,
        rejected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-2',
      20,
      'observation_filter',
      'legacy filter',
      JSON.stringify([{ traceEventId: 'evt-2', note: 'legacy row' }]),
      JSON.stringify({ url: 'https://legacy.example' }),
      'pending',
      null,
      null,
      null
    );

    const ledger = new ProposalLedger(db);
    ledger.initSchema();
    ledger.save(makeProposal({
      id: 'new-1',
      category: 'workspace_preference',
      evalPlan: ['memory_recall', 'session_continuity'],
      riskLevel: 'low',
      applyMode: 'config'
    }));

    expect(ledger.get('legacy-2')?.applyMode).toBe('patch_only');
    expect(ledger.get('new-1')?.applyMode).toBe('config');
  });

  test('list filter by category still works with the new schema columns', () => {
    const ledger = makeLedger();
    ledger.save(makeProposal({ id: 'cat-1', category: 'workspace_preference' }));
    ledger.save(makeProposal({ id: 'cat-2', category: 'capability_config' }));

    expect(ledger.list({ category: 'workspace_preference' }).map((proposal) => proposal.id)).toEqual(['cat-1']);
  });

  test('list filter by status still works with the new schema columns', () => {
    const ledger = makeLedger();
    ledger.save(makeProposal({ id: 'status-1', status: 'pending' }));
    ledger.save(makeProposal({ id: 'status-2', status: 'failed_eval' }));

    expect(ledger.list({ status: 'failed_eval' }).map((proposal) => proposal.id)).toEqual(['status-2']);
  });
});

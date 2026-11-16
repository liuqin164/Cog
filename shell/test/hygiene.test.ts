/**
 * #228 item 5: a self-written or self-learned proposal passes the hygiene gate before review.
 *
 * The fixtures are the acceptance surface: a normal small plugin reaches `pending_review`, a draft
 * carrying a secret or a hidden character is discarded whole, and a rule learned from outside waits
 * for the owner's answer through the existing `ask_user` suspension.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HYGIENE_MIN_SCORE,
  HygienePipeline,
  type HygieneOutcome,
  type SelfChangeProposalInput,
} from '../src/hygiene.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

function fixture(name: string): SelfChangeProposalInput {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/hygiene', name), 'utf8')) as SelfChangeProposalInput;
}

function gate(answer: () => { ok: boolean; text: string } = () => ({ ok: true, text: '已登记问题' })) {
  const records: Array<Record<string, unknown>> = [];
  const asked: Array<{ question: string; context?: string; approvalId?: string }> = [];
  const pipeline = new HygienePipeline({
    trace: { append: (kind, record) => { records.push({ kind, ...(record ?? {}) }); } },
    now: () => Date.UTC(2026, 0, 1, 12, 0, 0),
    askOwner: (input) => {
      asked.push(input);
      return answer();
    },
  });
  return { pipeline, records, asked };
}

function findingCodes(outcome: HygieneOutcome): string[] {
  return outcome.proposal.findings.map((finding) => finding.code);
}

describe('the hygiene gate checks a proposal before anyone reviews it', () => {
  test('a normal small self-written plugin passes checks and waits for the owner', () => {
    const { pipeline, records, asked } = gate();
    const outcome = pipeline.submit(fixture('small-plugin.json'));

    expect(outcome.proposal.status).toBe('awaiting_owner');
    expect(outcome.toxic).toBe(false);
    expect(outcome.proposal.requiresOwnerApproval).toBe(true);
    expect(findingCodes(outcome)).toEqual([]);
    expect(outcome.proposal.score).toBeGreaterThanOrEqual(HYGIENE_MIN_SCORE);
    expect(asked).toHaveLength(1);
    expect(asked[0].approvalId).toBe(outcome.proposal.id);
    expect(pipeline.isEffective(outcome.proposal.id)).toBe(false);

    // The audit carries the source, check verdict, score and disposition as separate records.
    expect(records.map((record) => record.kind)).toEqual([
      'hygiene_proposal_received',
      'hygiene_checked',
      'hygiene_scored',
      'hygiene_owner_asked',
      'hygiene_disposition',
    ]);
    expect(records[0]).toMatchObject({ kind: 'hygiene_proposal_received', origin: 'self', proposalKind: 'plugin' });
    expect(records[1]).toMatchObject({ kind: 'hygiene_checked', passed: true });
    expect(records[2]).toMatchObject({ kind: 'hygiene_scored', threshold: HYGIENE_MIN_SCORE });
    expect(records[4]).toMatchObject({ kind: 'hygiene_disposition', status: 'awaiting_owner', origin: 'self' });

    // Approval is what the applier will look for; it still changes nothing by itself.
    pipeline.answer(outcome.proposal.id, '批准');
    expect(pipeline.get(outcome.proposal.id)?.status).toBe('approved');
    expect(pipeline.isEffective(outcome.proposal.id)).toBe(false);
  });

  test('a secret discards the whole proposal and the trace never copies the secret', () => {
    const { pipeline, records } = gate();
    const outcome = pipeline.submit(fixture('secret-plugin.json'));

    expect(outcome.proposal.status).toBe('discarded');
    expect(outcome.toxic).toBe(true);
    expect(findingCodes(outcome)).toContain('secret_detected');
    expect(pipeline.get(outcome.proposal.id)?.files).toHaveLength(1);
    expect(records.some((record) => record.kind === 'hygiene_disposition' && record.status === 'discarded')).toBe(true);

    // A finding names the pattern and location, not the matched value.
    expect(outcome.proposal.findings.some((finding) => finding.code === 'secret_detected' && finding.path === 'plugins/bad.ts')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz012345');
  });

  test('a hidden character discards the whole proposal even when the rest is a rule', () => {
    const { pipeline, records } = gate();
    const outcome = pipeline.submit(fixture('hidden-char-rule.json'));

    expect(outcome.proposal.status).toBe('discarded');
    expect(outcome.toxic).toBe(true);
    expect(findingCodes(outcome)).toContain('hidden_character');
    expect(records.some((record) => record.kind === 'hygiene_disposition' && record.status === 'discarded')).toBe(true);
  });

  test('a diff over the machine-checked small-change cap is rejected before review', () => {
    const { pipeline } = gate();
    const outcome = pipeline.submit(fixture('oversized-diff.json'));

    expect(outcome.proposal.status).toBe('rejected');
    expect(findingCodes(outcome)).toContain('diff_too_large');
    expect(outcome.proposal.score).toBeGreaterThan(0);
  });

  test('a proposal inside the hard limits but below the score threshold is filtered out', () => {
    const { pipeline } = gate();
    const input: SelfChangeProposalInput = {
      kind: 'rule',
      origin: 'self',
      reason: '这是一条理由很短但形状合法的规则提案。',
      files: Array.from({ length: 5 }, (_, index) => ({ path: `rules/note-${index}.md`, content: 'x'.repeat(4_000) })),
      diff: { added: 250, removed: 0, files: 5 },
      rollback: '删除这些规则文件',
    };
    const outcome = pipeline.submit(input);

    expect(outcome.proposal.status).toBe('rejected');
    expect(outcome.proposal.score).toBeLessThan(HYGIENE_MIN_SCORE);
    expect(outcome.summary).toContain('score_below_threshold');
  });
});

describe('an external rule waits for the owner and cannot become effective first', () => {
  test('the question is opened through the pause face and only an affirmative answer activates the rule', () => {
    const { pipeline, records, asked } = gate();
    const outcome = pipeline.submit(fixture('external-rule.json'));

    expect(outcome.proposal.status).toBe('awaiting_owner');
    expect(outcome.proposal.requiresOwnerApproval).toBe(true);
    expect(outcome.needsOwner).toBe(true);
    expect(pipeline.isEffective(outcome.proposal.id)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toContain('外部来源（web）');
    expect(asked[0].approvalId).toBe(outcome.proposal.id);
    expect(records.some((record) => record.kind === 'hygiene_owner_asked')).toBe(true);

    // Still nothing happens until the owner's line comes back.
    expect(pipeline.isEffective(outcome.proposal.id)).toBe(false);

    pipeline.answer(outcome.proposal.id, '批准');
    expect(pipeline.get(outcome.proposal.id)?.status).toBe('active');
    expect(pipeline.isEffective(outcome.proposal.id)).toBe(true);
    expect(records.some((record) => record.kind === 'hygiene_owner_approved')).toBe(true);
  });

  test('a refusal or an ambiguous answer leaves the rule discarded, never active', () => {
    for (const answer of ['拒绝', '不用了', '好像可以但再说']) {
      const { pipeline } = gate();
      const outcome = pipeline.submit(fixture('external-rule.json'));
      pipeline.answer(outcome.proposal.id, answer);
      expect(pipeline.get(outcome.proposal.id)?.status).toBe('discarded');
      expect(pipeline.isEffective(outcome.proposal.id)).toBe(false);
    }
  });

  test('an autonomous run has nobody to answer, so the external rule is rejected up front', () => {
    const { pipeline, asked } = gate(() => ({ ok: false, text: 'ask_user_unavailable' }));
    const outcome = pipeline.submit(fixture('external-rule.json'));

    expect(asked).toHaveLength(1);
    expect(outcome.ownerUnavailable).toBe(true);
    expect(outcome.proposal.status).toBe('rejected');
    expect(pipeline.isEffective(outcome.proposal.id)).toBe(false);
  });
});

describe('the shell exposes the gate through one recording tool', () => {
  function recording(input: Record<string, unknown>): ScriptedProvider {
    return new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'h1', toolName: 'propose_self_change', input }] },
      { text: '记录好了。', toolCalls: [] },
    ]);
  }

  function toolOutput(provider: ScriptedProvider): string {
    return provider.calls[1]?.messages.find((entry) => entry.role === 'tool')?.content ?? '';
  }

  function proposalId(shell: ReturnType<typeof makeShell>): string {
    const record = shell.trace.read().find((entry) => entry.kind === 'hygiene_proposal_received');
    return String(record?.id);
  }

  test('a normal plugin proposal pauses for the owner and still changes nothing', async () => {
    const provider = recording(fixture('small-plugin.json') as unknown as Record<string, unknown>);
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      await shell.submit('给自己加一个小插件');
      expect(toolOutput(provider)).toContain('proposal_awaiting_owner');
      expect(shell.state).toBe('SUSPENDED');
      const id = proposalId(shell);
      expect(shell.hygiene.get(id)?.status).toBe('awaiting_owner');
      expect(shell.hygiene.isEffective(id)).toBe(false);
      expect(shell.host.tools.has('propose_self_change')).toBe(true);
      expect(shell.host.tools.has('apply_self_change')).toBe(true);

      await shell.submit('批准');
      expect(shell.hygiene.get(id)?.status).toBe('approved');
      expect(shell.hygiene.isEffective(id)).toBe(false);
      expect(shell.trace.read().some((record) => record.kind === 'hygiene_owner_approved')).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an external rule suspends the run and the owner answer is the activation event', async () => {
    const provider = recording(fixture('external-rule.json') as unknown as Record<string, unknown>);
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      await shell.submit('网页上的这条规矩要不要留下');
      expect(shell.state).toBe('SUSPENDED');
      const suspension = shell.machine.runtime.suspension;
      expect(suspension?.kind).toBe('question');
      expect(suspension?.question?.approvalId).toBe(proposalId(shell));
      expect(shell.currentStatus().suspended?.text).toContain('外部来源');

      const id = proposalId(shell);
      expect(shell.hygiene.get(id)?.status).toBe('awaiting_owner');
      expect(shell.hygiene.isEffective(id)).toBe(false);

      await shell.submit('批准');
      expect(shell.state).toBe('IDLE');
      expect(shell.hygiene.get(id)?.status).toBe('active');
      expect(shell.hygiene.isEffective(id)).toBe(true);
      expect(shell.trace.read().some((record) => record.kind === 'hygiene_owner_approved')).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the owner saying no leaves the external rule discarded', async () => {
    const provider = recording(fixture('external-rule.json') as unknown as Record<string, unknown>);
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      await shell.submit('网页上的这条规矩要不要留下');
      expect(shell.state).toBe('SUSPENDED');
      const id = proposalId(shell);
      await shell.submit('拒绝');
      expect(shell.hygiene.get(id)?.status).toBe('discarded');
      expect(shell.hygiene.isEffective(id)).toBe(false);
      expect(shell.trace.read().some((record) => record.kind === 'hygiene_owner_declined')).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a toxic plugin never becomes a proposal the owner can approve', async () => {
    const provider = recording(fixture('secret-plugin.json') as unknown as Record<string, unknown>);
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      await shell.submit('给自己写个插件');
      expect(toolOutput(provider)).toContain('proposal_discarded');
      const id = proposalId(shell);
      expect(shell.hygiene.get(id)?.status).toBe('discarded');
      expect(shell.hygiene.isEffective(id)).toBe(false);
      expect(shell.state).toBe('IDLE');
      expect(shell.trace.read().some((record) => record.kind === 'hygiene_disposition' && record.status === 'discarded')).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

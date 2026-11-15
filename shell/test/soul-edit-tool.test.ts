import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const original = 'soul v0：先做自己。\n';
const proposed = 'soul v1：把话说短些。\n';

function drafting(input: Record<string, unknown>): ScriptedProvider {
  return new ScriptedProvider([
    { text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'propose_soul_edit', input }] },
    { text: '我把草稿放在星海里了。', toolCalls: [] },
  ]);
}

/** The tool result the model read on the turn after the call. */
function toolOutput(provider: ScriptedProvider): string {
  const message = provider.calls[1]?.messages.find((entry) => entry.role === 'tool');
  return message?.content ?? '';
}

describe('the agent drafts a soul edit through the tool surface (#218)', () => {
  test('the tool stores a draft, the current version stays put, and only the owner save appends', async () => {
    const provider = drafting({
      content: proposed,
      reason: '缩短',
      sourceRefs: ['evt-user-1'],
      counterexample: '用户也说过喜欢现在的长版本。',
    });
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      shell.kernel.soul.ensureDefault(shell.config.agentId, original);
      const pinnedBefore = shell.systemPromptSections().pinned;
      expect(shell.host.tools.has('propose_soul_edit')).toBe(true);

      await shell.submit('soul 能短一点吗');

      // The call reached the registered tool, and the result says it is a draft, unchanged for now.
      expect(toolOutput(provider)).toContain('proposal_drafted');
      expect(toolOutput(provider)).toContain('当前版本未变');

      // Draft visible, current version and pinned lane untouched, and the audit row exists.
      const draft = shell.backend.soul();
      expect(draft.current?.content).toBe(original);
      expect(draft.versions.map((version) => version.version)).toEqual([0]);
      expect(draft.proposal?.content).toBe(proposed);
      expect(draft.proposal?.reason).toBe('缩短');
      expect(draft.proposal?.sourceRefs).toEqual(['evt-user-1']);
      expect(draft.proposal?.diff).toBe('-soul v0：先做自己。\n+soul v1：把话说短些。');
      expect(draft.proposal?.counterexample).toBe('用户也说过喜欢现在的长版本。');
      const auditRow = shell.kernel.soul.audit(shell.config.agentId).find((row) => row.action === 'soul_edit_proposed');
      expect(auditRow?.reason).toBe('缩短');
      expect(shell.systemPromptSections().pinned.startsWith(original)).toBe(true);
      expect(shell.systemPromptSections().pinned).toBe(pinnedBefore);

      // No tool on this face can apply it: the registered set has no save or approve entry.
      expect(shell.host.tools.list().map((tool) => tool.name).filter((name) => /soul/i.test(name))).toEqual(['propose_soul_edit']);

      // The owner's approval is the save, and it appends a version that reaches the next turn.
      shell.kernel.soul.save({
        agentId: shell.config.agentId,
        content: draft.proposal!.content,
        actor: 'user',
        reason: 'approved',
      });
      expect(shell.backend.soul().current?.content).toBe(proposed);
      expect(shell.backend.soul().versions.map((version) => version.version)).toEqual([1, 0]);
      expect(shell.systemPromptSections().pinned.startsWith(proposed)).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a proposal with no ledger evidence is refused at registration and never becomes pending (#237)', async () => {
    const provider = drafting({ content: proposed, reason: '我觉得这样更好' });
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      shell.kernel.soul.ensureDefault(shell.config.agentId, original);
      await shell.submit('soul 能短一点吗');

      expect(toolOutput(provider)).toContain('soul_source_refs_required');
      expect(shell.backend.soul().proposal).toBeUndefined();
      expect(shell.kernel.soul.audit(shell.config.agentId).some((row) => row.action === 'soul_edit_proposed')).toBe(false);
      expect(shell.backend.soul().current?.content).toBe(original);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a declared no-counterexample search scope satisfies the evidence rule', async () => {
    const provider = drafting({
      content: proposed,
      reason: '缩短',
      sourceRefs: ['evt-user-1'],
      noCounterexampleScope: '本会话内搜索「长、详细、展开」，未发现相反偏好。',
    });
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      shell.kernel.soul.ensureDefault(shell.config.agentId, original);
      await shell.submit('soul 能短一点吗');

      expect(toolOutput(provider)).toContain('proposal_drafted');
      expect(shell.backend.soul().proposal?.noCounterexampleScope).toContain('未发现');
      expect(shell.backend.soul().proposal?.counterexample).toBeUndefined();
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a draft with no text is refused and writes no proposal', async () => {
    const provider = drafting({
      content: '   ',
      reason: 'empty',
      sourceRefs: ['evt-user-1'],
      counterexample: 'none',
    });
    const shell = makeShell(makeTempDir(), provider);
    await shell.start();
    try {
      shell.kernel.soul.ensureDefault(shell.config.agentId, original);
      await shell.submit('改一下 soul');

      expect(toolOutput(provider)).toContain('invalid_arguments');
      expect(shell.backend.soul().proposal).toBeUndefined();
      expect(shell.kernel.soul.audit(shell.config.agentId).some((row) => row.action === 'soul_edit_proposed')).toBe(false);
      expect(shell.backend.soul().current?.content).toBe(original);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

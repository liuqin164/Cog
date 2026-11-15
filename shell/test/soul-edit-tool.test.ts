import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const original = 'soul v0：先做自己。\n';
const proposed = 'soul v1：把话说短些。\n';

function drafting(content: string, reason: string): ScriptedProvider {
  return new ScriptedProvider([
    { text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'propose_soul_edit', input: { content, reason } }] },
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
    const provider = drafting(proposed, '缩短');
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

  test('a draft with no text is refused and writes no proposal', async () => {
    const provider = drafting('   ', 'empty');
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

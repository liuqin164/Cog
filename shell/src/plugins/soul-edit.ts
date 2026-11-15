/**
 * The agent's channel for drafting a soul edit: one tool, `propose_soul_edit`.
 *
 * It records a draft for the owner and returns; it never appends a soul version. The draft is stored
 * in the kernel's audit ledger and shown in the star-sea editor, where only the owner's save applies
 * it. F17's red line is unchanged: nothing on this face can write the current soul.
 */
import type { KernelAgentMemoryBackend } from 'cogmem';
import type { NativePlugin } from './host.ts';

function field(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

export function soulEditPlugin(): NativePlugin {
  return {
    name: 'soul-edit',
    inject: ['memory'],
    apply(ctx) {
      const backend = ctx.getService<KernelAgentMemoryBackend>('memory');
      ctx.registerTool({
        name: 'propose_soul_edit',
        description:
          'Draft a new soul (persona) for the owner to review. The full proposed text, a one-line reason, the ledger entries it is based on, and a counterexample (or the scope you searched when you found none) are stored as a draft; the registry computes the line diff against the current soul. The current soul is unchanged and no version is appended. Only the owner can approve it in the star-sea editor, so never say the edit is in effect.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The full proposed soul text, byte for byte' },
            reason: { type: 'string', description: 'One line telling the owner why the soul should change' },
            sourceRefs: {
              type: 'array',
              description: 'The ledger entries this proposal is based on: event ids when known, otherwise the exact user or assistant turn you are citing. At least one; never invent one.',
              items: { type: 'string' },
              minItems: 1,
            },
            counterexample: {
              type: 'string',
              description: 'At least one ledger fact that argues against this edit. Omit only when you state the search scope in noCounterexampleScope.',
            },
            noCounterexampleScope: {
              type: 'string',
              description: 'What you searched for counter-evidence, and that none was found. Use only when you found no counterexample.',
            },
          },
          required: ['content', 'reason', 'sourceRefs'],
        },
        execute({ args }): string {
          const content = field(args, 'content');
          const reason = field(args, 'reason').trim();
          if (content.trim() === '' || reason === '') {
            throw new Error('invalid_arguments: "content" and "reason" must be non-empty strings');
          }
          const rawRefs = (args as Record<string, unknown> | undefined)?.sourceRefs;
          if (!Array.isArray(rawRefs) || rawRefs.length === 0
            || rawRefs.some((ref) => typeof ref !== 'string' || ref.trim() === '')) {
            throw new Error('soul_source_refs_required: "sourceRefs" must name at least one ledger entry');
          }
          const counterexample = field(args, 'counterexample').trim() || undefined;
          const noCounterexampleScope = field(args, 'noCounterexampleScope').trim() || undefined;
          const proposal = backend.proposeSoulEdit({
            content,
            reason,
            sourceRefs: rawRefs.map((ref) => ref.trim()),
            ...(counterexample ? { counterexample } : {}),
            ...(noCounterexampleScope ? { noCounterexampleScope } : {}),
          });
          const evidence = proposal.counterexample
            ? '反例 1 条'
            : `无反例（检索范围：${proposal.noCounterexampleScope}）`;
          return `proposal_drafted: soul 草稿已交给用户审批（${proposal.bytes} 字节 / ${proposal.tokens} token；依据 ${proposal.sourceRefs.length} 条；${evidence}；diff 已附）。当前版本未变；只有用户在星海编辑器中保存后才会追加新版本。`;
        },
      });
    },
  };
}

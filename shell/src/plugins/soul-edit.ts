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
          'Draft a new soul (persona) for the owner to review. The full proposed text and a one-line reason are stored as a draft; the current soul is unchanged and no version is appended. Only the owner can approve it in the star-sea editor, so never say the edit is in effect.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The full proposed soul text, byte for byte' },
            reason: { type: 'string', description: 'One line telling the owner why the soul should change' },
          },
          required: ['content', 'reason'],
        },
        execute({ args }): string {
          const content = field(args, 'content');
          const reason = field(args, 'reason').trim();
          if (content.trim() === '' || reason === '') {
            throw new Error('invalid_arguments: "content" and "reason" must be non-empty strings');
          }
          const proposal = backend.proposeSoulEdit({ content, reason });
          return `proposal_drafted: soul 草稿已交给用户审批（${proposal.bytes} 字节 / ${proposal.tokens} token）。当前版本未变；只有用户在星海编辑器中保存后才会追加新版本。`;
        },
      });
    },
  };
}

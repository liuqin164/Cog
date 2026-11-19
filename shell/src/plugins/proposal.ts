import { PROPOSABLE_COMMANDS, type CommandProposals } from '../proposals.ts';
import type { NativePlugin, ToolOutcome } from './host.ts';

function field(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

export function proposalPlugin(): NativePlugin {
  return {
    name: 'command-proposals',
    inject: ['proposals'],
    apply(ctx) {
      const proposals = ctx.getService<CommandProposals>('proposals');
      ctx.registerTool({
        name: 'propose_command',
        description: `Offer the user exactly one shell command to run, with a one-line reason. The user confirms or discards it in the conversation; it never runs on its own, and it is one-shot. Only core shell commands may be offered (${PROPOSABLE_COMMANDS.map((command) => `/${command}`).join(', ')}); anything else is refused.`,
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Core command name, with or without the leading slash, e.g. "pause"' },
            args: { type: 'string', description: 'Optional argument for the command, e.g. a model route name' },
            reason: { type: 'string', description: 'One line telling the user why you are offering it' },
          },
          required: ['command', 'reason'],
        },
        execute({ args }): ToolOutcome {
          const command = field(args, 'command');
          const reason = field(args, 'reason').trim();
          if (command.trim() === '' || reason === '') {
            throw new Error('invalid_arguments: "command" and "reason" must be non-empty strings');
          }
          const { proposal, accepted } = proposals.propose({ command, args: field(args, 'args'), reason });
          const target = `/${proposal.command}${proposal.args === '' ? '' : ` ${proposal.args}`}`;
          if (!accepted) {
            return {
              output: `proposal_rejected: ${target} — ${proposal.rejectedReason ?? ''}`.trim(),
              isError: true,
            };
          }
          return {
            output: `proposal_offered: ${target} 已递给用户，等待确认或放弃（提议 ${proposal.id}）。它还没有执行；只有用户确认后才会按同一条命令路径执行。`,
            isError: false,
          };
        },
      });
    },
  };
}

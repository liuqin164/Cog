/**
 * The companion's one way to ask the owner something mid-run (#228): `ask_user`.
 *
 * The tool records a first-class suspended object and says the run ends there; the shell writes the
 * checkpointed suspension and the lifecycle leaves RUNNING. The owner's next line is delivered as
 * the answer event and the same assignment continues, so the question is not scattered through the
 * transcript with nothing holding it. An autonomous run has nobody to answer it, so the shell
 * refuses there and the model is told to finish with what it has.
 */
import type { NativePlugin, ToolOutcome } from './host.ts';

export interface AskUserHost {
  askUser(input: { question: string; context?: string }): { ok: boolean; text: string };
}

function field(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

export function askPlugin(): NativePlugin {
  return {
    name: 'ask-user',
    inject: ['shell'],
    apply(ctx) {
      const shell = ctx.getService<AskUserHost>('shell');
      ctx.registerTool({
        name: 'ask_user',
        description:
          'Ask the owner one question you cannot answer from memory or the workspace. Use it only when the answer changes what you do next: the run pauses here, the owner answers, and the same task continues. In an autonomous run there is nobody to answer, so the call is refused.',
        // A question is an observation with an effect on the lifecycle; a replay must not ask twice.
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The one question, in the owner\'s language' },
            context: { type: 'string', description: 'A short reference to what it is about (file, memory, task step)' },
          },
          required: ['question'],
        },
        execute({ args }): ToolOutcome {
          const question = field(args, 'question');
          if (question.trim() === '') throw new Error('invalid_arguments: "question" must be a non-empty string');
          const result = shell.askUser({ question, ...(field(args, 'context') ? { context: field(args, 'context') } : {}) });
          return { output: result.text, isError: !result.ok };
        },
      });
    },
  };
}

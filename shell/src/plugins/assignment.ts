/**
 * The task-boundary declaration (#246 A2).
 *
 * The shell attaches every new user message to the open assignment, because "is this a new task"
 * is a semantic judgement and guessing it from words is forbidden. The front model says it
 * explicitly here instead; the shell settles the old assignment and the trace keeps the shape.
 */
import type { NativePlugin, ToolOutcome } from './host.ts';

export interface AssignmentHost {
  declareTask(input: { action?: string; runId?: string }): { ok: boolean; text: string };
}

export function assignmentPlugin(): NativePlugin {
  return {
    name: 'assignment',
    inject: ['shell'],
    apply(ctx) {
      const shell = ctx.getService<AssignmentHost>('shell');
      ctx.registerTool({
        name: 'declare_task',
        description:
          'Declare a task boundary for the open assignment. Use action "start" only when the user\'s newest line begins work that is not a continuation of the open assignment, and "end" when that task is finished. Judge by meaning, not by a word: if the line continues the open work, do not call this tool.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'end'], description: 'start a different task, or end the open one' },
          },
          required: ['action'],
        },
        execute({ args, ctx }): ToolOutcome {
          const action = (args as Record<string, unknown> | undefined)?.action;
          const result = shell.declareTask({ action: typeof action === 'string' ? action : undefined, runId: ctx?.runId });
          return { output: result.text, isError: !result.ok };
        },
      });
    },
  };
}

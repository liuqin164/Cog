/**
 * The task-boundary declaration (#246 A2).
 *
 * The shell attaches every new user message to the open assignment, because "is this a new task"
 * is a semantic judgement and guessing it from words is forbidden. The front model says it
 * explicitly here instead; the shell settles the old assignment and the trace keeps the shape.
 */
import type { NativePlugin, ToolOutcome } from './host.ts';

export interface AssignmentHost {
  declareTask(input: { action?: string; runId?: string; domain?: string; key?: string; checklist?: boolean }): { ok: boolean; text: string };
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
          'Declare a task boundary for the open assignment. Use action "start" only when the user\'s newest line begins work that is not a continuation of the open assignment, and "end" when that task is finished. Judge by meaning, not by a word: if the line continues the open work, do not call this tool. '
          + 'When ending a task, also fill `domain` (the kind of work, e.g. "release" or "security review") and `key` (this practice\'s identity inside that domain). '
          + 'The practice book records the task\'s steps and tools from its real tool calls; do not write steps yourself. Leave domain/key empty and no practice is recorded.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'end'], description: 'start a different task, or end the open one' },
            domain: { type: 'string', description: 'for action "end": the task domain, filled by you' },
            key: { type: 'string', description: 'for action "end": this practice\'s identity inside the domain, filled by you' },
            checklist: { type: 'boolean', description: 'for action "end": true when this is a checklist that must be delivered whole' },
          },
          required: ['action'],
        },
        execute({ args, ctx }): ToolOutcome {
          const action = (args as Record<string, unknown> | undefined)?.action;
          const input = args as Record<string, unknown> | undefined;
          const result = shell.declareTask({
            action: typeof action === 'string' ? action : undefined,
            runId: ctx?.runId,
            ...(typeof input?.domain === 'string' ? { domain: input.domain } : {}),
            ...(typeof input?.key === 'string' ? { key: input.key } : {}),
            ...(input?.checklist === true ? { checklist: true } : {}),
          });
          return { output: result.text, isError: !result.ok };
        },
      });
    },
  };
}

/**
 * The cage: per-run turn and token budgets plus a tool whitelist, enforced at the hook points.
 *
 * The whitelist is a `beforeToolCall` veto, not a suggestion: a blocked call never executes and the
 * model receives a tool error it can read. Budget overrun forces the run out of RUNNING with a
 * `budget_exceeded` transition, so the loop cannot outlive the policy by claiming it is finished.
 */
import type { EventBus } from '../bus.ts';
import type { RunBudget } from '../state/agent-loop.ts';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin } from './host.ts';

export interface CageConfig {
  maxTurnsPerRun: number;
  maxTokensPerRun: number;
  toolWhitelist: string[] | null;
}

export class RunCage implements RunBudget {
  private tokens = 0;
  private runId?: string;

  constructor(private readonly config: CageConfig, private readonly trace?: TraceLog) {}

  beginRun(runId: string): void {
    this.runId = runId;
    this.tokens = 0;
  }

  checkTurn(turnIndex: number): { exceeded: boolean; reason?: string } {
    if (turnIndex > this.config.maxTurnsPerRun) {
      return { exceeded: true, reason: `turn_budget_exceeded: ${turnIndex} > ${this.config.maxTurnsPerRun}` };
    }
    return { exceeded: false };
  }

  addTokens(tokens: number): { exceeded: boolean; reason?: string } {
    this.tokens += tokens;
    if (this.tokens > this.config.maxTokensPerRun) {
      return { exceeded: true, reason: `token_budget_exceeded: ${this.tokens} > ${this.config.maxTokensPerRun}` };
    }
    return { exceeded: false };
  }

  toolAllowed(name: string): boolean {
    if (this.config.toolWhitelist === null) return true;
    return this.config.toolWhitelist.includes(name);
  }

  /** The registry-side half: every `beforeToolCall` is vetoed here, and the veto leaves a trace. */
  register(bus: EventBus): void {
    bus.on('beforeToolCall', (event: { toolName?: string; toolCallId?: string }) => {
      const name = event.toolName ?? '';
      if (this.toolAllowed(name)) return undefined;
      const reason = `tool_not_in_whitelist: "${name}" is not in [${(this.config.toolWhitelist ?? []).join(', ')}]`;
      this.trace?.append('cage_violation', { kind: 'tool_whitelist', runId: this.runId, toolName: name, reason });
      return { block: true, reason };
    });
  }
}

export function cagePlugin(config: CageConfig, trace?: TraceLog): NativePlugin {
  return {
    name: 'cage',
    provide: ['cage'],
    apply(ctx) {
      const cage = new RunCage(config, trace);
      cage.register(ctx.getService<EventBus>('eventBus'));
      ctx.provide('cage', cage);
    },
  };
}

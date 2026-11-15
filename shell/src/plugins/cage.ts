/**
 * The cage: per-run turn and token budgets plus a tool whitelist, enforced at the hook points.
 *
 * The whitelist is a `beforeToolCall` veto, not a suggestion: a blocked call never executes and the
 * model receives a tool error it can read. Budget overrun forces the run out of RUNNING with a
 * `budget_exceeded` transition, so the loop cannot outlive the policy by claiming it is finished.
 *
 * The cage owns the whole `cage_violation` vocabulary: all three overruns are recorded here, in one
 * shape, so the trace consumer reads the same fields whatever the policy was. The violation's name
 * goes in `violation`, not `kind`, because `kind` is the trace record's own field and a caller that
 * reuses the name has it silently overwritten (`TraceLog.append`).
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

/** Which numeric limits this run uses. The whitelist and every enforcement point stay shared. */
export type CageTier = 'work' | 'autonomous';

/** The one shape: `runId`, `reason`, `violation`, and exactly one detail field. */
export type CageViolation =
  | { violation: 'tool_whitelist'; toolName: string }
  | { violation: 'turn_budget'; turnIndex: number }
  | { violation: 'token_budget'; tokens: number };

export class RunCage implements RunBudget {
  private tokens = 0;
  private runId?: string;
  private limits: CageConfig;
  private tier: CageTier = 'autonomous';
  private lastViolation?: CageViolation;

  constructor(private readonly config: CageConfig, private readonly trace?: TraceLog, private readonly work: CageConfig = config) {
    this.limits = config;
  }

  /**
   * `grant` is the budget the owner approved at a pause (#228): it widens this one run's limits and
   * nothing else. The base still comes from `budgets.json`, so the policy file is never rewritten.
   */
  beginRun(runId: string, tier: CageTier = 'autonomous', grant?: { tokens: number; turns: number }): void {
    this.runId = runId;
    this.tier = tier;
    const base = tier === 'work' ? this.work : this.config;
    this.limits = grant
      ? { ...base, maxTurnsPerRun: base.maxTurnsPerRun + grant.turns, maxTokensPerRun: base.maxTokensPerRun + grant.tokens }
      : base;
    this.tokens = 0;
    this.lastViolation = undefined;
    // The tier is recorded once per run, before any turn, so a reader can tell which limits a
    // `cage_violation` was measured against without inferring it from the trigger.
    this.trace?.append('run_budget', {
      runId,
      tier,
      maxTurnsPerRun: this.limits.maxTurnsPerRun,
      maxTokensPerRun: this.limits.maxTokensPerRun,
      ...(grant ? { grantTokens: grant.tokens, grantTurns: grant.turns } : {}),
    });
  }

  /** The last overrun the cage recorded, so a pause names the cap it hit without parsing text. */
  get violation(): CageViolation | undefined {
    return this.lastViolation;
  }

  checkTurn(turnIndex: number): { exceeded: boolean; reason?: string } {
    if (turnIndex <= this.limits.maxTurnsPerRun) return { exceeded: false };
    return this.overrun({ violation: 'turn_budget', turnIndex }, `turn_budget_exceeded: ${turnIndex} > ${this.limits.maxTurnsPerRun}`);
  }

  addTokens(tokens: number): { exceeded: boolean; reason?: string } {
    this.tokens += tokens;
    if (this.tokens <= this.limits.maxTokensPerRun) return { exceeded: false };
    return this.overrun({ violation: 'token_budget', tokens: this.tokens }, `token_budget_exceeded: ${this.tokens} > ${this.limits.maxTokensPerRun}`);
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
      this.record({ violation: 'tool_whitelist', toolName: name }, reason);
      return { block: true, reason };
    });
  }

  private record(violation: CageViolation, reason: string): void {
    this.lastViolation = violation;
    this.trace?.append('cage_violation', { runId: this.runId, reason, ...violation });
  }

  /** An overrun is recorded once, here, and the loop gets its verdict from the same place. */
  private overrun(violation: CageViolation, reason: string): { exceeded: true; reason: string } {
    this.record(violation, reason);
    return { exceeded: true, reason };
  }
}

/**
 * How much more a paused work run needs (#228), measured from what it actually spent.
 *
 * The basis is the run's own numbers: `tokens / turns` is the observed cost of one turn, and the
 * grant is what the turns it still had left would cost at that rate. A run cut at the turn cap has
 * no turns left, so the grant is one more allowance of the same size. A run that reported no usage
 * at all has no rate to extrapolate, so the honest fallback is the base cap itself rather than a
 * made-up number.
 */
export function estimateBudgetGrant(input: { tokens: number; turns: number; limits: { maxTurnsPerRun: number; maxTokensPerRun: number } }): {
  tokens: number;
  turns: number;
  tokensPerTurn: number;
  basis: string;
} {
  const tokensPerTurn = input.turns > 0 ? input.tokens / input.turns : 0;
  const remainingTurns = Math.max(0, input.limits.maxTurnsPerRun - input.turns);
  const turns = remainingTurns > 0 ? remainingTurns : input.limits.maxTurnsPerRun;
  const tokens = tokensPerTurn > 0 ? Math.ceil(tokensPerTurn * turns) : input.limits.maxTokensPerRun;
  const basis =
    tokensPerTurn > 0
      ? `${input.tokens} tokens over ${input.turns} turn(s) ≈ ${Math.round(tokensPerTurn)}/turn; ${turns} turn(s) → ${tokens} tokens`
      : `no provider usage reported; one allowance of the base cap (${tokens} tokens)`;
  return { tokens, turns, tokensPerTurn, basis };
}

export function cagePlugin(config: CageConfig, trace?: TraceLog, work?: CageConfig): NativePlugin {
  return {
    name: 'cage',
    provide: ['cage'],
    apply(ctx) {
      const cage = new RunCage(config, trace, work);
      cage.register(ctx.getService<EventBus>('eventBus'));
      ctx.provide('cage', cage);
    },
  };
}

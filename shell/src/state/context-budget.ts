/**
 * Context accounting at the request boundary.
 *
 * Pi measures its live context with a chars/4 estimate and, when the provider reported one, anchors
 * on the last assistant usage, estimating only what came after it
 * (`core/compaction/compaction.js:110-135,201-252`). The shell keeps no usage on its messages and a
 * run assembles its context from scratch, so this is the from-scratch half of that estimate over
 * what the next request will actually carry: the system prompt, the tool declarations and the
 * messages. That number is what F14's budget controller will trim against and what the TUI's
 * context gauge reports, so it is measured where the request is built, not accumulated from events.
 *
 * This is a shell rule, not a Pi mechanism: Pi has no request-accounting hook, and its own estimate
 * omits tool schemas because the provider's usage already pays for them. When the provider reports
 * the prompt it actually charged, that number calibrates the next request's estimate: a tokenizer
 * that counts twice as many tokens as chars/4 must not leave the budget gauge half the real size.
 */
import type { AgentMessage } from './agent-loop.ts';

/** Pi's conservative heuristic (`compaction.js:201`), calibrated against provider usage below. */
const CHARS_PER_TOKEN = 4;

/** A reported/estimated deviation smaller than this is measurement noise, not a tokenizer change. */
export const CONTEXT_CALIBRATION_THRESHOLD = 0.2;

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ContextAccount {
  /** What the whole request carries, system prompt and tool schemas included. */
  totalTokens: number;
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  /** How many messages the projection holds, for the trace to say what the number is made of. */
  messages: number;
  byRole: Record<AgentMessage['role'], number>;
}

export interface ContextCalibration {
  factor: number;
  estimated: number;
  actual: number;
  adjusted: boolean;
}

/** Pi's `estimateTokens` for the shell's message shape: content, tool-call arguments, loadout deltas. */
export function estimateTokens(message: AgentMessage): number {
  let chars = message.content.length;
  for (const call of message.toolCalls ?? []) {
    chars += call.toolName.length + JSON.stringify(call.input ?? {}).length;
  }
  if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
  if (message.toolsRemoved) chars += JSON.stringify(message.toolsRemoved).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateTokens(message);
  return tokens;
}

/** Pure: the request's parts, each measured the way the provider will be billed for it. */
export function accountRequest(input: {
  messages: readonly AgentMessage[];
  systemPrompt: string;
  tools: readonly ToolDeclaration[];
}): ContextAccount {
  const byRole: ContextAccount['byRole'] = { user: 0, assistant: 0, tool: 0, system: 0 };
  let messageTokens = 0;
  for (const message of input.messages) {
    const tokens = estimateTokens(message);
    messageTokens += tokens;
    byRole[message.role] += tokens;
  }
  const systemTokens = Math.ceil(input.systemPrompt.length / CHARS_PER_TOKEN);
  const toolTokens = input.tools.reduce(
    (sum, tool) => sum + Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / CHARS_PER_TOKEN),
    0,
  );
  return {
    totalTokens: systemTokens + toolTokens + messageTokens,
    systemTokens,
    toolTokens,
    messageTokens,
    messages: input.messages.length,
    byRole,
  };
}

/**
 * The provider's reported prompt count divided by the chars/4 estimate, kept per model. The first
 * request of a model runs at factor 1; after a report deviates by more than the threshold, the next
 * request is measured through the new factor. A within-threshold report leaves the factor alone, so
 * a single noisy turn does not move the budget.
 */
export class ContextCalibrator {
  private readonly factors = new Map<string, number>();

  factor(model: string): number {
    return this.factors.get(model) ?? 1;
  }

  calibrate(model: string, account: ContextAccount): ContextAccount {
    const factor = this.factor(model);
    if (factor === 1) return account;
    const scale = (tokens: number) => Math.round(tokens * factor);
    const systemTokens = scale(account.systemTokens);
    const toolTokens = scale(account.toolTokens);
    const messageTokens = scale(account.messageTokens);
    return {
      totalTokens: systemTokens + toolTokens + messageTokens,
      systemTokens,
      toolTokens,
      messageTokens,
      messages: account.messages,
      byRole: {
        user: scale(account.byRole.user),
        assistant: scale(account.byRole.assistant),
        tool: scale(account.byRole.tool),
        system: scale(account.byRole.system),
      },
    };
  }

  observe(model: string, estimated: number, actual: number | undefined): ContextCalibration | undefined {
    if (actual === undefined || actual <= 0 || estimated <= 0) return undefined;
    const factor = this.factor(model);
    const corrected = Math.round(estimated * factor);
    const deviation = Math.abs(actual - corrected) / Math.max(1, corrected);
    if (deviation <= CONTEXT_CALIBRATION_THRESHOLD) return undefined;
    const next = actual / estimated;
    this.factors.set(model, next);
    return { factor: next, estimated, actual, adjusted: true };
  }
}

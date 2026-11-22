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
 *
 * The first estimate is the kernel's character-class estimate (#318), not chars/4: ASCII costs
 * 0.25 token/char and non-ASCII 0.64, so a Chinese request no longer reports about half its real
 * prompt size. The calibrator still anchors on the provider's report afterwards.
 */
import type { AgentMessage } from './agent-loop.ts';
import { sessionTokens } from 'cogmem';

/** A reported/estimated deviation smaller than this is measurement noise, not a tokenizer change. */
export const CONTEXT_CALIBRATION_THRESHOLD = 0.2;
const CONTEXT_CALIBRATION_MIN = 0.5;
const CONTEXT_CALIBRATION_MAX = 2;

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
  /** The part of `messageTokens` that is tool output, the request's unbounded lane (#319). */
  toolOutputTokens: number;
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
  let text = message.content;
  for (const call of message.toolCalls ?? []) {
    text += call.toolName + JSON.stringify(call.input ?? {});
  }
  if (message.toolsAdded) text += JSON.stringify(message.toolsAdded);
  if (message.toolsRemoved) text += JSON.stringify(message.toolsRemoved);
  return sessionTokens(text);
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
  const systemTokens = sessionTokens(input.systemPrompt);
  const toolTokens = input.tools.reduce(
    (sum, tool) => sum + sessionTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    0,
  );
  return {
    totalTokens: systemTokens + toolTokens + messageTokens,
    systemTokens,
    toolTokens,
    messageTokens,
    toolOutputTokens: byRole.tool,
    messages: input.messages.length,
    byRole,
  };
}

/** One tool result's cap, in the character-class unit (`sessionTokens`, #318). */
export const TOOL_RESULT_TOKEN_LIMIT = 2_000;
/** All in-run tool output's cap; the rest of the lane budget is not available to it (#319). */
export const TOOL_OUTPUT_TOKEN_LIMIT = 4_000;
/** Lane headroom held back so the newest tool result is never squeezed to a stub (#439). */
export const TOOL_RESULT_RESERVE = TOOL_RESULT_TOKEN_LIMIT;

export interface ToolOutputAccount {
  /** The stated whole-request ceiling; absent when the caller did not state one. */
  requestBudgetTokens?: number;
  /** The raw tool output before folding, so a report can say what the ceiling removed. */
  rawTokens: number;
  /** The tool output the request now carries (bodies plus fold stubs). */
  toolOutputTokens: number;
  /** How many tool results were truncated or replaced by a stub. */
  foldedResults: number;
  /** The whole request after fitting, measured against `requestBudgetTokens` when stated. */
  totalTokens: number;
  overBudgetTokens: number;
}

export interface FittedRequest {
  messages: AgentMessage[];
  toolOutput: ToolOutputAccount;
}

/**
 * Bind a request's tool output to a stated size (#319).
 *
 * Lane assembly runs before the loop, so it cannot see the results the model itself appends. This is
 * the request-boundary rule: the newest results keep their place (the model is still working on them),
 * older ones become a stub, and anything past the two caps is cut at the head. Nothing is deleted — the
 * transcript and its `context_edit`-compatible shape keep the full text; only this request's copy is
 * re-assembled. Deterministic because it reads only message order, content and the call inputs already
 * in the transcript.
 */
export function fitRequestToBudget(input: {
  messages: readonly AgentMessage[];
  systemPrompt: string;
  tools: readonly ToolDeclaration[];
  budgetTokens?: number;
  scale?: number;
  perResultTokens?: number;
  toolOutputTokens?: number;
}): FittedRequest {
  const perResult = input.perResultTokens ?? TOOL_RESULT_TOKEN_LIMIT;
  const turnLimit = input.toolOutputTokens ?? TOOL_OUTPUT_TOKEN_LIMIT;
  const scale = input.scale && input.scale > 0 ? input.scale : 1;
  const budget = input.budgetTokens === undefined ? undefined : input.budgetTokens / scale;
  const indexes = input.messages
    .map((message, index) => message.role === 'tool' ? index : -1)
    .filter((index) => index >= 0);
  let rawTokens = 0;
  for (const index of indexes) rawTokens += estimateTokens(input.messages[index]!);
  if (indexes.length === 0) {
    return {
      messages: [...input.messages],
      toolOutput: {
        ...(input.budgetTokens === undefined ? {} : { requestBudgetTokens: input.budgetTokens }),
        rawTokens: 0,
        toolOutputTokens: 0,
        foldedResults: 0,
        totalTokens: accountRequest(input).totalTokens,
        overBudgetTokens: 0,
      },
    };
  }

  const calls = new Map<string, unknown>();
  for (const message of input.messages) {
    for (const call of message.toolCalls ?? []) calls.set(call.toolCallId, call.input);
  }
  const stubs = new Map<number, { content: string; tokens: number }>();
  for (const index of indexes) {
    const message = input.messages[index]!;
    const content = foldStub(message, calls.get(message.toolCallId ?? ''));
    stubs.set(index, { content, tokens: sessionTokens(content) });
  }
  const nonTool = accountRequest({
    messages: input.messages.filter((message) => message.role !== 'tool'),
    systemPrompt: input.systemPrompt,
    tools: input.tools,
  });
  const stubOverhead = [...stubs.values()].reduce((sum, stub) => sum + stub.tokens, 0);
  const bodyLimit = Math.max(0, turnLimit - stubOverhead);
  const ceiling = budget === undefined ? bodyLimit : Math.max(0, budget - nonTool.totalTokens - stubOverhead);
  let headRoom = Math.min(bodyLimit, ceiling);

  const contents = new Map<number, string>();
  let folded = 0;
  const newest = indexes.at(-1)!;
  for (const index of [...indexes].reverse()) {
    const message = input.messages[index]!;
    const raw = estimateTokens(message);
    const allow = index === newest
      ? Math.min(perResult, raw)
      : Math.max(0, Math.min(perResult, headRoom));
    if (raw <= allow) {
      headRoom -= raw;
      continue;
    }
    const stub = stubs.get(index)!;
    // A tiny result is smaller than its own stub. Rewriting it would grow the request; leave it.
    if (stub.tokens >= raw) continue;
    const head = headToTokens(message.content, allow - stub.tokens);
    contents.set(index, head.length === 0 ? stub.content : `${head}${stub.content}`);
    headRoom = Math.max(0, headRoom - Math.min(raw, sessionTokens(head)));
    folded += 1;
  }

  const messages = input.messages.map((message, index) => {
    const content = contents.get(index);
    return content === undefined ? message : { ...message, content };
  });
  const final = accountRequest({ messages, systemPrompt: input.systemPrompt, tools: input.tools });
  return {
    messages,
    toolOutput: {
      ...(input.budgetTokens === undefined ? {} : { requestBudgetTokens: input.budgetTokens }),
      rawTokens,
      toolOutputTokens: final.toolOutputTokens,
      foldedResults: folded,
      totalTokens: final.totalTokens,
      overBudgetTokens: budget === undefined ? 0 : Math.max(0, Math.round(final.totalTokens * scale - input.budgetTokens!)),
    },
  };
}

function foldStub(message: AgentMessage, input: unknown): string {
  const text = message.content;
  const chars = [...text].length;
  const tokens = estimateTokens(message);
  const tool = message.toolName ?? 'tool';
  const call = message.toolCallId ?? '?';
  const key = foldKey(message, input);
  const address = key === undefined
    ? `key: tool_call:${call} (full text is not addressable from here)`
    : `key: ${key} (re-read with the read tool)`;
  const marker = `[tool output folded: ${tool} ${call}; ${address}]`;
  // Below a few hundred tokens the counts cost more than they explain. Keep the marker compact so
  // folding a short result or error cannot make the request larger than the result was (#319).
  if (tokens < 400) return `\n\n${marker}`;
  return `\n\n[tool output folded: ${tool} ${call}, ${chars} chars / ~${tokens} tokens; ${address}]`;
}

function foldKey(message: AgentMessage, input: unknown): string | undefined {
  const path = input && typeof input === 'object' && 'path' in input
    ? (input as { path?: unknown }).path
    : undefined;
  if (typeof path === 'string' && path.trim() !== '') return path.trim();
  if (message.toolName === 'bash') {
    const pointer = /full output: ([^\])]+)\]/u.exec(message.content);
    if (pointer) return pointer[1]!.trim();
  }
  return undefined;
}

/**
 * The head of `text` whose character-class estimate fits `budget`. Walks code points, so the cut
 * cannot split a surrogate pair, and charges the same classes `sessionTokens` does.
 */
export function headToTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  let used = 0;
  let end = 0;
  for (const character of text) {
    const cost = character.codePointAt(0)! < 128 ? 0.25 : 0.64;
    if (Math.ceil(used + cost) > budget) break;
    used += cost;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * The provider's reported prompt count divided by the weighted estimate, kept per model. The first
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
      toolOutputTokens: scale(account.toolOutputTokens),
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
    const next = Math.min(CONTEXT_CALIBRATION_MAX, Math.max(CONTEXT_CALIBRATION_MIN, actual / estimated));
    this.factors.set(model, next);
    return { factor: next, estimated, actual, adjusted: true };
  }
}

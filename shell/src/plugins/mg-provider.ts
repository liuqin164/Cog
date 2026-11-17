/**
 * Model access through the mg gateway (magpie): one OpenAI-compatible endpoint, model
 * `auto/deepseek-v4.1-flash`.
 *
 * The provider is a plugin like any other; the core loop only knows `ModelProvider`. A failed call
 * throws, and the loop's failure ladder classifies it (`src/state/retry.ts`): overflow first, then
 * account limits, then a bounded exponential-backoff retry. There is still no fallback model.
 */
import type { AgentMessage, ModelCompletionInput, ModelProvider, ModelTurn, ToolCall, TurnUsage } from '../state/agent-loop.ts';
import type { NativePlugin } from './host.ts';
import { contentToText } from '../content.ts';
import { redactSecrets } from '../model/routes.ts';

export interface MgProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Bounded provider-side backoff (#282); tests shrink it, production uses the default. */
  retry?: Partial<ProviderRetryPolicy>;
  /** The account of each retry; the shell writes it to the trace so a recovered 429 is visible. */
  onRetry?: (event: { attempt: number; status: number; delayMs: number }) => void;
}

/**
 * The provider's own retry budget (#282): at most 3 calls (1 + 2 retries), exponential from 1 s to
 * 8 s, and no more than 30 s in requests and waits for one turn. The whole-turn timeout (#240) still
 * caps the call; this budget only spends part of it, and a 429 that outlasts it fails loudly instead
 * of looping. Non-retryable 4xx never enters this loop.
 */
export interface ProviderRetryPolicy {
  /** Total attempts, including the first call. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Wall-clock ceiling for retry waits; a request already in flight is bounded by `timeoutMs`. */
  maxTotalMs: number;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  maxTotalMs: 30_000,
};

/** 429 and the transient server answers; 501/505 are configuration or protocol failures. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

function toOpenAiMessages(messages: AgentMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.toolCallId,
          type: 'function',
          function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const entry = item as { id?: string; function?: { name?: string; arguments?: unknown } };
    let input: unknown = entry.function?.arguments ?? {};
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = { raw: input };
      }
    }
    return { toolCallId: entry.id ?? `call-${index}`, toolName: entry.function?.name ?? 'unknown', input };
  });
}

/** The usage block as endpoints actually spell it; every field is unknown until checked. */
export interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
  cached_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
}

/**
 * The one normalization of a provider's usage (#165 round 21). The cache field has three spellings
 * in the wild — DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, OpenAI/OpenRouter
 * `prompt_tokens_details.cached_tokens`, Kimi top-level `cached_tokens` — and `parseChunkUsage`
 * recognizes the same set (`pi-ai/dist/api/openai-completions.js:1153-1162`). Whichever the endpoint
 * sends is the one recorded; a field it did not send is left out rather than defaulted to zero.
 */
export function parseUsage(raw: RawUsage | undefined): TurnUsage | undefined {
  if (!raw) return undefined;
  const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const input = num(raw.prompt_tokens);
  const output = num(raw.completion_tokens);
  const cacheHit = num(raw.prompt_cache_hit_tokens) ?? num(raw.prompt_tokens_details?.cached_tokens) ?? num(raw.cached_tokens);
  const cacheMiss = num(raw.prompt_cache_miss_tokens);
  if (input === undefined && output === undefined && cacheHit === undefined && cacheMiss === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheHit !== undefined ? { cacheHit } : {}),
    ...(cacheMiss !== undefined ? { cacheMiss } : {}),
  };
}

export class MgModelProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;

  constructor(private readonly config: MgProviderConfig, name = 'mg') {
    this.name = name;
    this.model = config.model;
  }

  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    const url = `${this.config.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    const retry = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...this.config.retry };
    // One cap covers every attempt and the waits between them, so #240's fast failure is unchanged.
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const startedAt = Date.now();
    let text = '';
    let response: Response;
    for (let attempt = 1; ; attempt += 1) {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'system', content: input.systemPrompt }, ...toOpenAiMessages(input.messages)],
          tools: input.tools.length
            ? input.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              }))
            : undefined,
          tool_choice: input.tools.length ? 'auto' : undefined,
        }),
        signal,
      });
      text = await response.text();
      if (response.ok) break;
      const elapsed = Date.now() - startedAt;
      const budgetLeft = retry.maxTotalMs - elapsed;
      const retryable = RETRYABLE_STATUS.has(response.status);
      if (!retryable || attempt >= retry.maxAttempts || budgetLeft <= 0) {
        // Some endpoints echo the request (and its Authorization header) back in an error body. The
        // key is a known secret here, so it is stripped before the message reaches a trace.
        const account = attempt > 1 ? ` (provider_retry: attempts=${attempt}, elapsedMs=${elapsed})` : '';
        throw new Error(redactSecrets(`mg_gateway_error: ${response.status} ${text.slice(0, 400)}${account}`, [this.config.apiKey]));
      }
      const exponential = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
      const requested = retryAfterMs(response.headers.get('retry-after'), Date.now()) ?? exponential;
      const delayMs = Math.min(requested, retry.maxDelayMs, budgetLeft);
      this.config.onRetry?.({ attempt, status: response.status, delayMs });
      try {
        await sleepAbortable(delayMs, signal);
      } catch {
        // The timeout signal and the user's abort are different outcomes: the first is #240's
        // whole-turn cap and must keep its name, the second is a stop.
        throw timeout.aborted ? new Error('TimeoutError: The operation timed out.') : new Error('aborted');
      }
    }
    let parsed: { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }>; usage?: RawUsage };
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`mg_gateway_unparseable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const message = parsed.choices?.[0]?.message;
    if (!message) throw new Error('mg_gateway_empty_choices');
    // The OpenAI-compatible `finish_reason: "length"` is Pi's `stopReason: "length"`: the loop voids
    // the whole tool batch rather than execute arguments the token limit may have cut in half.
    const finishReason = parsed.choices?.[0]?.finish_reason;
    return {
      text: contentToText(message.content),
      toolCalls: parseToolCalls(message.tool_calls),
      stopReason: finishReason === 'length' ? 'length' : 'stop',
      usage: parseUsage(parsed.usage),
    };
  }
}

/**
 * A test or embedding host can supply its own provider; the plugin surface is identical. The resident
 * itself registers `modelRouterPlugin` (`src/model/router.ts`) instead: it provides the same `model`
 * service while keeping the route table switchable.
 */
export function providedModelPlugin(provider: ModelProvider): NativePlugin {
  return {
    name: 'provided-model',
    provide: ['model'],
    apply(ctx) {
      ctx.provide('model', provider);
    },
  };
}

/**
 * Model access through the mg gateway (magpie): one OpenAI-compatible endpoint, model
 * `auto/deepseek-v4.1-flash`.
 *
 * The provider is a plugin like any other; the core loop only knows `ModelProvider`. A failed call
 * throws, and the loop's failure ladder classifies it (`src/state/retry.ts`): overflow first, then
 * account limits, then a bounded exponential-backoff retry. There is still no fallback model.
 */
import type { AgentMessage, ModelCompletionInput, ModelProvider, ModelTurn, ToolCall } from '../state/agent-loop.ts';
import type { NativePlugin } from './host.ts';
import { contentToText } from '../content.ts';

export interface MgProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
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

export class MgModelProvider implements ModelProvider {
  readonly name = 'mg';
  readonly model: string;

  constructor(private readonly config: MgProviderConfig) {
    this.model = config.model;
  }

  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    const url = `${this.config.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    const response = await fetch(url, {
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
    const text = await response.text();
    if (!response.ok) throw new Error(`mg_gateway_error: ${response.status} ${text.slice(0, 400)}`);
    let parsed: { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
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
      usage: parsed.usage
        ? { input: parsed.usage.prompt_tokens ?? 0, output: parsed.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}

export function mgProviderPlugin(): NativePlugin {
  return {
    name: 'mg-provider',
    provide: ['model'],
    apply(ctx, config) {
      const provider = new MgModelProvider(config as MgProviderConfig);
      ctx.provide('model', provider);
      ctx.registerProvider('mg', { baseUrl: (config as MgProviderConfig).baseUrl, model: (config as MgProviderConfig).model });
    },
  };
}

/** A test or embedding host can supply its own provider; the plugin surface is identical. */
export function providedModelPlugin(provider: ModelProvider): NativePlugin {
  return {
    name: 'provided-model',
    provide: ['model'],
    apply(ctx) {
      ctx.provide('model', provider);
    },
  };
}

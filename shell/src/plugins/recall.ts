/**
 * Recall inside the loop: memory is the ground the companion stands on, not a tool it may or may not
 * pick up.
 *
 * The plugin rides `transformContext`, the single context pipeline the loop runs before every
 * provider call, and reads the newest user message each time. That is deliberate: a steering message
 * injected after a tool batch is a new boundary, so it gets its own recall instead of continuing with
 * the previous turn's evidence (guidance conflict #7). The query is always text the user actually
 * wrote — this never invents a question to look busy.
 *
 * The hook runs before every provider call and its result is only this request's projection, so the
 * block is inserted again each time (same query → same block; a new user line → a fresh recall).
 * There is deliberately no per-run "already injected" state: that dedup was what dropped the block
 * from the second call of a run (#247 A3).
 */
import type { KernelAgentMemoryBackend } from 'cogmem';
import type { AgentMessage } from '../state/agent-loop.ts';
import { renderRecallBlock } from '../state/recall-block.ts';
import type { NativePlugin } from './host.ts';

export interface RecallPluginConfig {
  agentId: string;
  projectId: string;
  limit: number;
}

export function recallPlugin(config: RecallPluginConfig): NativePlugin {
  return {
    name: 'recall',
    inject: ['eventBus', 'memory'],
    provide: ['recall'],
    apply(ctx) {
      const backend = ctx.getService<KernelAgentMemoryBackend>('memory');
      // The service is what another plugin would consume; the hook below is this plugin's own use.
      ctx.provide('recall', {
        recallFor(query: string, limit = config.limit) {
          return backend.recall({ agentId: config.agentId, projectId: config.projectId, query, limit });
        },
      });
      ctx.on('transformContext', (value: unknown, busCtx?: { runId?: string }) => {
        if (!Array.isArray(value) || !busCtx?.runId) return value;
        const messages = value as AgentMessage[];
        let lastUserIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role === 'user') {
            lastUserIndex = index;
            break;
          }
        }
        if (lastUserIndex < 0) return value;
        const query = messages[lastUserIndex].content;
        if (!query) return value;
        const result = backend.recall({ agentId: config.agentId, projectId: config.projectId, query, limit: config.limit });
        if (result.items.length === 0) return value;
        const block: AgentMessage = { role: 'system', content: renderRecallBlock(result.items) };
        return [...messages.slice(0, lastUserIndex + 1), block, ...messages.slice(lastUserIndex + 1)];
      });
    },
  };
}

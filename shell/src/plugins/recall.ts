/**
 * The recall service (#249 A5 moved its context injection into the lane assembly).
 *
 * Other plugins and commands can ask for a recall; the request-time recall lane is owned by
 * `session-context`, which calls the kernel directly so the lane's ids and budget are the same
 * assembly's. Keeping the service here means the capability is still a named service without a
 * second `transformContext` path injecting a second recall block.
 */
import type { KernelAgentMemoryBackend } from 'cogmem';
import type { NativePlugin } from './host.ts';

export interface RecallPluginConfig {
  agentId: string;
  projectId: string;
  /** The current session; its turns are the tail lane, not long-term memory (#321). */
  sessionId?: string;
  limit: number;
}

export function recallPlugin(config: RecallPluginConfig): NativePlugin {
  return {
    name: 'recall',
    inject: ['memory'],
    provide: ['recall'],
    apply(ctx) {
      const backend = ctx.getService<KernelAgentMemoryBackend>('memory');
      ctx.provide('recall', {
        recallFor(query: string, limit = config.limit) {
          return backend.recall({
            agentId: config.agentId,
            projectId: config.projectId,
            query,
            limit,
            ...(config.sessionId === undefined ? {} : { excludeSessionId: config.sessionId }),
          });
        },
      });
    },
  };
}

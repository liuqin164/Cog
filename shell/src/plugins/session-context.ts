/**
 * Cross-run continuity (#245 A1): the kernel's `tail` lane is part of every request.
 *
 * The shell's run context starts empty, so a follow-up like "继续" reached the model with no memory
 * of the previous run. The kernel already owns the projection — the session ledger read, the
 * verbatim tail, the lane budget and its browse-only stub — so this plugin does not keep a second
 * copy of the turns. It asks `assembleSessionContext` for the tail lane and inserts that lane before
 * the newest user message, which is the same position Pi's `context` hook sees a replayed
 * transcript.
 */
import type { KernelAgentMemoryBackend } from 'cogmem';
import type { AgentMessage } from '../state/agent-loop.ts';
import type { NativePlugin } from './host.ts';

export interface SessionContextPluginConfig {
  agentId: string;
  projectId: string;
  sessionId: string;
  /** The lane budget's denominator: the model's sweet spot, read from the shell's configuration. */
  targetTokens: number;
  /** How many recent turns stay verbatim; the kernel splits the rest into the digest. */
  tailTurns: number;
}

export function sessionContextPlugin(config: SessionContextPluginConfig): NativePlugin {
  return {
    name: 'session-context',
    inject: ['eventBus', 'memory'],
    provide: ['session-context'],
    apply(ctx) {
      const backend = ctx.getService<KernelAgentMemoryBackend>('memory');
      ctx.on('transformContext', (value: unknown) => {
        if (!Array.isArray(value)) return value;
        const messages = value as AgentMessage[];
        let lastUserIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role === 'user') {
            lastUserIndex = index;
            break;
          }
        }
        if (lastUserIndex < 0) return value;
        const assembly = backend.assembleSessionContext({
          projectId: config.projectId,
          agentId: config.agentId,
          sessionId: config.sessionId,
          targetTokens: config.targetTokens,
          tailTurns: config.tailTurns,
        });
        const tail = assembly.lanes.find((lane) => lane.lane === 'tail');
        if (!tail?.text) return value;
        const block: AgentMessage = { role: 'system', content: tail.text };
        return [...messages.slice(0, lastUserIndex), block, ...messages.slice(lastUserIndex)];
      });
    },
  };
}

/**
 * The six-lane context assembly (#249 A5).
 *
 * Every request is one projection of the kernel's session ledger, fitted to the model route's
 * target bandwidth. `pinned` and `profile` become the stable system prefix; the other lanes become
 * one system block inserted before the newest user line. The kernel owns the lane order, the
 * downgrade rule and the browse-only pointers; this plugin only supplies the shell's material and
 * places the result where the provider reads it.
 *
 * The split between `prepareRequest` and `transformContext` is deliberate. The assembly runs once
 * per turn at `prepareRequest`, where the request's system prompt can be replaced. The message block
 * is injected later at `transformContext`, after the loop has appended any tool-loadout declaration
 * to the transcript — replacing messages at `prepareRequest` would drop that declaration.
 */
import { renderBrowseStub, type AgentRecallItem, type KernelAgentMemoryBackend, type SessionContextAssembly, type SessionContextItem, type SessionContextLane } from 'cogmem';
import type { AgentMessage } from '../state/agent-loop.ts';
import type { NativePlugin } from './host.ts';

export interface SessionContextPluginConfig {
  agentId: string;
  projectId: string;
  sessionId: string;
  /** The model route's sweet spot, read at request time so a route switch takes effect. */
  targetTokens: () => number;
  /** How many recent turns stay verbatim; the kernel splits the rest into the digest. */
  tailTurns: number;
  pinned: () => string[];
  profile: () => string[];
  workingSet?: () => string[];
  /** Wake intents and the open assignment; the kernel merges these into `working_set`. */
  openLoops?: () => SessionContextItem[];
  /** The per-turn part of the system prompt: time context and a pending question. */
  variablePrompt: () => string;
  onAssembly?: (assembly: SessionContextAssembly) => void;
  recallLimit?: number;
}

export function sessionContextPlugin(config: SessionContextPluginConfig): NativePlugin {
  return {
    name: 'session-context',
    inject: ['eventBus', 'memory'],
    provide: ['session-context'],
    apply(ctx) {
      const backend = ctx.getService<KernelAgentMemoryBackend>('memory');
      let pendingBlock = '';

      ctx.on('prepareRequest', (value: unknown) => {
        if (!value || typeof value !== 'object') return value;
        const request = value as { messages?: AgentMessage[]; systemPrompt?: string; [key: string]: unknown };
        const messages = Array.isArray(request.messages) ? request.messages : [];
        pendingBlock = '';
        const query = newestUserText(messages);
        try {
          const recall = query
            ? backend.recall({
                agentId: config.agentId,
                projectId: config.projectId,
                query,
                limit: config.recallLimit ?? 3,
              }).items.map(toContextItem)
            : [];
          const assembly = backend.assembleSessionContext({
            projectId: config.projectId,
            agentId: config.agentId,
            sessionId: config.sessionId,
            targetTokens: Math.max(1, Math.floor(config.targetTokens())),
            tailTurns: config.tailTurns,
            pinned: config.pinned(),
            profile: config.profile(),
            workingSet: config.workingSet?.() ?? [],
            openLoops: config.openLoops?.() ?? [],
            recall,
            recentText: recentText(messages),
          });
          config.onAssembly?.(assembly);
          pendingBlock = assembly.lanes
            .filter((lane) => !lane.stable)
            .map(requestLaneText)
            .filter(Boolean)
            .join('\n');
          return {
            ...request,
            systemPrompt: [stableSystemPrompt(assembly), config.variablePrompt()].filter(Boolean).join('\n\n'),
          };
        } catch (error) {
          ctx.logger.warn('context_lanes_failed', { message: error instanceof Error ? error.message : String(error) });
          return value;
        }
      });

      ctx.on('transformContext', (value: unknown) => {
        if (!Array.isArray(value) || !pendingBlock) return value;
        const messages = value as AgentMessage[];
        const index = newestUserIndex(messages);
        const block: AgentMessage = { role: 'system', content: pendingBlock };
        return index >= 0 ? [...messages.slice(0, index), block, ...messages.slice(index)] : [...messages, block];
      });
    },
  };
}

function newestUserIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return index;
  }
  return -1;
}

function newestUserText(messages: readonly AgentMessage[]): string | undefined {
  const index = newestUserIndex(messages);
  const text = index >= 0 ? messages[index].content.trim() : '';
  return text === '' ? undefined : text;
}

/**
 * What a stub may be named by: the newest user message and the latest model output the request
 * carries (#253). The model's own words are included because a run can refer back to a stub on the
 * next request without the owner repeating the term.
 */
function recentText(messages: readonly AgentMessage[]): string[] {
  const texts: string[] = [];
  const user = newestUserText(messages);
  if (user) texts.push(user);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'assistant') continue;
    const text = messages[index].content.trim();
    if (text !== '') {
      texts.push(text);
      break;
    }
  }
  return texts;
}

function toContextItem(item: AgentRecallItem): SessionContextItem {
  const eventId = item.sourceAnchor?.eventId;
  const sourceLocator = item.sourceContext?.locator?.command;
  return {
    id: eventId ?? item.id,
    text: item.text,
    ...(item.sourceContext?.event?.text === undefined ? {} : { originalText: item.sourceContext.event.text }),
    ...(eventId === undefined ? {} : { sourceRefs: [eventId], anchorEvent: eventId }),
    ...(sourceLocator === undefined ? {} : { sourceLocator }),
    ...(item.whyMatched === undefined ? {} : { whyMatched: item.whyMatched }),
  };
}

/**
 * The lane's bytes for the request. The kernel drops a downgraded lane's stub when the rest of the
 * assembly already exceeds the budget; the pointer is still the whole point of the downgrade, so the
 * shell restores it from `browseIds`. The recall lane already carries the kernel's
 * `COGMEM_RECALL_CONTEXT` map, so the shell adds no second envelope.
 */
function requestLaneText(lane: SessionContextLane): string {
  return lane.text || (lane.status === 'downgraded' && lane.browseIds.length > 0
    ? renderBrowseStub(lane.lane, lane.browseIds)
    : '');
}

/**
 * The stable prefix in the request's own shape: the pinned paragraphs verbatim (so the old
 * system-prompt contract and a provider cache both still see the same leading bytes), then the
 * kernel's profile lane. Rebuilding it from the assembled items — not from `stablePrefix`'s lane
 * headers — is what lets the kernel's stable trimming actually shorten the prefix under budget.
 */
function stableSystemPrompt(assembly: SessionContextAssembly): string {
  const pinned = assembly.lanes.find((lane) => lane.lane === 'pinned');
  const profile = assembly.lanes.find((lane) => lane.lane === 'profile');
  return [
    pinned ? pinned.items.map((item) => item.text).join('\n\n') : '',
    profile?.text ?? '',
  ].filter(Boolean).join('\n\n');
}

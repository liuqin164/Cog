/**
 * The six-lane context assembly (#249 A5).
 *
 * Every request is one projection of the kernel's session ledger, fitted to the model route's
 * target bandwidth. `pinned` and `profile` become the stable system prefix; the other lanes become
 * one system block inserted before the newest user line. The kernel owns the lane order, the
 * downgrade rule and the browse-only pointers; this plugin only supplies the shell's material and
 * places the result where the provider reads it.
 *
 * The split between `prepareRequest` and `transformContext` is deliberate. `prepareRequest` assembles
 * the turn once and reuses it until the ledger's newest sequence advances; it is where the request's
 * system prompt can be replaced. The message block is injected later at `transformContext`, after
 * the loop has appended any tool-loadout declaration to the transcript — replacing messages at
 * `prepareRequest` would drop that declaration.
 */
import { renderBrowseStub, type AgentRecallItem, type KernelAgentMemoryBackend, type SessionContextAssembly, type SessionContextItem, type SessionContextLane, type SessionDigestEntry } from 'cogmem';
import type { AgentMessage } from '../state/agent-loop.ts';
import type { NativePlugin } from './host.ts';

export interface SessionContextPluginConfig {
  agentId: string;
  projectId: string;
  sessionId: string;
  /** The model route's sweet spot, read at request time so a route switch takes effect. */
  targetTokens: () => number;
  clock: () => { now: number; timeZone?: string };
  /** How many recent turns stay verbatim; the kernel splits the rest into the digest. */
  tailTurns: number;
  pinned: () => string[];
  profile: () => string[];
  workingSet?: () => string[];
  /** Wake intents and the open assignment; the kernel merges these into `working_set`. */
  openLoops?: (query?: string, toolNames?: readonly string[], runId?: string) => SessionContextItem[];
  /** The per-turn part of the system prompt: time context and a pending question. */
  variablePrompt: () => string;
  /** Finished tasks' digest stubs (#263), built from ledger rows and kept across restarts. */
  digestStubs?: () => readonly SessionDigestEntry[];
  ledgerSeq: () => number;
  onAssembly?: (assembly: SessionContextAssembly) => void;
  onAssemblyFailure?: (message: string) => void;
  onAssemblySuccess?: () => void;
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
      let turn:
        | { runId?: string; seq: number; query?: string; recent: string[]; recall: SessionContextItem[]; toolNames: string[]; assembly: SessionContextAssembly; pendingBlock: string; stablePrompt: string }
        | undefined;
      const assemble = (recall: SessionContextItem[], recent: string[], runId?: string, cachedDigest?: SessionContextAssembly['digest'], query?: string, toolNames?: readonly string[]): SessionContextAssembly =>
        backend.assembleSessionContext({
          projectId: config.projectId,
          agentId: config.agentId,
          sessionId: config.sessionId,
          targetTokens: Math.max(1, Math.floor(config.targetTokens())),
          tailTurns: config.tailTurns,
          excludeTurnIds: runId ? [`${runId}:0`] : undefined,
          pinned: config.pinned(),
          profile: config.profile(),
          workingSet: config.workingSet?.() ?? [],
          openLoops: config.openLoops?.(query, toolNames, runId) ?? [],
          recall,
          digestStubs: config.digestStubs?.() ?? [],
          recentText: recent,
          ...(cachedDigest ? { cachedDigest } : {}),
        });
      const accept = (assembly: SessionContextAssembly): string => {
        config.onAssembly?.(assembly);
        pendingBlock = assembly.lanes
          .filter((lane) => !lane.stable)
          .map(requestLaneText)
          .filter(Boolean)
          .join('\n');
        config.onAssemblySuccess?.();
        return stableSystemPrompt(assembly);
      };

      ctx.on('prepareRequest', (value: unknown, busCtx?: { runId?: string }) => {
        if (!value || typeof value !== 'object') return value;
        const request = value as { messages?: AgentMessage[]; systemPrompt?: string; [key: string]: unknown };
        const messages = Array.isArray(request.messages) ? request.messages : [];
        pendingBlock = '';
        const query = newestUserText(messages);
        const toolNames = requestToolNames(messages);
        const recent = recentText(messages);
        const seq = config.ledgerSeq();
        try {
          if (busCtx?.runId && turn && turn.runId === busCtx.runId && turn.query === query && turn.seq === seq) {
            if (turn.recent.join('\n') !== recent.join('\n') || turn.toolNames.join(',') !== toolNames.join(',')) {
              const assembly = assemble(turn.recall, recent, busCtx?.runId, turn.assembly.digest, query, toolNames);
              turn.assembly = assembly;
              turn.recent = recent;
              turn.toolNames = toolNames;
              turn.stablePrompt = accept(assembly);
              turn.pendingBlock = pendingBlock;
            }
            pendingBlock = turn.pendingBlock;
            return {
              ...request,
              systemPrompt: [turn.stablePrompt, config.variablePrompt()].filter(Boolean).join('\n\n'),
            };
          }
          const recall = query
            ? backend.recall({
                agentId: config.agentId,
                projectId: config.projectId,
                query,
                excludeSessionId: config.sessionId,
                excludeSessionTailTurns: config.tailTurns,
                limit: config.recallLimit ?? 3, ...config.clock(),
                includeProfileLane: false,
              }).items.map(toContextItem)
            : [];
          const assembly = assemble(recall, recent, busCtx?.runId, undefined, query, toolNames);
          const stablePrompt = accept(assembly);
          turn = busCtx?.runId
            ? { runId: busCtx.runId, seq, query, recent, recall, toolNames, assembly, pendingBlock, stablePrompt }
            : undefined;
          return {
            ...request,
            systemPrompt: [stablePrompt, config.variablePrompt()].filter(Boolean).join('\n\n'),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.error('context_lanes_failed', { message });
          config.onAssemblyFailure?.(message);
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

function requestToolNames(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) => [
    ...(message.toolCalls ?? []).map((call) => call.toolName),
    ...(message.toolName ? [message.toolName] : []),
  ]);
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
  // The companion is one process with the kernel. Its drill-down is the builtin `read` tool, not
  // the operator's CLI: that CLI resolves its own config and may be a different database (#277).
  const sourceLocator = eventId === undefined ? undefined : `read mem:${eventId}`;
  return {
    id: eventId ?? item.id,
    text: item.text,
    ...(item.sourceContext?.event?.text === undefined ? {} : { originalText: item.sourceContext.event.text }),
    ...(eventId === undefined ? {} : { sourceRefs: [eventId], anchorEvent: eventId }),
    ...(sourceLocator === undefined ? {} : { sourceLocator }),
    ...(item.whyMatched === undefined ? {} : { whyMatched: item.whyMatched }),
    ...(item.trust === undefined ? {} : { trust: item.trust }),
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

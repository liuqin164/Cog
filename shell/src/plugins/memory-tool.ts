import type { AgentRecallItem, KernelAgentMemoryBackend, MemoryKernel } from 'cogmem';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin, ToolDefinition } from './host.ts';
import { readMemoryEvent } from './builtin-tools.ts';

export interface MemoryToolConfig {
  agentId: string;
  projectId: string;
  sessionId: string;
  onMemoryRead?: (eventId: string) => void;
}

const SEARCH_LIMIT = 5;
const RECENT_MAX = 200;
const SEARCH_TEXT_MAX = 2_000;

function requiredText(args: any, key: string): string {
  const value = args?.[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid_arguments: "${key}" is required`);
  return value.trim();
}

function entryLines(items: readonly AgentRecallItem[]): string[] {
  return items.map((item) => {
    const eventId = item.sourceAnchor?.eventId;
    const prefix = item.trust === 'tool_observation' ? '[tool observation (untrusted)] ' : '';
    const text = item.text.length > SEARCH_TEXT_MAX ? `${item.text.slice(0, SEARCH_TEXT_MAX)}…` : item.text;
    const meta = [
      ...(eventId === undefined ? [] : [`mem:${eventId}`]),
      ...(item.whyMatched === undefined ? [] : [`whyMatched=${item.whyMatched}`]),
    ];
    return [`- ${prefix}${text}`, ...(meta.length === 0 ? [] : [`  ${meta.join(' ')}`])].join('\n');
  });
}

function memoryTool(
  config: MemoryToolConfig,
  backend: KernelAgentMemoryBackend,
  kernel: MemoryKernel,
  trace: TraceLog | undefined,
): ToolDefinition {
  return {
    name: 'memory',
    description:
      'Search or read Cogmem memory on demand. action="search" with query runs the same kernel recall as the lane and returns up to 5 entries, each with a mem:<eventId> key. action="read" with eventId opens that ledger row verbatim; it is the same as read mem:<eventId>. action="recent" with n (1-200) returns the newest n turns of this session, newest first. Use search when the recall lane did not answer, and say whether it found the memory or not.',
    replay: 'safe',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'read', 'recent'] },
        query: { type: 'string' },
        eventId: { type: 'string' },
        n: { type: 'integer' },
      },
      required: ['action'],
    },
    execute({ args }) {
      const action = requiredText(args, 'action');
      if (action === 'search') {
        const result = backend.recall({
          agentId: config.agentId,
          projectId: config.projectId,
          query: requiredText(args, 'query'),
          excludeSessionId: config.sessionId,
          limit: SEARCH_LIMIT,
        });
        const lines = entryLines(result.items);
        return lines.length === 0
          ? '[memory search: no matching memory]'
          : [`[memory search: ${lines.length} result(s)]`, ...lines].join('\n');
      }
      if (action === 'read') {
        const requested = requiredText(args, 'eventId');
        const eventId = requested.startsWith('mem:') ? requested.slice('mem:'.length) : requested;
        return readMemoryEvent(eventId, kernel, trace, config.onMemoryRead);
      }
      if (action === 'recent') {
        const n = args?.n;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > RECENT_MAX) {
          throw new Error(`invalid_arguments: "n" must be an integer from 1 to ${RECENT_MAX}`);
        }
        const page = backend.recallSession({
          projectId: config.projectId,
          agentId: config.agentId,
          sessionId: config.sessionId,
          mode: 'time',
          limit: n,
        });
        if (page.items.length === 0) return '[memory recent: no turns in this session]';
        return [
          `[memory recent: ${page.items.length} turn(s), newest first]`,
          ...page.items.map((item) => `- ${item.speaker}: ${item.text}\n  mem:${item.eventId}`),
        ].join('\n');
      }
      throw new Error('invalid_arguments: "action" must be search, read or recent');
    },
  };
}

export function memoryToolPlugin(config: MemoryToolConfig): NativePlugin {
  return {
    name: 'memory-tool',
    inject: ['memory', 'kernel', 'trace'],
    apply(ctx) {
      ctx.registerTool(memoryTool(
        config,
        ctx.getService<KernelAgentMemoryBackend>('memory'),
        ctx.getService<MemoryKernel>('kernel'),
        ctx.getService<TraceLog>('trace'),
      ));
    },
  };
}

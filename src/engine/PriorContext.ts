import type { MemoryFrameV1 } from '../semantic/MemoryFrameTypes.js';
import { soulTokens } from '../soul/SoulService.js';
import type { EventStore } from '../store/EventStore.js';
import type { MemoryFrameStore } from '../store/MemoryFrameStore.js';
import type { MemoryEvent } from '../types/index.js';
import { truncate } from '../utils/Values.js';
import { eventTextForMemory } from '../episode/CogmemBlockStripper.js';

export interface PriorContextBudget {
  maxFrames?: number;
  maxEvents?: number;
  maxTokens?: number;
}

export interface PriorContextQuery {
  projectId?: string;
  keys: string[];
  asOf: number;
  budget?: PriorContextBudget;
  excludeEventIds?: string[];
}

export type PriorContextSourceRef =
  | { kind: 'event'; eventId: string; occurredAt: number; globalSeq?: number; role?: string; threadId?: string; sessionId?: string }
  | { kind: 'frame'; frameId: string; episodeId: string; occurredAt: number; eventIds: string[] };

export interface PriorContextItem {
  kind: 'event' | 'frame';
  occurredAt: number;
  text: string;
  sourceRefs: PriorContextSourceRef[];
}

export interface PriorContextSlice {
  keys: string[];
  items: PriorContextItem[];
  tokenCount: number;
  block: string;
}

export type PriorContextProvider = (query: PriorContextQuery) => PriorContextSlice;

export interface PriorContextReaderDeps {
  eventStore: Pick<EventStore, 'searchRawEvents'>;
  frameStore?: Pick<MemoryFrameStore, 'list'>;
}

const DEFAULT_MAX_FRAMES = 8;
const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MAX_TOKENS = 4_000;
const MAX_KEYS = 24;
const PER_KEY_LIMIT = 8;

export function readPriorContext(deps: PriorContextReaderDeps, query: PriorContextQuery): PriorContextSlice {
  const keys = [...new Set(query.keys.map((key) => key.trim()).filter((key) => key.length >= 2))].slice(0, MAX_KEYS);
  const excluded = new Set(query.excludeEventIds ?? []);
  const maxEvents = Math.max(0, query.budget?.maxEvents ?? DEFAULT_MAX_EVENTS);
  const maxFrames = Math.max(0, query.budget?.maxFrames ?? DEFAULT_MAX_FRAMES);
  const maxTokens = Math.max(1, query.budget?.maxTokens ?? DEFAULT_MAX_TOKENS);
  if (keys.length === 0) return { keys, items: [], tokenCount: 0, block: '' };

  const events = new Map<string, { event: MemoryEvent; matches: number }>();
  for (const key of keys) {
    const matches = deps.eventStore.searchRawEvents(key, {
      projectId: query.projectId,
      endTime: query.asOf,
      orderBy: 'relevance',
      limit: PER_KEY_LIMIT,
    });
    for (const event of matches) {
      if (excluded.has(event.eventId)) continue;
      const known = events.get(event.eventId);
      if (known) known.matches += 1;
      else events.set(event.eventId, { event, matches: 1 });
    }
  }
  const selectedEvents = [...events.values()]
    .sort((left, right) => right.matches - left.matches || right.event.occurredAt - left.event.occurredAt)
    .slice(0, maxEvents)
    .map(({ event }): PriorContextItem => ({
      kind: 'event',
      occurredAt: event.occurredAt,
      text: truncate(`${event.role || event.rawEventType || 'event'}: ${eventTextForMemory(event)}`, 600),
      sourceRefs: [{
        kind: 'event',
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        globalSeq: event.globalSeq,
        role: event.role,
        threadId: event.threadId,
        sessionId: event.sessionId,
      }],
    }));

  const selectedFrames = (deps.frameStore?.list(query.projectId ?? '', { limit: 200 }) ?? [])
    .filter((frame) => frame.processor.generatedAt < query.asOf)
    .filter((frame) => {
      const text = frameText(frame).toLowerCase();
      return keys.some((key) => text.includes(key.toLowerCase()));
    })
    .sort((left, right) => right.processor.generatedAt - left.processor.generatedAt)
    .slice(0, maxFrames)
    .map((frame): PriorContextItem => ({
      kind: 'frame',
      occurredAt: frame.processor.generatedAt,
      text: truncate(`${frame.title}: ${frame.summary} ${frameText(frame)}`, 600),
      sourceRefs: [{
        kind: 'frame',
        frameId: frame.frameId,
        episodeId: frame.episodeId,
        occurredAt: frame.processor.generatedAt,
        eventIds: frame.evidenceEventIds,
      }],
    }));

  const items: PriorContextItem[] = [];
  for (const item of [...selectedEvents, ...selectedFrames].sort((left, right) => right.occurredAt - left.occurredAt)) {
    const next = [...items, item];
    if (soulTokens(renderBlock(keys, next)) > maxTokens) continue;
    items.push(item);
  }
  const ordered = items.sort((left, right) => left.occurredAt - right.occurredAt);
  const block = renderBlock(keys, ordered);
  return { keys, items: ordered, tokenCount: soulTokens(block), block };
}

function renderBlock(keys: string[], items: PriorContextItem[]): string {
  if (items.length === 0) return '';
  const lines = [
    '<COGMEM_PRIOR_CONTEXT>',
    `keys: ${keys.join(', ')}`,
    'not evidence; cite prior ids in priorContextRefs; when a prior value differs, emit one update naming both values.',
  ];
  for (const item of items) {
    const ref = item.sourceRefs[0];
    const id = ref.kind === 'event' ? `event_id=${ref.eventId}` : `frame_id=${ref.frameId} episode_id=${ref.episodeId}`;
    lines.push(`[${item.kind} ${id} at=${new Date(item.occurredAt).toISOString()}] ${item.text.replace(/\s+/gu, ' ')}`);
  }
  lines.push('</COGMEM_PRIOR_CONTEXT>');
  return lines.join('\n');
}

function frameText(frame: MemoryFrameV1): string {
  return [frame.title, frame.summary, ...frame.nodes.map((node) => `${node.label} ${node.description || ''}`)].join(' ');
}

/**
 * The context budget controller (#191 primitive 3).
 *
 * One turn's context is a fixed-order projection of six lanes, assembled to a target bandwidth the
 * caller reads from its model configuration. There is no overflow-triggered sawtooth: every turn
 * starts from the same lane order and the same budget.
 *
 * Over budget, the lowest-priority lane is downgraded to a pointer ("browse-only"), not deleted:
 * its ids stay in the result and the caller can fetch the text through `digest`/`recall`. Every
 * downgrade is written to `decisionTrace`. Lanes above the cut are rendered byte-for-byte the same
 * as before, which is what keeps the provider's prefix cache intact.
 *
 * Constraints never fold (#255). An item marked `protected` — a correction, a promise, an
 * intention or a prohibition — is never downgraded, trimmed or paraphrased. A lane that carries
 * one is trimmed to its protected items instead of becoming a stub, and the rest of the lane's
 * ids stay browsable. If the protected items alone exceed the target, they still stay: the target
 * is a bandwidth goal, not a licence to drop a constraint.
 *
 * The order the lanes are *rendered* in is frozen (`SESSION_CONTEXT_LANES`); the order they are
 * *filled* in is the separate priority table. The recall lane renders last because it changes every
 * turn, but it outranks the tail and the digest when the budget is tight.
 */

import { ImportanceSignalDetector } from '../engine/ImportanceSignalDetector.js';
import { digestAnchors, type SessionDigest, type SessionDigestEntry } from './SessionDigest.js';
import { sessionError } from './SessionErrors.js';
import { serializeUntrustedLaneText, serializeUntrustedMemory } from '../agent/UntrustedMemorySerializer.js';
import type { ConversationSpeaker } from '../conversation/index.js';

/** The lane order, frozen by `docs/session-context.md`. */
export const SESSION_CONTEXT_LANES = ['pinned', 'profile', 'digest', 'working_set', 'tail', 'recall'] as const;
export type SessionContextLaneName = (typeof SESSION_CONTEXT_LANES)[number];

/**
 * The fill order, highest first. `pinned` and `profile` lead because they are the stable prefix;
 * `tail` next because the recent verbatim turns are the continuity anchor; the digest, the current
 * working set and this turn's recall are the lanes that get browsed first when the budget is tight.
 */
export const SESSION_CONTEXT_LANE_PRIORITY: Readonly<Record<SessionContextLaneName, number>> = {
  pinned: 60,
  profile: 50,
  recall: 45,
  tail: 40,
  working_set: 20,
  digest: 10,
};

/** Lanes whose rendered bytes must not change between assemblies: the provider's cache prefix. */
export const SESSION_CONTEXT_STABLE_LANES = ['pinned', 'profile'] as const;

/** The decision record's field set, frozen by `docs/session-context.md`. */
export const SESSION_CONTEXT_DECISION_FIELDS = [
  'lane',
  'action',
  'reason',
  'tokensBefore',
  'tokensAfter',
  'omittedItems',
  'browseIds',
] as const;

export interface SessionContextItem {
  id: string;
  text: string;
  sourceSession?: string;
  sourceRefs?: string[];
  /** The ledger row's speaker, when the item came from a conversation turn (#324). */
  speaker?: ConversationSpeaker;
  /** The ledger event this item is anchored to, when it has one (`evt-…`). */
  anchorEvent?: string;
  /** The kernel's read command for the anchor's original text. */
  sourceLocator?: string;
  whyMatched?: string;
  trust?: 'tool_observation';
  /**
   * The ledger text this item stands for, when `text` is a stub (#253). Only a stub is expanded:
   * an item whose text already is the ledger row carries no `originalText`.
   */
  originalText?: string;
  /** Set by the assembler on the item it placed in `working_set`; never supplied by a caller. */
  autoExpanded?: boolean;
  /**
   * A constraint: a correction, a promise, an intention or a prohibition. The assembly never
   * downgrades, trims or folds it; it stays in the lane verbatim.
   */
  protected?: boolean;
}

export interface AssembleSessionContextInput {
  projectId: string;
  agentId: string;
  sessionId: string;
  previousSessionId?: string;
  /** The sweet spot for this model, read from the model configuration. Never a kernel constant. */
  targetTokens: number;
  /** System / identity / rules. Never paraphrased; trimmed last. */
  pinned?: string[];
  /** The profile compiler's current entries, rendered by the caller. */
  profile?: string[];
  /** The current task's working set. */
  workingSet?: string[];
  /** F2 wake intentions and F6 candidates that must survive a restart. */
  openLoops?: SessionContextItem[];
  /** This turn's recall. */
  recall?: SessionContextItem[];
  /** Item ids that must survive verbatim, whatever lane they are in. */
  protectedIds?: readonly string[];
  /** How many recent turns stay verbatim. Defaults to `SESSION_DIGEST_TAIL_TURNS`. */
  tailTurns?: number;
  excludeTurnIds?: readonly string[];
  /**
   * The newest user message and the latest model output, as the shell has them at assembly time
   * (#253). A stub whose key or own entity words occur here is expanded before the request.
   */
  recentText?: readonly string[];
  /**
   * Task-exit stubs (#263). Each is a `SessionDigestEntry` built from the task's own ledger rows;
   * the assembler places it in the digest lane and renders its key so `read mem:<eventId>` can
   * drill back to the quoted row. This is a lane-level exit, not a fold: the working-set material
   * is supplied by the caller and is not part of this input.
   */
  digestStubs?: readonly SessionDigestEntry[];
  cachedDigest?: SessionDigest;
}

export type SessionContextLaneStatus = 'included' | 'downgraded' | 'empty';

export interface SessionContextLane {
  lane: SessionContextLaneName;
  priority: number;
  stable: boolean;
  status: SessionContextLaneStatus;
  tokens: number;
  items: SessionContextItem[];
  /** Ids a downgraded lane left behind, so the caller can browse the text it did not include. */
  browseIds: string[];
  text: string;
}

export interface SessionContextDecision {
  lane: SessionContextLaneName;
  action: 'downgraded' | 'trimmed';
  reason: 'budget_exceeded';
  tokensBefore: number;
  tokensAfter: number;
  omittedItems: number;
  browseIds: string[];
}

export interface SessionContextAssembly {
  projectId: string;
  agentId: string;
  sessionId: string;
  targetTokens: number;
  usedTokens: number;
  lanes: SessionContextLane[];
  decisionTrace: SessionContextDecision[];
  /** The bytes the cacheable prefix rendered, in order; unchanged across assemblies at the same budget. */
  stablePrefix: string;
  /** The assembled context: lanes in frozen order. */
  text: string;
  digest: SessionDigest;
  /** The stub ids this assembly expanded into `working_set` (#253); the count is `length`. */
  autoExpanded: readonly string[];
}

/**
 * A character-class estimate, not a tokenizer (#318).
 *
 * `chars / 4` is a fair unit for English and source code but undercounts Chinese by about 2.3×:
 * on the project's own sweet-spot corpus, 24,006 characters cost 13,021 provider prompt tokens
 * (0.542 tokens/char) while `chars / 4` called it 6,002. The measured cost per class with
 * `auto/deepseek-v4.1-flash` is 0.24–0.25 tokens/char for ASCII prose and code, 0.58–0.60 for
 * Chinese prose, and 0.50 for the `中文` bigram. We charge ASCII 0.25 and every other code point
 * 0.64: the upper end of the measured Chinese range, so a mixed request is estimated at ~0.81 of
 * the provider's count rather than ~0.44. No tokenizer dependency is added.
 */
const ASCII_TOKENS_PER_CHAR = 0.25;
const NON_ASCII_TOKENS_PER_CHAR = 0.64;

export function sessionTokens(text: string): number {
  return Math.ceil(textTokenUnits(text));
}

function textTokenUnits(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii += 1;
    else nonAscii += 1;
  }
  return ascii * ASCII_TOKENS_PER_CHAR + nonAscii * NON_ASCII_TOKENS_PER_CHAR;
}

const BROWSE_ID_LIMIT = 20;

export function assembleSessionContext(input: AssembleSessionContextInput, digest: SessionDigest): SessionContextAssembly {
  if (!Number.isInteger(input.targetTokens) || input.targetTokens <= 0) {
    throw sessionError('invalid_target_tokens');
  }
  const mergedDigest = mergeTaskStubs(digest, input.digestStubs ?? []);
  const lanes = buildLanes(input, mergedDigest);
  const decisions: SessionContextDecision[] = [];
  const evicted = new Map<SessionContextLaneName, { items: SessionContextItem[]; tokensBefore: number }>();
  let total = lanes.reduce((sum, lane) => sum + lane.tokens, 0);

  // Downgrade from the lowest priority up. A downgraded lane keeps its ids and loses its text.
  // A lane that carries a protected item is trimmed to that item instead: a constraint is never
  // replaced by a pointer.
  while (total > input.targetTokens) {
    // The stable lanes are trimmed, never stubbed: their bytes are the cache prefix, and a stub
    // would change them for every later turn.
    const lane = lanes
      .filter((candidate) => candidate.status === 'included' && !candidate.stable && hasFoldableItems(candidate))
      .sort((left, right) => left.priority - right.priority || SESSION_CONTEXT_LANES.indexOf(left.lane) - SESSION_CONTEXT_LANES.indexOf(right.lane))[0];
    if (!lane) break;
    const before = lane.tokens;
    // An expansion is the first thing to give back: it was added this turn and must never be the
    // reason an open loop or a constraint leaves the lane (#253).
    const expanded = lane.items.filter((item) => item.autoExpanded === true);
    if (expanded.length > 0) {
      lane.items = lane.items.filter((item) => item.autoExpanded !== true);
      lane.text = renderLane(lane.lane, lane.items);
      lane.tokens = sessionTokens(lane.text);
      lane.browseIds = expanded.map((item) => item.id);
      decisions.push({
        lane: lane.lane,
        action: 'trimmed',
        reason: 'budget_exceeded',
        tokensBefore: before,
        tokensAfter: lane.tokens,
        omittedItems: expanded.length,
        browseIds: expanded.slice(-BROWSE_ID_LIMIT).map((item) => item.id),
      });
      total = lanes.reduce((sum, entry) => sum + entry.tokens, 0);
      continue;
    }
    const kept = lane.items.filter((item) => item.protected === true);
    if (kept.length > 0) {
      const omitted = lane.items.filter((item) => item.protected !== true);
      lane.items = kept;
      lane.text = renderLane(lane.lane, kept);
      lane.tokens = sessionTokens(lane.text);
      lane.browseIds = omitted.map((item) => item.id);
      decisions.push({
        lane: lane.lane,
        action: 'trimmed',
        reason: 'budget_exceeded',
        tokensBefore: before,
        tokensAfter: lane.tokens,
        omittedItems: omitted.length,
        browseIds: omitted.slice(-BROWSE_ID_LIMIT).map((item) => item.id),
      });
      total = lanes.reduce((sum, entry) => sum + entry.tokens, 0);
      continue;
    }
    const stub = renderBrowseStub(lane.lane, lane.items.map((item) => item.id), browseKeys(lane.items));
    const after = sessionTokens(stub) <= input.targetTokens - (total - before) ? stub : '';
    evicted.set(lane.lane, { items: lane.items, tokensBefore: before });
    lane.browseIds = lane.items.map((item) => item.id);
    lane.items = [];
    lane.status = 'downgraded';
    lane.text = after;
    lane.tokens = sessionTokens(after);
    total = lanes.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  // If the stable lanes alone exceed the budget, trim their items from the end. Never rewrite an
  // item's text: a verbatim lane that cannot fit is browsed, not paraphrased.
  while (total > input.targetTokens) {
    const lane = lanes
      .filter((candidate) => candidate.status === 'included' && hasFoldableItems(candidate))
      .sort((left, right) => left.priority - right.priority || SESSION_CONTEXT_LANES.indexOf(left.lane) - SESSION_CONTEXT_LANES.indexOf(right.lane))[0];
    if (!lane) break;
    const before = lane.tokens;
    const index = lastFoldableIndex(lane.items);
    if (index < 0) break;
    const [dropped] = lane.items.splice(index, 1);
    lane.text = renderLane(lane.lane, lane.items);
    lane.tokens = sessionTokens(lane.text);
    if (lane.items.length === 0) lane.status = lane.text ? 'included' : 'empty';
    decisions.push({
      lane: lane.lane,
      action: 'trimmed',
      reason: 'budget_exceeded',
      tokensBefore: before,
      tokensAfter: lane.tokens,
      omittedItems: 1,
      browseIds: [dropped!.id],
    });
    total = lanes.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  // A downgrade is not the end of the turn: everything the earlier passes freed is handed back to
  // the surviving content, highest lane priority first, newest item first (#316). The lanes and the
  // renderer above are the only machinery; there is no second state to keep in sync, and no lane
  // can grow past `targetTokens`. A lane that is only partly restored keeps its browse-only pointer
  // for the ids it left behind, so the pointer still names text the caller can fetch.
  for (const lane of [...lanes]
    .filter((entry) => evicted.has(entry.lane))
    .sort((left, right) => right.priority - left.priority || SESSION_CONTEXT_LANES.indexOf(left.lane) - SESSION_CONTEXT_LANES.indexOf(right.lane))) {
    const { items, tokensBefore } = evicted.get(lane.lane)!;
    const browseStub = renderBrowseStub(lane.lane, items.map((item) => item.id), browseKeys(items));
    const room = () => input.targetTokens - total + lane.tokens;
    let start = items.length;
    if (browseStub !== '' && sessionTokens(browseStub) <= room()) {
      const fixed = textTokenUnits(renderLane(lane.lane, [{ id: '', text: 'x' }])) - textTokenUnits(renderItemLine({ id: '', text: 'x' }));
      const line = items.map((item) => textTokenUnits(renderItemLine(item)));
      const stub = textTokenUnits(browseStub);
      let body = 0;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const next = body + (start === items.length ? fixed : ASCII_TOKENS_PER_CHAR) + line[index]!;
        if (Math.ceil(next + ASCII_TOKENS_PER_CHAR + stub) > room()) break;
        body = next;
        start = index;
      }
    }
    if (start === items.length) {
      decisions.push({
        lane: lane.lane,
        action: 'downgraded',
        reason: 'budget_exceeded',
        tokensBefore,
        tokensAfter: lane.tokens,
        omittedItems: items.length,
        browseIds: items.slice(-BROWSE_ID_LIMIT).map((item) => item.id),
      });
      continue;
    }
    const included = items.slice(start);
    const omitted = items.slice(0, start);
    const pointer = omitted.length > 0
      ? renderBrowseStub(lane.lane, omitted.map((item) => item.id), browseKeys(omitted))
      : '';
    const text = [renderLane(lane.lane, included), pointer].filter(Boolean).join('\n');
    lane.items = included;
    lane.text = text;
    lane.tokens = sessionTokens(text);
    lane.browseIds = omitted.map((item) => item.id);
    lane.status = 'included';
    total = lanes.reduce((sum, entry) => sum + entry.tokens, 0);
    decisions.push({
      lane: lane.lane,
      action: 'trimmed',
      reason: 'budget_exceeded',
      tokensBefore,
      tokensAfter: lane.tokens,
      omittedItems: omitted.length,
      browseIds: omitted.slice(-BROWSE_ID_LIMIT).map((item) => item.id),
    });
  }

  const ordered = SESSION_CONTEXT_LANES.map((name) => lanes.find((lane) => lane.lane === name)!);
  // The count is what survived the budget, not what was planned: an expansion trimmed away was
  // never seen by the provider, and a trace that counted it would overstate the turn (#253).
  const autoExpanded = ordered
    .find((lane) => lane.lane === 'working_set')!
    .items.filter((item) => item.autoExpanded === true)
    .map((item) => item.id);
  return {
    projectId: input.projectId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    targetTokens: input.targetTokens,
    usedTokens: total,
    lanes: ordered,
    decisionTrace: decisions,
    stablePrefix: ordered
      .filter((lane) => (lane.stable || lane.lane === 'digest') && lane.status === 'included')
      .map((lane) => lane.text)
      .filter(Boolean)
      .join('\n'),
    text: ordered.map((lane) => lane.text).filter(Boolean).join('\n'),
    digest: mergedDigest,
    autoExpanded,
  };
}

function buildLanes(input: AssembleSessionContextInput, digest: SessionDigest): SessionContextLane[] {
  const protectedIds = new Set(input.protectedIds ?? []);
  const stubIds = new Set((input.digestStubs ?? []).map((stub) => stub.entryId));
  const working: SessionContextItem[] = [
    ...(input.workingSet ?? []).map((text, index) => ({ id: `working:${index}`, text })),
    ...(input.openLoops ?? []),
  ];
  const seen = new Set<string>();
  const workingItems = working.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  const itemsByLane: Record<SessionContextLaneName, SessionContextItem[]> = {
    pinned: (input.pinned ?? []).map((text, index) => ({ id: `pinned:${index}`, text })),
    profile: (input.profile ?? []).map((text, index) => ({ id: `profile:${index}`, text })),
    digest: digest.entries.map((entry) => ({
      id: entry.entryId,
      text: entry.text,
      speaker: entry.speaker,
      sourceRefs: entry.sourceRefs,
      ...(entry.sessionId !== input.sessionId ? { sourceSession: entry.sessionId } : {}),
      ...(stubIds.has(entry.entryId) || entry.kind === 'deep' ? { anchorEvent: entry.sourceRefs[0] } : {}),
    })),
    working_set: workingItems,
    recall: [...(input.recall ?? [])],
    tail: digest.tail.map((turn) => ({ id: turn.eventId, text: turn.text, speaker: turn.speaker, sourceRefs: [turn.eventId], ...(turn.sessionId !== input.sessionId ? { sourceSession: turn.sessionId } : {}) })),
  };
  itemsByLane.working_set = [
    ...workingItems,
    ...expandStubs(input, itemsByLane, protectedIds),
    ...expandDeepCards(input, digest, workingItems, protectedIds),
  ];
  const lanes: SessionContextLane[] = SESSION_CONTEXT_LANES.map((lane) => {
    const items = itemsByLane[lane].map((item) => isProtected(item, protectedIds) ? { ...item, protected: true } : item);
    const text = renderLane(lane, items);
    return {
      lane,
      priority: SESSION_CONTEXT_LANE_PRIORITY[lane],
      stable: (SESSION_CONTEXT_STABLE_LANES as readonly string[]).includes(lane),
      status: items.length > 0 ? 'included' : 'empty',
      tokens: sessionTokens(text),
      items,
      browseIds: [],
      text,
    };
  });
  return lanes;
}

/**
 * Deterministic auto-expansion (#253). A recall item is a stub when it carries `originalText` that
 * its own `text` does not already contain; it is expanded into `working_set` — before the request —
 * when the newest user message or the latest model output names it. The match is a literal,
 * normalized substring test over two things the stub itself carries:
 *
 * - its keys: `anchorEvent`, `sourceLocator` and every `sourceRefs` entry (`evt-…`);
 * - its entity words: the kernel's own verbatim anchors (`digestAnchors`: quoted spans, numbers
 *   with a separator or several digits, and names introduced by 叫/名叫/名字是), at least two
 *   characters long. No keyword list is kept here: the shapes are content-bearing on their own, so
 *   no stopword list is needed either. A single digit is dropped by the length floor; a quoted span
 *   matches as a whole, so the ordinary word that grazes it does not fire.
 *
 * An original already rendered in another lane is not expanded again, and a protected item is
 * never expanded: a constraint is already verbatim in its lane (#255). The read is the caller's;
 * this function only projects what the item already carries.
 */
function expandStubs(
  input: AssembleSessionContextInput,
  itemsByLane: Record<SessionContextLaneName, SessionContextItem[]>,
  protectedIds: ReadonlySet<string>,
): SessionContextItem[] {
  const haystack = normalizeMatchText((input.recentText ?? []).join('\n'));
  if (!haystack) return [];
  const present = new Set<string>();
  for (const items of Object.values(itemsByLane)) for (const item of items) present.add(item.text);
  const items: SessionContextItem[] = [];
  for (const item of input.recall ?? []) {
    const original = item.originalText;
    if (!original || original === item.text) continue;
    if (present.has(original) || isProtected(item, protectedIds)) continue;
    if (!stubMatches(item, haystack)) continue;
    present.add(original);
    items.push({
      id: item.id,
      text: original,
      ...(item.sourceRefs === undefined ? {} : { sourceRefs: item.sourceRefs }),
      ...(item.anchorEvent === undefined ? {} : { anchorEvent: item.anchorEvent }),
      ...(item.sourceLocator === undefined ? {} : { sourceLocator: item.sourceLocator }),
      autoExpanded: true,
    });
  }
  return items;
}

function stubMatches(item: SessionContextItem, haystack: string): boolean {
  const keys = [item.anchorEvent, item.sourceLocator, ...(item.sourceRefs ?? [])]
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  if (keys.some((key) => haystack.includes(normalizeMatchText(key)))) return true;
  return digestAnchors(item.text)
    .filter((term) => term.length >= 2)
    .some((term) => haystack.includes(normalizeMatchText(term)));
}

function expandDeepCards(
  input: AssembleSessionContextInput,
  digest: SessionDigest,
  workingItems: readonly SessionContextItem[],
  protectedIds: ReadonlySet<string>,
): SessionContextItem[] {
  const haystack = normalizeMatchText((input.recentText ?? []).join('\n'));
  if (!haystack) return [];
  const presentIds = new Set(workingItems.map((item) => item.id));
  const presentText = new Set(workingItems.map((item) => item.text));
  const items: SessionContextItem[] = [];
  for (const entry of digest.entries) {
    if (entry.kind !== 'deep' || presentIds.has(entry.entryId) || presentText.has(entry.text)) continue;
    if (isProtected({ id: entry.entryId, text: entry.text, sourceRefs: entry.sourceRefs }, protectedIds)) continue;
    if (!deepCardMatches(entry, haystack)) continue;
    items.push({
      id: entry.entryId,
      text: entry.text,
      sourceRefs: entry.sourceRefs,
      anchorEvent: entry.sourceRefs[0],
      whyMatched: 'deep_card',
      autoExpanded: true,
    });
  }
  return items;
}

function deepCardMatches(entry: SessionDigestEntry, haystack: string): boolean {
  if (entry.sourceRefs.some((ref) => haystack.includes(normalizeMatchText(ref)))) return true;
  const anchors = entry.text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('指针：'))
    .join('\n');
  return digestAnchors(anchors)
    .filter((term) => term.length >= 2)
    .some((term) => haystack.includes(normalizeMatchText(term)));
}

/** The experiment's normalization (#254): full-width to half-width, lower case, no whitespace. */
function normalizeMatchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/gu, '');
}

/**
 * The kernel's existing markers, not a new word list: an item the caller marked, an item whose id
 * a compiled book or correction named, or a turn the kernel's importance classifier rates
 * `permanent` (a prohibition such as 「绝对不能」).
 */
function isProtected(item: SessionContextItem, ids: ReadonlySet<string>): boolean {
  return item.protected === true
    || ids.has(item.id)
    || (item.sourceRefs ?? []).some((ref) => ids.has(ref))
    || ImportanceSignalDetector.detect(item.text) === 'permanent';
}

function hasFoldableItems(lane: SessionContextLane): boolean {
  return lane.items.some((item) => item.protected !== true);
}

function lastFoldableIndex(items: readonly SessionContextItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.protected !== true) return index;
  }
  return -1;
}

function renderLane(lane: SessionContextLaneName, items: SessionContextItem[]): string {
  if (items.length === 0) return '';
  if (lane === 'recall') return renderRecallLane(items);
  if (lane === 'digest') return renderDigestLane(items);
  return [`[${lane}]`, ...items.map(renderItemLine)].join('\n');
}

/**
 * The digest lane's task-exit stub carries its key on a second line (#263). An ordinary digest
 * entry prints no key line: it is the row itself, and `browseIds`/`sourceRefs` still name it.
 */
function renderDigestLane(items: SessionContextItem[]): string {
  const lines = ['[digest]'];
  for (const item of items) {
    lines.push(renderItemLine(item));
    if (item.anchorEvent) lines.push('  anchorEvent=' + serializeUntrustedMemory(item.anchorEvent, 160));
  }
  return lines.join('\n');
}

/**
 * A tail or digest line names who spoke (#324). The speaker is the ledger's own frozen value, so
 * the model can tell the owner's words from another person's and its own; line breaks stay indented
 * so a multi-line turn reads as one item rather than as a new lane structure.
 */
function renderItemLine(item: SessionContextItem): string {
  const speaker = item.speaker === undefined ? '' : `${item.speaker}: `;
  const source = item.sourceSession === undefined ? '' : `[from ${serializeUntrustedMemory(item.sourceSession, 160)}] `;
  return `- ${speaker}${source}${serializeUntrustedLaneText(item.text).replace(/\n/gu, '\n  ')}`;
}

function mergeTaskStubs(digest: SessionDigest, stubs: readonly SessionDigestEntry[]): SessionDigest {
  if (stubs.length === 0) return digest;
  const stubIds = new Set(stubs.map((stub) => stub.entryId));
  return {
    ...digest,
    entries: [...digest.entries.filter((entry) => !stubIds.has(entry.entryId)), ...stubs]
      .sort((left, right) => left.occurredAt - right.occurredAt || left.entryId.localeCompare(right.entryId)),
  };
}

function renderRecallLane(items: SessionContextItem[]): string {
  const lines = [
    '<COGMEM_RECALL_CONTEXT volatile="true" persistence="forbidden" lifecycle="current_turn_only" source="cogmem">',
    '[recall]',
  ];
  for (const item of items) {
    const prefix = item.trust === 'tool_observation' ? '[tool observation (untrusted)] ' : '';
    lines.push(`- ${prefix}${serializeUntrustedLaneText(item.text)}`);
    const keys: string[] = [];
    if (item.anchorEvent) keys.push('anchorEvent=' + serializeUntrustedMemory(item.anchorEvent, 160));
    if (item.whyMatched) keys.push('whyMatched=' + serializeUntrustedMemory(item.whyMatched, 180));
    if (item.sourceLocator) keys.push('sourceLocator=' + serializeUntrustedMemory(item.sourceLocator, 500));
    if (keys.length > 0) lines.push('  ' + keys.join('; '));
  }
  lines.push('</COGMEM_RECALL_CONTEXT>');
  return lines.join('\n');
}

/**
 * A downgraded lane's pointer: the item count plus one drill-down key per browse id that resolves
 * to a ledger event. `read mem:<eventId>` consumes the key directly (#252); an id with no event
 * behind it prints no key rather than a pointer that goes nowhere. A lane-local id
 * (`procedure:<entry>`) resolves through the item's own `anchorEvent`/`sourceRefs` first, so a
 * pointer that has a ledger row is not dropped just because its lane names it differently (#316).
 * The key list keeps the trace's
 * existing 20-id bound but takes the newest ids — the turns that just slid out of view — and the
 * header keeps the full count and says which segment the keys cover (#317).
 */
export function renderBrowseStub(
  lane: SessionContextLaneName,
  ids: readonly string[],
  keys: readonly string[] = ids.map(browseEventId).filter((id): id is string => id !== undefined),
): string {
  if (ids.length === 0) return '';
  const newest = keys.slice(-BROWSE_ID_LIMIT);
  return [
    `[${lane}: browse-only, ${ids.length} item(s); keys: newest ${newest.length} of ${ids.length}]`,
    ...newest.map((id) => '  anchorEvent=' + serializeUntrustedMemory(id, 160)),
  ].join('\n');
}

/**
 * A lane item's id is its lane-local name, not always a ledger id (`working:0`, `procedure:<entry>`).
 * The drill-down key is the id itself when it already names a row, else the item's anchor or first
 * source ref. One key per item keeps the header's item count and key count comparable.
 */
function browseKey(item: SessionContextItem): string | undefined {
  const own = browseEventId(item.id);
  if (own !== undefined) return own;
  const anchor = item.anchorEvent === undefined ? undefined : browseEventId(item.anchorEvent);
  if (anchor !== undefined) return anchor;
  return (item.sourceRefs ?? []).map(browseEventId).find((id) => id !== undefined);
}

function browseKeys(items: readonly SessionContextItem[]): string[] {
  return items.map(browseKey).filter((id): id is string => id !== undefined);
}

function browseEventId(id: string): string | undefined {
  if (id.startsWith('evt-')) return id;
  if (id.startsWith('digest:card:')) return id.slice('digest:card:'.length);
  if (id.startsWith('digest:evt-')) return id.slice('digest:'.length);
  return undefined;
}

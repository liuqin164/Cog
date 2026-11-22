import type { MemoryKernel } from '../factory.js';
import { socialTurnResources } from '../config/LanguagePacks.js';
import { readRedactionMarks } from '../governance/PiiRedactor.js';
import type { MemoryEvent } from '../types/index.js';
import { occasionMaterialOf, occasionVisibility, type Occasion, type OccasionDecision } from '../occasion/index.js';
import type { StrategyRetrievalPolicy } from '../strategy/StrategyCapsule.js';
import { inferYearForMonth } from '../temporal/RelativeDateRange.js';
import { pad2 } from '../utils/Values.js';
import type {
  AgentRecallDecisionTrace,
  AgentRecallItem,
  AgentRecallQuery,
  RecallSuppressionReason,
  RecallTraceSuppression,
} from './AgentMemoryTypes.js';
import { TOOL_OBSERVATION_PROMOTED_KEY } from './AgentMemoryTypes.js';

export function isToolObservationEvent(event: MemoryEvent): boolean {
  return event.rawEventType === 'tool_result' || event.rawEventType === 'tool_call' || event.role === 'tool';
}

export function isPromotedToolObservation(event: MemoryEvent): boolean {
  const metadata = (event.payload as { metadata?: Record<string, unknown> }).metadata;
  return metadata?.[TOOL_OBSERVATION_PROMOTED_KEY] === true;
}

export function sameRecallContent(left: string, right: string): boolean {
  const a = left.trim().replace(/\s+/g, ' ');
  const b = right.trim().replace(/\s+/g, ' ');
  return a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a));
}

export function discriminativeProbesOf(text: string): string[] {
  const probes = new Set<string>();
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) probes.add(run.slice(index, index + 2));
    if (run.length > 1) probes.add(run);
  }
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? []) probes.add(word.toLowerCase());
  for (const digits of text.match(/\d+/g) ?? []) probes.add(digits);
  return [...probes];
}

/**
 * Whether every word an item shares with the question is small talk.
 *
 * This is defence 3's decision, and defence 4's for a grey query. Frequency alone is not evidence: an
 * answer deliberately worded like seven others overlaps its question only through common words, and
 * discarding on frequency alone suppressed exactly that answer. So a hit is dropped only when the
 * whole overlap is both frequent in this project and part of the shared pleasantry vocabulary.
 */
export function overlapIsOnlySmallTalk(overlap: string[], frequent: Set<string>): boolean {
  return overlap.length > 0 && overlap.every((term) => frequent.has(term) && isFillerProbe(term));
}

/**
 * The probes a question is reduced to for the discriminator check: CJK bigrams and whole runs, latin
 * words, numbers. The index matches consecutive characters, so a bigram is a valid probe.
 */
export function discriminativeProbes(text: string): string[] {
  return discriminativeProbesOf(text);
}

/**
 * Characters a question says about itself rather than about the thing it asks for. This is
 * deliberately short: the floor is one shared content unit, and every extra "neutral" character
 * makes malformed recall easier to let through.
 */
const RELEVANCE_FLOOR_NEUTRAL = new Set([
  ...'我你他她它们您咱的得地了着过这那哪那个些把帮更什么怎吗呢吧啊',
]);

/**
 * The content units a question carries: Han characters minus the neutral set above, latin words of
 * two characters or more, and numbers. A unit that appears in an item's own text is evidence the item
 * is about the question, however weak; no unit at all is what an unrelated old fact looks like (#321).
 */
export function contentCues(text: string): string[] {
  const cues = new Set<string>();
  for (const character of text) {
    if (/\p{Script=Han}/u.test(character) && !RELEVANCE_FLOOR_NEUTRAL.has(character) && !isFillerProbe(character)) cues.add(character);
  }
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? []) cues.add(word.toLowerCase());
  for (const digits of text.match(/\d+/g) ?? []) cues.add(digits);
  return [...cues];
}

/** The content units the question and the entry share; the general relevance floor is length 1. */
export function contentCueOverlap(query: string, text: string): string[] {
  const haystack = text.toLowerCase();
  return contentCues(query).filter((cue) => haystack.includes(cue));
}

/**
 * The characters a pack's pleasantry vocabulary is made of, built once per pack.
 *
 * Keyed by the token array itself, so switching languages does not rebuild the set and the two packs cannot
 * collide.
 */
const FILLER_CHARACTERS_BY_PACK = new WeakMap<readonly string[], Set<string>>();
export function fillerCharacters(tokens: readonly string[]): Set<string> {
  let characters = FILLER_CHARACTERS_BY_PACK.get(tokens);
  if (!characters) {
    characters = new Set(tokens.join(''));
    FILLER_CHARACTERS_BY_PACK.set(tokens, characters);
  }
  return characters;
}

/**
 * Whether a probe is made only of pleasantry characters — the shape a social overlap has.
 *
 * Character-level rather than token-level because the probes are n-grams: 「的收」 is a bigram of
 * 「好的收到」 and every character in it comes from the pleasantry vocabulary. A content character never
 * qualifies, which is what keeps an answer out of this rule.
 *
 * The vocabulary is read here, at call time (#174), not frozen into a module constant at import. The constant
 * was built before `MemoryKernel`'s constructor called `setConfiguredLanguage`, so in an `en` project this half
 * of the judgement token-checked against the Chinese pack while `classifySocialTurn` — which reads the pack per
 * call — used English.
 */
export function isFillerProbe(probe: string): boolean {
  if (probe.length === 0) return false;
  const tokens = socialTurnResources().fillerTokens;
  // Token coverage first, which is what keeps a latin word safe: 「later」 and 「ty」 contribute the
  // letters of 「retry」 to the character set, so a character test alone would call a content word
  // small talk.
  let rest = probe;
  for (const token of tokens) {
    while (rest.includes(token)) rest = rest.split(token).join('');
  }
  if (rest.length === 0) return true;
  // Then CJK n-grams, where the probes are bigrams of pleasantries like 「好的收到」 and the individual
  // characters are what can be checked. Never applied to a probe holding a non-CJK character.
  return /^\p{Script=Han}+$/u.test(probe) && [...probe].every((character) => fillerCharacters(tokens).has(character));
}

/**
 * The raw events a running recall withheld because they carry the secret mark (#142), by id.
 *
 * A set rather than a counter: the trace has to name the withheld entries (#187), and the lane can
 * reach the same event through more than one search text. Reset at the top of every recall, so it
 * never describes a previous one.
 */
export const SECRET_WITHHELD_EVENT_IDS = new WeakMap<object, Set<string>>();
export const LIFE_SENSITIVITY_WITHHELD_EVENT_IDS = new WeakMap<object, Set<string>>();

/** How many index hits a zero-result explanation samples: enough to tell scope from absence. */
export const ZERO_EXPLANATION_SAMPLE = 25;

/** Turn metadata without the conversation-text secret marks: those belong to their own event. */
export function omitSecretFindings(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const { secretFindings, secretFindingsAssistant, ...rest } = metadata as Record<string, unknown> & {
    secretFindings?: unknown; secretFindingsAssistant?: unknown;
  };
  if (secretFindingsAssistant !== undefined) rest.secretFindings = secretFindingsAssistant;
  return rest;
}

/** Intents that explicitly ask for words as they were said: those may reach social entries. */
export const FORENSIC_SOCIAL_EXEMPT_INTENTS = new Set(['forensic_quote', 'exact_quote']);

/** Fold a new suppression breakdown into whatever the lane trace already carried. */
/**
 * The events behind one anchor (#142, #144, #143): the anchor, then the raw events a compile-layer
 * anchor was built from.
 *
 * A compiled item anchors an event that carries no turn of its own (measured: `turn_id` null, no
 * mark), while both the secret mark and the source agent sit on the turn's events. The link between
 * them is in the ledger already — that event's payload lists the raw events it was built from — so
 * the questions are asked of those events rather than answered by scanning text, which is what
 * dropped a legitimate record that merely looked like a key (#144). One walk, shared by the secret
 * gate, the agent scope and the occasion gate, because separate walks would drift apart; bounded by
 * one event's own source refs.
 */
export function occasionChainEvents(kernel: MemoryKernel, eventId: string | undefined): MemoryEvent[] {
  if (!eventId) return [];
  const context = kernel.getEventContext(eventId, { before: 0, after: 0 });
  // A lane may point at an event this database no longer has; absence is not a secret and says
  // nothing about who owns it. A read that *fails* is not absence and is not swallowed here: it
  // would make the item both visible and unmarked.
  if (!context) return [];
  const chain: MemoryEvent[] = [context.event];
  const sourceRefs = (context.event.payload as { sourceRefs?: unknown } | undefined)?.sourceRefs;
  if (!Array.isArray(sourceRefs)) return chain;
  for (const ref of sourceRefs.slice(0, 16)) {
    const refId = (ref as { eventId?: unknown } | undefined)?.eventId;
    if (typeof refId !== 'string') continue;
    const referenced = kernel.getEventContext(refId, { before: 0, after: 0 })?.event;
    if (referenced) chain.push(referenced);
  }
  return chain;
}

/** The text an event carries, for classifying a context neighbour. */
export function occasionEventText(event: MemoryEvent): string {
  const payload = event.payload as { text?: unknown; output?: unknown; title?: unknown };
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.output === 'string') return payload.output;
  if (typeof payload.title === 'string') return payload.title;
  return JSON.stringify(event.payload);
}

/**
 * The one material judgement the recall face uses (#162): grade the text and its events with F6's
 * classifier, then apply the frozen visibility table. `events` is the candidate's own chain; empty
 * means `personal`, because absence is not a public declaration.
 */
export function occasionDecisionFor(
  kernel: MemoryKernel,
  occasion: Occasion,
  input: {
    projectId?: string;
    text: string;
    events: readonly MemoryEvent[];
    sourceType?: string;
  },
): OccasionDecision {
  const classification = kernel.surfacing.classify({
    projectId: input.projectId ?? '',
    eventIds: input.events.map((event) => event.eventId),
    text: input.text,
    sourceType: input.sourceType,
  });
  return occasionVisibility(occasion, classification.tier, occasionMaterialOf(input.events));
}

export function mergeSuppressions(
  existing: Array<{ reason: RecallSuppressionReason; count: number }> | undefined,
  added: Array<{ reason: RecallSuppressionReason; count: number }>,
): Array<{ reason: RecallSuppressionReason; count: number }> {
  const merged = [...(existing ?? [])];
  for (const entry of added) {
    const found = merged.find((item) => item.reason === entry.reason);
    if (found) found.count += entry.count;
    else merged.push({ ...entry });
  }
  return merged;
}

/**
 * The trace's suppression list: the lane trace's counts, with the ids the gates kept (#187).
 *
 * A reason can be counted without an id — the raw lane drops secret-marked events before any item
 * exists — so an entry with a count and no ids is the honest answer, not a missing one. Ids are only
 * ever added, never turned into a second count.
 */
export function suppressionsForTrace(
  suppressed: Array<{ reason: RecallSuppressionReason; count: number }> | undefined,
  byId: RecallTraceSuppression[],
): RecallTraceSuppression[] | undefined {
  const merged = new Map<string, RecallTraceSuppression>();
  for (const entry of suppressed ?? []) merged.set(entry.reason, { reason: entry.reason, count: entry.count });
  for (const entry of byId) {
    if (entry.ids?.length) {
      const existing = merged.get(entry.reason);
      if (existing) existing.ids = [...(existing.ids ?? []), ...entry.ids];
      else merged.set(entry.reason, { reason: entry.reason, count: entry.ids.length, ids: [...entry.ids] });
    }
  }
  return merged.size ? [...merged.values()] : undefined;
}

export function recallDecisionTrace(
  selectedLane: AgentRecallDecisionTrace['selectedLane'],
  reason: AgentRecallDecisionTrace['reason'],
  candidateCounts: AgentRecallDecisionTrace['candidateCounts'],
  selectedCount: number,
): AgentRecallDecisionTrace {
  return {
    version: 'agent_recall_decision.v1',
    selectedLane,
    reason,
    candidateCounts,
    selectedCount,
  };
}

export function recallDecisionTraceForSelection(
  graphItems: AgentRecallItem[],
  selectedItems: AgentRecallItem[],
  nonGraphLane: AgentRecallDecisionTrace['selectedLane'],
  nonGraphReason: AgentRecallDecisionTrace['reason'],
  candidateCounts: AgentRecallDecisionTrace['candidateCounts'],
): AgentRecallDecisionTrace {
  const graphIds = new Set(graphItems.map((item) => item.id));
  const graphSelected = selectedItems.filter((item) => graphIds.has(item.id)).length;
  if (graphSelected > 0 && graphSelected === selectedItems.length) {
    return recallDecisionTrace('graph', 'graph_selected', candidateCounts, selectedItems.length);
  }
  if (graphSelected > 0) {
    return recallDecisionTrace('mixed', nonGraphReason, candidateCounts, selectedItems.length);
  }
  return recallDecisionTrace(nonGraphLane, nonGraphReason, candidateCounts, selectedItems.length);
}

export function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function laneAllowed(policy: StrategyRetrievalPolicy | undefined, lane: StrategyRetrievalPolicy['allowedLanes'][number]): boolean {
  return !policy || policy.allowedLanes.includes(lane);
}

export function localDateCue(query: string, options: Pick<AgentRecallQuery, 'now' | 'localDateNow' | 'timeZone'> = {}): string | undefined {
  const iso = query.match(/(20\d{2})[-年\/.](\d{1,2})[-月\/.](\d{1,2})日?/);
  if (iso) return `${iso[1]}-${padDatePart(Number(iso[2]))}-${padDatePart(Number(iso[3]))}`;
  const cn = query.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})(?:号|日)?/);
  if (cn) {
    const year = cn[1] ?? inferYearForMonth(Number(cn[2]), options);
    return `${year}-${padDatePart(Number(cn[2]))}-${padDatePart(Number(cn[3]))}`;
  }
  return undefined;
}

export function padDatePart(value: number): string {
  return pad2(value);
}

/**
 * Mark an item whose text has been through redaction, without touching the text.
 * A caller that cannot see the difference between what was written and what it was
 * given will quote the marker back as if it were the value (#115).
 */
export function withRedactionMarks(item: AgentRecallItem): AgentRecallItem {
  const redaction = readRedactionMarks(item.text);
  return redaction.count > 0 ? { ...item, redaction } : item;
}

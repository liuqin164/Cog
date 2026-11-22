/**
 * A profile correction is the owner's last word, and it is not local to the profile book (#242).
 *
 * Every corrected version already lands on `profile-entry:<entryId>` as a
 * `PROFILE_ENTRY_CORRECTED` row. This module is the read side of that row for the other compiled
 * books: it names the value that was replaced and the evidence that used to support it, so a
 * derived product can be updated or marked stale instead of presenting the old value as current.
 *
 * The row is the signal. Nothing here writes.
 */
import { profileCues } from './ProfileCompiler.js';
import type { EventStore } from '../store/EventStore.js';
import type { MemorySourceRef } from '../types/index.js';

export interface ProfileCorrectionSignal {
  projectId: string;
  entryId: string;
  ledger?: string;
  key: string;
  value: string;
  /** The value this correction replaced. Absent only on rows written before this field existed. */
  previousValue?: string;
  /** The evidence the replaced value was compiled from. */
  previousSourceRefs: MemorySourceRef[];
  correctionEventId?: string;
  occurredAt: number;
}

const LEDGER_PAGE_SIZE = 500;

/** Every correction in one project, oldest first. */
export function profileCorrectionSignals(events: EventStore, projectId: string): ProfileCorrectionSignal[] {
  const rows: ProfileCorrectionSignal[] = [];
  const filters = {
    projectId: [projectId],
    eventType: ['PROFILE_ENTRY_CORRECTED' as const],
    order: 'asc' as const,
  };
  for (let page = 1; ; page += 1) {
    const result = events.queryEvents(page, LEDGER_PAGE_SIZE, filters);
    if (result.records.length === 0) break;
    for (const event of result.records) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
      const key = typeof payload.key === 'string' ? payload.key : '';
      const value = typeof payload.value === 'string' ? payload.value : '';
      if (!entryId || !key || !value) continue;
      const sourceRefs = Array.isArray(payload.sourceRefs) ? payload.sourceRefs as MemorySourceRef[] : [];
      const correctionEventId = typeof payload.correctionEventId === 'string'
        ? payload.correctionEventId
        : sourceRefs[sourceRefs.length - 1]?.eventId;
      rows.push({
        projectId,
        entryId,
        ledger: typeof payload.ledger === 'string' ? payload.ledger : undefined,
        key,
        value,
        previousValue: typeof payload.previousValue === 'string' ? payload.previousValue : undefined,
        previousSourceRefs: Array.isArray(payload.previousSourceRefs)
          ? payload.previousSourceRefs as MemorySourceRef[]
          : sourceRefs.filter((ref) => ref.eventId !== correctionEventId),
        correctionEventId,
        occurredAt: event.occurredAt,
      });
    }
    if (rows.length >= result.total) break;
  }
  return rows;
}

/** The raw evidence a correction replaced. A derived item anchored there is not current. */
export function supersededSourceEventIds(signals: readonly ProfileCorrectionSignal[]): Set<string> {
  const ids = new Set<string>();
  for (const signal of signals) {
    for (const ref of signal.previousSourceRefs) if (ref.eventId) ids.add(ref.eventId);
  }
  return ids;
}

/**
 * Whether a derived item is about the claim this correction replaced.
 *
 * Source overlap is exact evidence. Text overlap is the fallback for products compiled before the
 * source link existed: the old value's own cues must overlap, and a single shared CJK bigram or
 * English word is not enough unless the old value carried only one cue. An item recorded after the
 * correction is newer evidence, not a stale derivation.
 */
export function correctionAffects(
  signal: ProfileCorrectionSignal,
  input: { text?: string; sourceRefs?: MemorySourceRef[]; recordedAt?: number },
): boolean {
  if (input.recordedAt !== undefined && input.recordedAt >= signal.occurredAt) return false;
  const oldIds = new Set(signal.previousSourceRefs.map((ref) => ref.eventId).filter((id): id is string => Boolean(id)));
  if (input.sourceRefs?.some((ref) => ref.eventId && oldIds.has(ref.eventId))) return true;
  if (!signal.previousValue || !input.text) return false;
  const old = signal.previousValue.trim().toLowerCase();
  const text = input.text.toLowerCase();
  if (old && text.includes(old)) return true;
  const cues = profileCues(signal.previousValue);
  if (cues.length === 0) return false;
  const hits = cues.filter((cue) => text.includes(cue.toLowerCase())).length;
  return hits >= Math.min(2, cues.length);
}

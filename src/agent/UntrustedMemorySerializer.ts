import { stripCogmemRecallBlocks } from './ContextHygiene.js';

/** A line that a reader could mistake for the start of another lane (#347). */
const LANE_HEADER_RE = /^([ \t]*)\[(pinned|profile|digest|working_set|recall|tail)(?=[\]\s:])/gmu;

function stripEnvelope(input: unknown): string {
  return stripCogmemRecallBlocks(String(input ?? '')).text
    .replace(/<\/?COGMEM_[A-Z0-9_:-]+[^>]*>/gi, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

function escapeMarkup(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function serializeUntrustedMemory(input: unknown, limit = 500): string {
  const clean = escapeMarkup(stripEnvelope(input).replace(/\s+/g, ' ').trim());
  return clean.slice(0, Math.max(0, limit));
}

/**
 * Untrusted lane body text. The envelope's own tags are stripped as in
 * {@link serializeUntrustedMemory}, but the line breaks and the rest of the text stay: a lane
 * renders a multi-line turn as one indented item. A body line that spells a lane header has
 * its `[` escaped, so it cannot close the current lane and open another (#347).
 */
export function serializeUntrustedLaneText(input: unknown): string {
  return stripEnvelope(input).replace(LANE_HEADER_RE, '$1&#91;$2');
}

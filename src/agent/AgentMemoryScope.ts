import type { MemoryEvent } from '../types/index.js';
import { uniqueNonEmpty } from './AgentRecallText.js';

export function metadataWithCollection(
  metadata: Record<string, unknown> | undefined,
  collection: string | undefined
): Record<string, unknown> | undefined {
  const tags = collectionTags(collection);
  if (tags.length === 0) return metadata;
  const existingTags = Array.isArray(metadata?.tags)
    ? metadata!.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    ...(metadata || {}),
    collection: normalizeCollection(collection),
    tags: uniqueNonEmpty([...existingTags, ...tags]),
  };
}

export function collectionTags(collection: string | undefined): string[] {
  const normalized = normalizeCollection(collection);
  return normalized ? [`collection:${normalized}`] : [];
}

export function normalizeCollection(collection: string | undefined): string | undefined {
  const normalized = String(collection || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  return normalized || undefined;
}

export function isAllowedRawEventCollection(event: MemoryEvent, collection: string | undefined): boolean {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as { metadata?: Record<string, unknown> }
    : {};
  const tags = Array.isArray(payload.metadata?.tags)
    ? payload.metadata.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return isAllowedCollectionTags(tags, collection);
}

export function isAllowedCollectionTags(tags: string[], collection: string | undefined): boolean {
  const tagsOfCollection = tags.filter((tag) => tag.startsWith('collection:'));
  const requested = normalizeCollection(collection);
  if (requested) {
    if (requested === 'anchor' && tagsOfCollection.length === 0) return true;
    return tagsOfCollection.includes(`collection:${requested}`);
  }
  return tagsOfCollection.length === 0 || tagsOfCollection.includes('collection:anchor');
}

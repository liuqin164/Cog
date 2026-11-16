import type { EmbeddingProvider } from './EmbeddingProvider.js';
import type { NeuronEmbeddingStore } from './NeuronEmbeddingStore.js';

/**
 * The synchronous query lane: providers that can answer without the event loop
 * expose `embedSync` (the shell's worker-backed Xenova provider does). A provider
 * without it yields no vector candidates, so recall stays lexical.
 */
export interface SyncEmbeddingProvider extends EmbeddingProvider {
  embedSync?: (text: string) => Float32Array;
  embedSyncDocument?: (text: string) => Float32Array;
}

export function nearestNeuronIds(
  store: NeuronEmbeddingStore,
  provider: EmbeddingProvider,
  query: string,
  projectId: string | undefined,
  limit: number,
): string[] {
  const embedSync = (provider as SyncEmbeddingProvider).embedSync;
  if (!embedSync) return [];
  const vector = embedSync.call(provider, query);
  if (vector.length === 0) return [];
  return store.findNearest(vector, projectId, limit, provider.modelId).map((item) => item.neuronId);
}

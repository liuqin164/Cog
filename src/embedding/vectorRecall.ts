import type { EmbeddingProvider } from './EmbeddingProvider.js';

/**
 * The synchronous query lane: providers that can answer without the event loop
 * expose `embedSync` (the shell's worker-backed Xenova provider does). A provider
 * without it yields no vector candidates, so recall stays lexical.
 */
export interface SyncEmbeddingProvider extends EmbeddingProvider {
  embedSync?: (text: string) => Float32Array;
  embedSyncDocument?: (text: string) => Float32Array;
}


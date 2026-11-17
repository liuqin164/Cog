/**
 * Supply step for the embedding model (#250): make `<dataDir>/models/` complete, or say why not.
 *
 * The installer and the resident's first start share this. A failure is never fatal: the companion
 * answers with lexical recall and the caller reports the degradation. The download is the official
 * Hugging Face Xenova repository, resolved by `@huggingface/transformers` itself.
 */
import { mkdirSync } from 'node:fs';
import { env, pipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL, embeddingModelPresent, embeddingModelsRoot } from './model.ts';

export interface EmbeddingProgress {
  status?: string;
  file?: string;
  progress?: number;
}

export interface EmbeddingEnsureResult {
  ok: boolean;
  downloaded: boolean;
  detail: string;
}

export async function ensureEmbeddingModel(
  dataDir: string,
  onProgress?: (progress: EmbeddingProgress) => void,
): Promise<EmbeddingEnsureResult> {
  if (embeddingModelPresent(dataDir)) {
    return { ok: true, downloaded: false, detail: 'already present' };
  }
  const root = embeddingModelsRoot(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  env.localModelPath = root;
  env.cacheDir = root;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  try {
    const loaded = await pipeline('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'q8',
      progress_callback: (progress: EmbeddingProgress) => onProgress?.(progress),
    });
    (loaded as { dispose?: () => void }).dispose?.();
    if (!embeddingModelPresent(dataDir)) {
      return { ok: false, downloaded: true, detail: 'download finished but the model files are not in place' };
    }
    return { ok: true, downloaded: true, detail: 'downloaded' };
  } catch (error) {
    return { ok: false, downloaded: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

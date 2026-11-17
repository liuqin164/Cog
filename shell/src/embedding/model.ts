/**
 * The one embedding model this shell ships with (#250). It lives beside the brain, under
 * `<dataDir>/models/`, so a backup or a move of the data directory carries it along and a
 * second install on the same machine does not silently share a global cache.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const EMBEDDING_MODEL = 'Xenova/bge-base-zh-v1.5';
export const EMBEDDING_DIMENSIONS = 768;
/** The model card's retrieval instruction; queries carry it, documents are embedded as written. */
export const EMBEDDING_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

export type EmbeddingProviderKind = 'local' | 'ollama' | 'openai';

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind;
  /** Ollama host, or the OpenAI-compatible `/embeddings` endpoint. */
  baseUrl: string;
  model: string;
  /** The dimension the configured model produces. Local is fixed at 768. */
  dimensions?: number;
  /** Query-only instruction. The bge-zh prefix is model-specific; remote models default to empty. */
  queryPrefix: string;
}

export type EmbeddingState = 'idle' | 'loading' | 'active' | 'degraded';

export interface EmbeddingStatus {
  state: EmbeddingState;
  modelId: string;
  dimensions: number;
  detail?: string;
  loadMs?: number;
}

export const REMOTE_EMBEDDING_DEFAULTS: Record<Exclude<EmbeddingProviderKind, 'local'>, { baseUrl: string; model: string; dimensions: number }> = {
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen3-embedding:0.6b', dimensions: 1024 },
  openai: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', model: 'text-embedding-v3', dimensions: 1024 },
};

export function embeddingModelsRoot(dataDir: string): string {
  return join(dataDir, 'models');
}

export function embeddingModelDir(dataDir: string): string {
  return join(embeddingModelsRoot(dataDir), ...EMBEDDING_MODEL.split('/'));
}

/** Both files are needed before the local-only load can succeed. */
export function embeddingModelPresent(dataDir: string): boolean {
  const dir = embeddingModelDir(dataDir);
  return existsSync(join(dir, 'onnx', 'model_quantized.onnx')) && existsSync(join(dir, 'tokenizer.json'));
}

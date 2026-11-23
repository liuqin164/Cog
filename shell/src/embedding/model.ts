import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMBEDDING_MODEL = 'Xenova/bge-base-zh-v1.5';
export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
export const LOCAL_EMBEDDING_RUNTIME = '@huggingface/transformers@^4.3.2';
export function embeddingRuntimePresent(): boolean {
  for (let dir = dirname(fileURLToPath(import.meta.url)); !existsSync(join(dir, 'node_modules', '@huggingface', 'transformers', 'package.json')); dir = dirname(dir)) {
    if (dirname(dir) === dir) return false;
  }
  return true;
}

export type EmbeddingProviderKind = 'local' | 'ollama' | 'openai';

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind;
  baseUrl: string;
  model: string;
  dimensions?: number;
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

export function embeddingModelPresent(dataDir: string): boolean {
  const dir = embeddingModelDir(dataDir);
  return existsSync(join(dir, 'onnx', 'model_quantized.onnx')) && existsSync(join(dir, 'tokenizer.json'));
}

/**
 * The shell's embedding choice (#313): local bge by default, or a remote Ollama / OpenAI-compatible
 * endpoint. The kernel providers are used as-is; this module only resolves the configuration and
 * picks the implementation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OllamaEmbeddingProvider, type EmbeddingProvider } from 'cogmem';
import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingConfig,
  type EmbeddingStatus,
} from './model.ts';
import { buildInnerProvider, RemoteEmbeddingProvider } from './remote.ts';
import { XenovaEmbeddingProvider } from './xenova.ts';

export interface ShellEmbeddingProvider extends EmbeddingProvider {
  status(): EmbeddingStatus;
  warm(): Promise<void>;
  dispose?(): void;
  embedSync?: (text: string) => Float32Array;
  embedSyncDocument?: (text: string) => Float32Array;
}

/**
 * The key's only persistent home is the installer's 0600 env file. The service reads that file as
 * its environment; a bare `cog` run points at the same data directory. It never enters ShellConfig,
 * the trace, or an install report.
 */
export function readEmbeddingApiKey(dataDir: string): string {
  const path = join(dataDir, 'env');
  if (!existsSync(path)) return '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^COGMEM_EMBEDDING_API_KEY=(.*)$/u.exec(line);
    if (match) return match[1]!.trim();
  }
  return '';
}

export function resolveEmbeddingDimensions(config: EmbeddingConfig): number {
  if (config.provider === 'local') return EMBEDDING_DIMENSIONS;
  if (config.dimensions !== undefined) return config.dimensions;
  if (config.provider === 'openai') return 1024;
  return new OllamaEmbeddingProvider({ baseUrl: config.baseUrl, model: config.model }).dimensions;
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  dataDir: string,
  onState?: (status: EmbeddingStatus) => void,
): ShellEmbeddingProvider {
  if (config.provider === 'local') {
    return new XenovaEmbeddingProvider(dataDir, onState, 15_000, true, config.queryPrefix);
  }
  return new RemoteEmbeddingProvider(
    {
      kind: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.provider === 'openai' ? readEmbeddingApiKey(dataDir) : '',
      dimensions: resolveEmbeddingDimensions(config),
    },
    config.queryPrefix,
    onState,
  );
}

export interface EmbeddingProbeResult {
  ok: boolean;
  dimensions?: number;
  detail: string;
}

/**
 * The installer's step-2 probe for a remote provider. The local model is a real ONNX load, so its
 * probe stays where it already is: the resident's first-wake check. A remote endpoint is cheap to
 * call now, and failing here stops the install before the resident is registered.
 */
export async function probeEmbedding(config: EmbeddingConfig, apiKey: string): Promise<EmbeddingProbeResult> {
  if (config.provider === 'local') {
    return { ok: true, dimensions: EMBEDDING_DIMENSIONS, detail: 'local model is checked by the resident' };
  }
  const dimensions = resolveEmbeddingDimensions(config);
  try {
    const provider = buildInnerProvider({
      kind: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey,
      dimensions,
    });
    const [vector] = await provider.embedBatch(['安装自检：向量探针']);
    if (!vector) return { ok: false, detail: 'provider returned no vector' };
    if (vector.length !== dimensions) {
      return { ok: false, detail: `维度 ${vector.length}，期望 ${dimensions}` };
    }
    return { ok: true, dimensions: vector.length, detail: `${config.provider} returned ${vector.length} dimensions` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

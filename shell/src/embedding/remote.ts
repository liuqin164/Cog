/**
 * Remote embedding providers (#313): the kernel's Ollama and OpenAI-compatible implementations,
 * reached from the shell's own process.
 *
 * The kernel's synchronous recall lane asks for `embedSync`, and an HTTP call cannot answer it on
 * the main thread. The same worker/SharedArrayBuffer bridge the local model uses is therefore kept
 * here: async calls go through the worker too, so a re-embed batch and a query share one queue.
 *
 * shortcut: the provider interface has no query/document flag, so a live-written neuron goes through
 * `embed()` and gets the query prefix too. Re-embedded documents and queries stay consistent;
 * revisit if the interface ever gains the distinction.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { OllamaEmbeddingProvider, QwenAPIEmbeddingProvider, type EmbeddingProvider } from 'cogmem';
import type { EmbeddingConfig, EmbeddingState, EmbeddingStatus } from './model.ts';

type RemoteKind = Exclude<EmbeddingConfig['provider'], 'local'>;

export interface RemoteEmbeddingSettings {
  kind: RemoteKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions: number;
}

/** OpenAI-compatible clients take a base URL; the kernel provider takes the full endpoint. */
export function openAiEndpoint(baseUrl: string): string {
  if (baseUrl === '') return 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
  return /\/embeddings\/?$/u.test(baseUrl) ? baseUrl.replace(/\/+$/u, '') : `${baseUrl.replace(/\/+$/u, '')}/embeddings`;
}

/** The kernel implementations stay the ones that speak HTTP; this only builds the right one. */
export function buildInnerProvider(settings: RemoteEmbeddingSettings): EmbeddingProvider {
  // A cold Ollama load can exceed the kernel provider's 10 s default; the shell's warm probe is
  // allowed to wait, while the synchronous recall lane keeps its own 15 s bound.
  const timeoutMs = 30_000;
  if (settings.kind === 'ollama') {
    return new OllamaEmbeddingProvider({ baseUrl: settings.baseUrl, model: settings.model, timeoutMs });
  }
  return new QwenAPIEmbeddingProvider({
    apiKey: settings.apiKey,
    model: settings.model,
    baseUrl: openAiEndpoint(settings.baseUrl),
    timeoutMs,
  });
}

/**
 * The dimension is part of the stored model id. A server that changes a model's dimension without
 * changing its name then makes every old row stale, which is what sends it through ReEmbeddingPipeline.
 */
export function remoteModelId(kind: RemoteKind, model: string, dimensions: number): string {
  return `${kind}/${model}@${dimensions}`;
}

export function remoteWorkerScript(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './remote-worker.ts' : './remote-worker.js', import.meta.url));
}

type Pending = { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void };

const EMPTY = new Float32Array(0);

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelId: string;

  private worker?: Worker;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private state: EmbeddingState = 'idle';
  private disposed = false;
  private detail?: string;
  private loadMs?: number;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly settings: RemoteEmbeddingSettings,
    private readonly queryPrefix: string,
    private readonly onState?: (status: EmbeddingStatus) => void,
    /** How long a synchronous recall may wait for a query, including a batch ahead of it. */
    private readonly syncTimeoutMs = 15_000,
  ) {
    this.dimensions = settings.dimensions;
    this.modelId = remoteModelId(settings.kind, settings.model, settings.dimensions);
  }

  status(): EmbeddingStatus {
    return {
      state: this.state,
      modelId: this.modelId,
      dimensions: this.dimensions,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.loadMs !== undefined ? { loadMs: this.loadMs } : {}),
    };
  }

  /** Starts the worker and proves the endpoint returns a vector of the configured dimension. */
  warm(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.setState('loading');
    try {
      this.worker = new Worker(remoteWorkerScript());
    } catch (error) {
      this.fail(error);
      return this.ready;
    }
    this.worker.on('message', (message: Record<string, unknown>) => this.onMessage(message));
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.disposed) this.fail(new Error(`embedding worker exited with code ${code}`));
    });
    this.worker.unref();
    this.worker.postMessage({ type: 'init', ...this.settings });
    return this.ready;
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([this.queryPrefix + text]);
    if (!vector) throw new Error('embedding returned no vector');
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.whenReady();
    const id = this.nextId++;
    const response = new Promise<Float32Array[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.worker!.postMessage({ type: 'embed', id, texts });
    return response;
  }

  /** The synchronous recall lane: a query vector, or an empty one when the provider is not ready. */
  readonly embedSync = (text: string): Float32Array => this.embedSyncWith(this.queryPrefix + text);

  readonly embedSyncDocument = (text: string): Float32Array => this.embedSyncWith(text);

  private embedSyncWith(text: string): Float32Array {
    if (this.state !== 'active' || !this.worker) return EMPTY;
    const sab = new SharedArrayBuffer(4 + this.dimensions * 4);
    const flag = new Int32Array(sab, 0, 1);
    const out = new Float32Array(sab, 4);
    this.worker.postMessage({ type: 'embedSync', text, sab });
    const waited = Atomics.wait(flag, 0, 0, this.syncTimeoutMs);
    if (waited !== 'ok' || Atomics.load(flag, 0) !== 1) return EMPTY;
    return out.slice();
  }

  dispose(): void {
    this.disposed = true;
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error('embedding provider disposed'));
    this.pending.clear();
  }

  private whenReady(): Promise<void> {
    if (this.state === 'active') return Promise.resolve();
    if (this.ready) return this.ready;
    return Promise.reject(new Error('embedding_unavailable: provider was not warmed'));
  }

  private onMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'ready':
        this.loadMs = Number(message.loadMs ?? 0);
        this.detail = undefined;
        this.setState('active');
        this.resolveReady?.();
        return;
      case 'failed':
        this.fail(new Error(String(message.message ?? 'embedding provider failed')));
        return;
      case 'embedded': {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        this.pending.delete(Number(message.id));
        pending.resolve((message.vectors as Float32Array[]).map((vector) => new Float32Array(vector)));
        return;
      }
      case 'embed_failed': {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        this.pending.delete(Number(message.id));
        this.fail(new Error(String(message.message ?? 'embedding failed')));
        return;
      }
      case 'sync_failed':
        this.fail(new Error(String(message.message ?? 'embedding failed')));
        return;
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.detail = message;
    this.setState('degraded');
    this.rejectReady?.(new Error(`embedding_unavailable: ${message}`));
    for (const pending of this.pending.values()) pending.reject(new Error(`embedding_unavailable: ${message}`));
    this.pending.clear();
  }

  private setState(state: EmbeddingState): void {
    this.state = state;
    this.onState?.(this.status());
  }
}

/**
 * The local embedding provider (#250): `Xenova/bge-base-zh-v1.5`, quantized, 768 dimensions.
 *
 * `embed()` and `embedSync()` are the query paths (`BrainRecall` calls both); `embedBatch()` is the
 * document path (`ReEmbeddingPipeline`). The model card's instruction prefix belongs on queries, so
 * it is applied in the two query methods and not in `embedBatch`.
 *
 * shortcut: the provider interface has no query/document flag, so a live-written neuron goes through
 * the factory's `embed(neuron.content)` and gets the query prefix too. Re-embedded documents and
 * queries stay in the measured configuration; revisit if the interface ever gains the distinction.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { EmbeddingProvider } from 'cogmem';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_QUERY_PREFIX,
  embeddingModelsRoot,
  type EmbeddingState,
  type EmbeddingStatus,
} from './model.ts';

export type { EmbeddingState, EmbeddingStatus } from './model.ts';

type Pending = { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void };

const EMPTY = new Float32Array(0);

/**
 * The worker entry as a filesystem path (#280). Bun 1.4 rejects a `file://` URL *string* for a
 * worker; an absolute path is what both the old and new worker-thread validation accept.
 */
export function embeddingWorkerScript(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url));
}

export class XenovaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly modelId = EMBEDDING_MODEL;

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
    private readonly dataDir: string,
    private readonly onState?: (status: EmbeddingStatus) => void,
    /** How long a synchronous recall may wait for the worker, including a batch ahead of it. */
    private readonly syncTimeoutMs = 15_000,
    /** Tests load from disk only; production may download a missing model on an upgrade. */
    private readonly allowRemoteModels = true,
    /** The bge-zh instruction by default; empty for a deployment that changed it. */
    private readonly queryPrefix = EMBEDDING_QUERY_PREFIX,
  ) {}

  status(): EmbeddingStatus {
    return {
      state: this.state,
      modelId: this.modelId,
      dimensions: this.dimensions,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.loadMs !== undefined ? { loadMs: this.loadMs } : {}),
    };
  }

  /** Starts the worker and the local load (or the one-time download). Safe to call once. */
  warm(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.setState('loading');
    try {
      this.worker = new Worker(embeddingWorkerScript());
    } catch (error) {
      this.fail(error);
      return this.ready;
    }
    this.worker.on('message', (message: Record<string, unknown>) => this.onMessage(message));
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.disposed) this.fail(new Error(`embedding worker exited with code ${code}`));
    });
    // The worker must not keep the process alive on its own, and Bun's onnxruntime teardown panics
    // if the worker is terminated while the native session is live. Unref lets the process exit
    // normally; the resident stops by process exit, not by a graceful worker shutdown.
    this.worker.unref();
    this.worker.postMessage({
      type: 'init',
      modelsRoot: embeddingModelsRoot(this.dataDir),
      allowRemoteModels: this.allowRemoteModels,
      queryPrefix: this.queryPrefix,
    });
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

  /**
   * The synchronous recall lane. It never throws and returns an empty vector when the model is not
   * ready, so a missing or broken embedding can only make recall lexical — never make it fail.
   */
  /**
   * A field, not a method: `BrainRecall` extracts this function and calls it without its receiver,
   * so a prototype method would lose `this` on the first query.
   */
  readonly embedSync = (text: string): Float32Array => {
    return this.embedSyncWith(text, true);
  };

  /** The document side of the same lane: no query instruction prefix. */
  readonly embedSyncDocument = (text: string): Float32Array => {
    return this.embedSyncWith(text, false);
  };

  private embedSyncWith(text: string, prefix: boolean): Float32Array {
    if (this.state !== 'active' || !this.worker) return EMPTY;
    const sab = new SharedArrayBuffer(4 + this.dimensions * 4);
    const flag = new Int32Array(sab, 0, 1);
    const out = new Float32Array(sab, 4);
    this.worker.postMessage({ type: 'embedSync', text, sab, prefix });
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
        this.setState('active');
        this.resolveReady?.();
        return;
      case 'failed':
        this.fail(new Error(String(message.message ?? 'embedding model failed to load')));
        return;
      case 'progress':
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
        pending.reject(new Error(String(message.message ?? 'embedding failed')));
        return;
      }
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

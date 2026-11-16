/**
 * The embedding worker: the only place the ONNX pipeline runs.
 *
 * It is a worker rather than an in-process pipeline for one reason: `BrainRecall`'s synchronous
 * lane asks for a query vector through the optional `embedSync` hook, and ONNX inference is
 * async-only. The main thread hands the worker a `SharedArrayBuffer` and waits on it, so recall
 * keeps its synchronous contract without the kernel knowing a worker exists.
 *
 * Requests are serialised here. A re-embed batch can sit ahead of a query, which is why the
 * pipeline's batch size stays small (see `XenovaEmbeddingProvider`).
 */
import { parentPort } from 'node:worker_threads';
import { env, pipeline } from '@xenova/transformers';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_QUERY_PREFIX } from './model.ts';

interface Extract {
  (texts: string | string[], options?: { pooling?: 'mean' | 'cls'; normalize?: boolean }): Promise<{
    data: Float32Array;
    dims?: number[];
  }>;
}

let extract: Extract | undefined;
let failure: string | undefined;
let queue: Promise<void> = Promise.resolve();

function enqueue(work: () => Promise<void>): void {
  queue = queue.then(work, work);
}

async function init(modelsRoot: string, allowRemoteModels: boolean): Promise<void> {
  env.localModelPath = modelsRoot;
  env.cacheDir = modelsRoot;
  env.allowLocalModels = true;
  // A first start after an upgrade has no model yet; the worker is where the download happens so
  // the shell's start and health face are never held behind it.
  env.allowRemoteModels = allowRemoteModels;
  env.useBrowserCache = false;
  // Bun worker threads cannot reliably load the native CPU binding, so @xenova falls back to the
  // wasm backend. Its default proxy worker imports a blob URL and panics under Bun; running wasm
  // in this thread (no proxy, one thread) keeps the failure out of the process.
  if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }
  const startedAt = performance.now();
  try {
    const loaded = await pipeline('feature-extraction', EMBEDDING_MODEL, {
      quantized: true,
      progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
        parentPort?.postMessage({ type: 'progress', ...progress });
      },
    });
    extract = loaded as unknown as Extract;
    parentPort?.postMessage({
      type: 'ready',
      dimensions: EMBEDDING_DIMENSIONS,
      loadMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ type: 'failed', message: failure });
  }
}

async function embedMany(texts: string[]): Promise<Float32Array[]> {
  if (!extract) throw new Error(failure ?? 'embedding model not loaded');
  if (texts.length === 0) return [];
  const result = await extract(texts, { pooling: 'mean', normalize: true });
  const rows = result.dims?.[0] ?? texts.length;
  const dimensions = result.dims?.[1] ?? Math.floor(result.data.length / rows);
  const vectors: Float32Array[] = [];
  for (let index = 0; index < rows; index += 1) {
    vectors.push(result.data.slice(index * dimensions, (index + 1) * dimensions));
  }
  return vectors;
}

parentPort?.on('message', (message: Record<string, unknown>) => {
  if (message.type === 'init') {
    enqueue(() => init(String(message.modelsRoot), message.allowRemoteModels !== false));
    return;
  }
  if (message.type === 'embed') {
    const id = Number(message.id);
    const texts = message.texts as string[];
    enqueue(async () => {
      try {
        const vectors = await embedMany(texts);
        parentPort?.postMessage({ type: 'embedded', id, vectors });
      } catch (error) {
        parentPort?.postMessage({ type: 'embed_failed', id, message: error instanceof Error ? error.message : String(error) });
      }
    });
    return;
  }
  if (message.type === 'embedSync') {
    const sab = message.sab as SharedArrayBuffer;
    const flag = new Int32Array(sab, 0, 1);
    const out = new Float32Array(sab, 4);
    enqueue(async () => {
      try {
        const [vector] = await embedMany([EMBEDDING_QUERY_PREFIX + String(message.text)]);
        if (vector && vector.length === out.length) out.set(vector);
        Atomics.store(flag, 0, vector && vector.length === out.length ? 1 : -1);
      } catch {
        Atomics.store(flag, 0, -1);
      }
      Atomics.notify(flag, 0);
    });
  }
});

/**
 * The remote embedding worker (#313): HTTP in a thread, because the recall lane's `embedSync`
 * blocks the main thread on a SharedArrayBuffer and a fetch cannot finish there.
 *
 * The worker owns one kernel provider and serialises requests, so a re-embed batch ahead of a
 * query is answered in order rather than racing it.
 */
import { parentPort } from 'node:worker_threads';
import type { EmbeddingProvider } from 'cogmem';
import { buildInnerProvider, type RemoteEmbeddingSettings } from './remote.ts';

let provider: EmbeddingProvider | undefined;
let failure: string | undefined;
let dimensions = 0;
let queue: Promise<void> = Promise.resolve();

function enqueue(work: () => Promise<void>): void {
  queue = queue.then(work, work);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function init(settings: RemoteEmbeddingSettings): Promise<void> {
  const startedAt = performance.now();
  dimensions = settings.dimensions;
  try {
    provider = buildInnerProvider(settings);
    const [vector] = await provider.embedBatch(['embedding warm-up']);
    if (!vector) throw new Error('provider returned no vector');
    if (vector.length !== dimensions) {
      throw new Error(`dimension mismatch: provider returned ${vector.length}, configured ${dimensions}`);
    }
    parentPort?.postMessage({ type: 'ready', dimensions, loadMs: Math.round(performance.now() - startedAt) });
  } catch (error) {
    failure = errorMessage(error);
    parentPort?.postMessage({ type: 'failed', message: failure });
  }
}

async function embedMany(texts: string[]): Promise<Float32Array[]> {
  if (!provider) throw new Error(failure ?? 'embedding provider not loaded');
  if (texts.length === 0) return [];
  const vectors = await provider.embedBatch(texts);
  const wrong = vectors.find((vector) => vector.length !== dimensions);
  if (wrong) throw new Error(`dimension mismatch: provider returned ${wrong.length}, configured ${dimensions}`);
  return vectors;
}

parentPort?.on('message', (message: Record<string, unknown>) => {
  if (message.type === 'init') {
    enqueue(() => init(message as unknown as RemoteEmbeddingSettings));
    return;
  }
  if (message.type === 'embed') {
    const id = Number(message.id);
    const texts = message.texts as string[];
    enqueue(async () => {
      try {
        parentPort?.postMessage({ type: 'embedded', id, vectors: await embedMany(texts) });
      } catch (error) {
        parentPort?.postMessage({ type: 'embed_failed', id, message: errorMessage(error) });
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
        const [vector] = await embedMany([String(message.text)]);
        if (vector && vector.length === out.length) out.set(vector);
        Atomics.store(flag, 0, vector && vector.length === out.length ? 1 : -1);
      } catch (error) {
        parentPort?.postMessage({ type: 'sync_failed', message: errorMessage(error) });
        Atomics.store(flag, 0, -1);
      }
      Atomics.notify(flag, 0);
    });
  }
});

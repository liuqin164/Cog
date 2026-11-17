/**
 * The local-embedding arm, in its own OS process so its resident set can be
 * measured and bounded apart from the kernel. Invoked by `run.ts`; not a
 * reusable product module.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { env, pipeline } from '@huggingface/transformers';

import { cosine } from './math.ts';
import type { WorkerInput, WorkerOutput } from './types.ts';

interface Tensor {
  data: Float32Array;
  dims?: number[];
}

type Extract = (
  texts: string | string[],
  options?: { pooling?: 'mean' | 'cls'; normalize?: boolean },
) => Promise<Tensor>;

function peakRssBytes(): number | undefined {
  try {
    const match = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(readFileSync('/proc/self/status', 'utf8'));
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

function write(path: string, value: WorkerOutput): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('usage: embed-worker.ts <input.json> <output.json>');
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as WorkerInput;

  env.cacheDir = input.cacheDir;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;

  const rssBeforeModelBytes = process.memoryUsage().rss;
  const loadStarted = performance.now();
  const extract = (await pipeline('feature-extraction', input.model, { dtype: 'q8' })) as unknown as Extract;
  const loadMs = performance.now() - loadStarted;
  const rssAfterModelBytes = process.memoryUsage().rss;

  async function embedMany(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const result = await extract(texts, { pooling: 'mean', normalize: true });
    const data = result.data;
    const rows = result.dims?.[0] ?? texts.length;
    const dimensions = result.dims?.[1] ?? Math.floor(data.length / rows);
    const vectors: Float32Array[] = [];
    for (let index = 0; index < rows; index += 1) {
      vectors.push(data.slice(index * dimensions, (index + 1) * dimensions));
    }
    return vectors;
  }

  const rankings: WorkerOutput['rankings'] = { memory: {}, procedure: {} };
  let dimensions = 0;
  let rssAfterIndexBytes = rssAfterModelBytes;
  const docVectorsByKind: Record<'memory' | 'procedure', Float32Array[]> = { memory: [], procedure: [] };
  const indexStarted = performance.now();
  for (const kind of ['memory', 'procedure'] as const) {
    const vectors = await embedMany(input.docs[kind].map((doc) => doc.text));
    docVectorsByKind[kind] = vectors;
    dimensions = vectors[0]?.length ?? dimensions;
    rssAfterIndexBytes = Math.max(rssAfterIndexBytes, process.memoryUsage().rss);
  }
  const indexMs = performance.now() - indexStarted;

  const queryStarted = performance.now();
  let rssQueries = rssAfterIndexBytes;
  for (const kind of ['memory', 'procedure'] as const) {
    const docs = input.docs[kind];
    const docVectors = docVectorsByKind[kind];
    const queries = input.queries[kind];
    const queryVectors = await embedMany(queries.map((query) => input.queryPrefix + query.text));
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
      const queryVector = queryVectors[queryIndex]!;
      rankings![kind]![queries[queryIndex]!.id] = docs
        .map((doc, docIndex) => ({ id: doc.id, score: cosine(queryVector, docVectors[docIndex]!) }))
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    }
    rssQueries = Math.max(rssQueries, process.memoryUsage().rss);
  }
  const queryMs = performance.now() - queryStarted;

  write(outputPath, {
    ok: true,
    model: input.model,
    dimensions,
    loadMs,
    indexMs,
    queryMs,
    rssBeforeModelBytes,
    rssAfterModelBytes,
    rssAfterIndexBytes,
    rssAfterQueriesBytes: rssQueries,
    peakRssBytes: peakRssBytes(),
    rankings,
  });
}

main().catch((error: unknown) => {
  const outputPath = process.argv[3];
  if (outputPath) {
    write(outputPath, {
      ok: false,
      model: '',
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
  process.exit(1);
});

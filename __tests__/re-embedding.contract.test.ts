import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryGraph } from '../src/core/MemoryGraph.js';
import { NeuronFactory } from '../src/core/Neuron.js';
import { NeuronEmbeddingStore } from '../src/embedding/NeuronEmbeddingStore.js';
import { ReEmbeddingPipeline } from '../src/embedding/ReEmbeddingPipeline.js';
import type { EmbeddingProvider } from '../src/embedding/EmbeddingProvider.js';
import { makeTempDir } from './helpers/tmp.js';

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = 'contract/model';
  readonly dimensions = 2;
  calls = 0;

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return texts.map((text) => new Float32Array([text.length, 1]));
  }

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0]!;
  }
}

const doc = readFileSync(fileURLToPath(new URL('../docs/re-embedding.md', import.meta.url)), 'utf8');

function fixture() {
  const dbPath = join(makeTempDir('cogmem-reembed-contract-'), 'brain.db');
  const db = new Database(dbPath);
  const graph = new MemoryGraph(dbPath);
  return { db, graph, store: new NeuronEmbeddingStore(db), provider: new FakeEmbeddingProvider() };
}

function add(graph: MemoryGraph, content: string, projectId = 'p') {
  const now = Date.now();
  const neuron = NeuronFactory.create(content, graph.getLatestNeuronSelfHash(projectId) || 'genesis', { T: now, S: [0, 0, 0], V: [] }, {
    projectId,
    type: 'chat',
    createdAt: now,
    updatedAt: now,
    status: 'active',
    tags: [],
    importanceLevel: 'normal',
  });
  graph.addNeuron(neuron);
  return neuron;
}

describe('re-embedding contract v1', () => {
  test('the document names the migration set and its properties', () => {
    expect(doc).toContain('## Migration set');
    expect(doc).toContain('no `neuron_embeddings` row for the current model');
    expect(doc).toContain('Idempotent');
    expect(doc).toContain('lastProcessedNeuronId');
  });

  test('a brain with no vector rows is fully backfilled and a second run does no work', async () => {
    const { db, graph, store, provider } = fixture();
    const neurons = [add(graph, 'alpha'), add(graph, 'beta'), add(graph, 'gamma')];
    const pipeline = new ReEmbeddingPipeline(store, provider, graph, db);

    expect(await pipeline.run('p')).toEqual({ processed: 3, remaining: 0 });
    expect(store.countStaleVectors(provider.modelId, 'p')).toBe(0);
    expect(neurons.every((neuron) => db.prepare(
      `SELECT 1 FROM neuron_embeddings WHERE neuron_id = ? AND model_id = ?`
    ).get(neuron.id, provider.modelId))).toBe(true);

    const callsAfterFirst = provider.calls;
    expect(await pipeline.run('p')).toEqual({ processed: 0, remaining: 0 });
    expect(provider.calls).toBe(callsAfterFirst);
  });

  test('old-model rows still migrate and the old row is removed', async () => {
    const { db, graph, store, provider } = fixture();
    const neuron = add(graph, 'alpha');
    store.upsert(neuron.id, 'contract/old', new Float32Array([1]), 'p');

    expect(await new ReEmbeddingPipeline(store, provider, graph, db).run('p')).toEqual({ processed: 1, remaining: 0 });
    expect(db.prepare(`SELECT model_id FROM neuron_embeddings WHERE neuron_id = ?`).all(neuron.id)).toEqual([
      { model_id: provider.modelId },
    ]);
  });
});

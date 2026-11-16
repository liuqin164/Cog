import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel, KernelAgentMemoryBackend, type MemoryKernel } from '../src/public.js';
import type { EmbeddingProvider } from '../src/embedding/EmbeddingProvider.js';
import { makeTempDir } from './helpers/tmp.js';

const CLOSE = /alpha|release|ship|paraphrase/u;

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = 'fake/vector';
  readonly dimensions = 2;

  private vector(text: string): Float32Array {
    return new Float32Array(CLOSE.test(text) ? [1, 0] : [0, 1]);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vector(text));
  }

  async embed(text: string): Promise<Float32Array> {
    return this.vector(text);
  }

  readonly embedSync = (text: string): Float32Array => this.vector(text);
}

let kernel: MemoryKernel | undefined;

afterEach(() => {
  kernel?.close();
  kernel = undefined;
});

async function waitForEmbeddings(target: MemoryKernel, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (target.neuronEmbeddingStore.getProgress().total < expected && Date.now() < deadline) {
    await Bun.sleep(10);
  }
}

describe('the shell recall path consumes the vector lane', () => {
  test('navigateMemory returns a vector hit when the query shares no lexical seed', async () => {
    kernel = createMemoryKernel({
      dbPath: join(makeTempDir('cogmem-vector-wiring-'), 'memory.db'),
      projectTimeZone: 'UTC',
      embeddingProvider: new FakeEmbeddingProvider(),
    });
    const backend = new KernelAgentMemoryBackend(kernel, { agentId: 'owner' });
    await backend.rememberTurnWithResult({
      agentId: 'owner',
      projectId: 'p',
      sessionId: 's1',
      threadId: 't1',
      userText: 'alpha stored procedure for the team',
    });
    await backend.rememberTurnWithResult({
      agentId: 'owner',
      projectId: 'p',
      sessionId: 's2',
      threadId: 't2',
      userText: 'unrelated beta note',
    });
    await waitForEmbeddings(kernel, 2);

    const navigated = kernel.navigateMemory('paraphrase enquiry', {
      projectId: 'p',
      limit: 5,
    });

    expect(navigated.recallMode).toBe('universe_navigation');
    expect(navigated.rawEvidence[0]?.content).toContain('alpha');
  });

  test('ProcedureCompiler.recall reaches a practice the task does not name lexically', async () => {
    kernel = createMemoryKernel({
      dbPath: join(makeTempDir('cogmem-procedure-vector-'), 'memory.db'),
      projectTimeZone: 'UTC',
      embeddingProvider: new FakeEmbeddingProvider(),
    });
    kernel.recordTaskEvent({
      projectId: 'p',
      threadId: 'release',
      role: 'system',
      content: 'task completed',
      metadata: {
        procedure: { domain: 'release', key: 'ship', title: 'ship a release', steps: ['test', 'build'], outcome: 'succeeded' },
      },
    });
    kernel.recordTaskEvent({
      projectId: 'p',
      threadId: 'backup',
      role: 'system',
      content: 'task completed',
      metadata: {
        procedure: { domain: 'backup', key: 'restore', title: 'restore a backup', steps: ['pick snapshot'], outcome: 'succeeded' },
      },
    });
    kernel.procedures.compile({ projectId: 'p' });

    const recalled = kernel.procedures.recall({ projectId: 'p', task: 'how do we ship it', limit: 3 });

    expect(recalled[0]?.key).toBe('ship');
  });
});

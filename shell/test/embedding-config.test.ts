/**
 * #313 — the shell's embedding provider is configurable, and the semantic lane is only claimed
 * when the configured provider is warm over a current index.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { CompanionShell } from '../src/app.ts';
import { defaultShellConfig } from '../src/config.ts';
import { EMBEDDING_MODEL, type EmbeddingConfig } from '../src/embedding/model.ts';
import { createEmbeddingProvider, probeEmbedding } from '../src/embedding/provider.ts';
import { openAiEndpoint } from '../src/embedding/remote.ts';
import { makeTempDir } from './helpers.ts';

function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function startFixture(handler: (body: Record<string, unknown>, url: URL) => Response | Promise<Response>): {
  baseUrl: string;
  requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }>;
  stop: () => void;
} {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.clone().json().catch(() => ({})) as Record<string, unknown>;
      requests.push({ url: url.pathname, body, authorization: request.headers.get('authorization') });
      return handler(body, url);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

function vector(dimensions: number, value = 0.5): number[] {
  return Array.from({ length: dimensions }, () => value);
}

async function startThreadFixture(): Promise<{
  baseUrl: string;
  requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }>;
  stop: () => void;
}> {
  const worker = new Worker(new URL('./fixtures/embedding-server.ts', import.meta.url));
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const port = await new Promise<number>((resolve, reject) => {
    worker.on('message', (message: { type?: string; port?: number; url?: string; body?: Record<string, unknown>; authorization?: string | null }) => {
      if (message.type === 'port' && message.port) resolve(message.port);
      else if (message.type === 'request' && message.url) {
        requests.push({ url: message.url, body: message.body ?? {}, authorization: message.authorization ?? null });
      }
    });
    worker.on('error', reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    stop: () => {
      worker.postMessage({ type: 'close' });
      void worker.terminate();
    },
  };
}

describe('embedding configuration', () => {
  test('defaults to the local bge model and its model-specific query prefix', () => {
    const restore = withEnv({
      COGMEM_EMBEDDING_PROVIDER: undefined,
      COGMEM_EMBEDDING_QUERY_PREFIX: undefined,
      COGMEM_EMBEDDING_MODEL: undefined,
    });
    try {
      const config = defaultShellConfig({ dataDir: makeTempDir(), dbPath: ':memory:' });
      expect(config.embedding.provider).toBe('local');
      expect(config.embedding.model).toBe(EMBEDDING_MODEL);
      expect(config.embedding.dimensions).toBe(768);
      expect(config.embedding.queryPrefix).toBe('为这个句子生成表示以用于检索相关文章：');
    } finally {
      restore();
    }
  });

  test('reads a remote provider from the installer env keys and defaults the prefix to empty', () => {
    const restore = withEnv({
      COGMEM_EMBEDDING_PROVIDER: 'ollama',
      COGMEM_EMBEDDING_BASE_URL: 'http://127.0.0.1:11434',
      COGMEM_EMBEDDING_MODEL: 'qwen3-embedding:0.6b',
      COGMEM_EMBEDDING_DIMENSIONS: '1024',
      COGMEM_EMBEDDING_QUERY_PREFIX: undefined,
    });
    try {
      const config = defaultShellConfig({ dataDir: makeTempDir(), dbPath: ':memory:' });
      expect(config.embedding).toEqual({
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3-embedding:0.6b',
        dimensions: 1024,
        queryPrefix: '',
      });
    } finally {
      restore();
    }
  });

  test('an explicit empty prefix disables the local bge instruction', () => {
    const restore = withEnv({ COGMEM_EMBEDDING_PROVIDER: undefined, COGMEM_EMBEDDING_QUERY_PREFIX: '' });
    try {
      const config = defaultShellConfig({ dataDir: makeTempDir(), dbPath: ':memory:' });
      expect(config.embedding.queryPrefix).toBe('');
    } finally {
      restore();
    }
  });

  test('an unknown provider is a startup error, not a silent local fallback', () => {
    const restore = withEnv({ COGMEM_EMBEDDING_PROVIDER: 'nope' });
    try {
      expect(() => defaultShellConfig({ dataDir: makeTempDir(), dbPath: ':memory:' })).toThrow(/invalid_embedding_provider/);
    } finally {
      restore();
    }
  });
});

describe('remote HTTP providers', () => {
  test('Ollama: real /api/embed calls, query prefix on queries only, and a synchronous recall vector', async () => {
    const fixture = await startThreadFixture();
    const dataDir = makeTempDir();
    const config: EmbeddingConfig = {
      provider: 'ollama',
      baseUrl: fixture.baseUrl,
      model: 'qwen3-embedding:0.6b',
      queryPrefix: '查询：',
    };
    const provider = createEmbeddingProvider(config, dataDir);
    try {
      await provider.warm();
      const embedded = await provider.embed('会议时间');
      expect(embedded.length).toBe(1024);
      expect(provider.embedSync?('会议时间')?.length).toBe(1024);
      await provider.embedBatch(['文档正文']);

      const inputs = fixture.requests
        .filter((request) => request.url === '/api/embed')
        .flatMap((request) => request.body.input as string[]);
      expect(inputs).toContain('查询：会议时间');
      expect(inputs).toContain('文档正文');
      expect(inputs).not.toContain('查询：文档正文');
      expect(provider.status().state).toBe('active');
      expect(provider.modelId).toBe('ollama/qwen3-embedding:0.6b@1024');
    } finally {
      provider.dispose?.();
      fixture.stop();
    }
  });

  test('OpenAI-compatible: /v1/embeddings, bearer key from the 0600 env file, and a synchronous vector', async () => {
    const fixture = await startThreadFixture();
    const dataDir = makeTempDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'env'), 'COGMEM_EMBEDDING_API_KEY=sk-test-only\n', { mode: 0o600 });
    const config: EmbeddingConfig = {
      provider: 'openai',
      baseUrl: `${fixture.baseUrl}/v1`,
      model: 'text-embedding-v3',
      dimensions: 1024,
      queryPrefix: '',
    };
    const provider = createEmbeddingProvider(config, dataDir);
    try {
      await provider.warm();
      expect((await provider.embed('查一下')).length).toBe(1024);
      expect(provider.embedSync?('查一下')?.length).toBe(1024);
      expect(fixture.requests[0]?.url).toBe('/v1/embeddings');
      expect(fixture.requests[0]?.authorization).toBe('Bearer sk-test-only');
      expect(provider.modelId).toBe('openai/text-embedding-v3@1024');
      expect(openAiEndpoint('http://127.0.0.1:1/v1')).toBe('http://127.0.0.1:1/v1/embeddings');
      expect(openAiEndpoint('http://127.0.0.1:1/v1/embeddings')).toBe('http://127.0.0.1:1/v1/embeddings');
    } finally {
      provider.dispose?.();
      fixture.stop();
    }
  });

  test('a failing endpoint degrades instead of pretending the semantic lane is up', async () => {
    const fixture = startFixture(() => new Response('upstream down', { status: 503 }));
    const dataDir = makeTempDir();
    writeFileSync(join(dataDir, 'env'), 'COGMEM_EMBEDDING_API_KEY=sk-test-only\n', { mode: 0o600 });
    const provider = createEmbeddingProvider({
      provider: 'openai',
      baseUrl: `${fixture.baseUrl}/v1`,
      model: 'text-embedding-v3',
      dimensions: 1024,
      queryPrefix: '',
    }, dataDir);
    try {
      await expect(provider.warm()).rejects.toThrow(/embedding_unavailable/);
      expect(provider.status().state).toBe('degraded');
      expect(provider.embedSync?('x')?.length).toBe(0);
    } finally {
      provider.dispose?.();
      fixture.stop();
    }
  });

  test('the installer probe fails loudly on a dimension mismatch', async () => {
    const fixture = startFixture(() => Response.json({ data: [{ embedding: vector(8) }] }));
    try {
      const result = await probeEmbedding({
        provider: 'openai',
        baseUrl: `${fixture.baseUrl}/v1`,
        model: 'text-embedding-v3',
        dimensions: 1024,
        queryPrefix: '',
      }, 'sk-test-only');
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('维度 8');
    } finally {
      fixture.stop();
    }
  });
});

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

function seedOldVector(shell: CompanionShell, projectId: string): string {
  const neuronId = 'nrn-embedding-switch';
  shell.kernel.memoryGraph.addNeuron({
    id: neuronId,
    content: '旧记忆需要按新维度重嵌',
    prev_hash: '',
    self_hash: 'hash-embedding-switch',
    synapses: [],
    metadata: { type: 'chat', createdAt: 1, projectId, tags: [] },
    coordinates: { T: 1, S: [0, 0, 0], V: [1, 0, 0, 0] },
  } as never);
  shell.kernel.neuronEmbeddingStore.upsert(neuronId, 'old/model', new Float32Array(8), projectId);
  return neuronId;
}

describe('provider switch and the semantic lane', () => {
  test('a stale model/dimension keeps semanticIndex false until the full re-embed finishes', async () => {
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let seen: (() => void) | undefined;
    const gated = new Promise<void>((resolve) => { seen = resolve; });
    const fixture = startFixture(async (body) => {
      const inputs = (body.input as string[] | undefined) ?? [];
      if (inputs.some((text) => text.includes('旧记忆'))) {
        seen?.();
        await released;
      }
      return Response.json({ data: [{ embedding: vector(1024, 0.75) }] });
    });
    const dataDir = makeTempDir();
    writeFileSync(join(dataDir, 'env'), 'COGMEM_EMBEDDING_API_KEY=sk-test-only\n', { mode: 0o600 });
    const projectId = 'embedding-switch';
    const shell = new CompanionShell({
      config: {
        dataDir,
        dbPath: join(dataDir, 'memory.sqlite'),
        projectId,
        terminalEnabled: false,
        http: { enabled: false, port: 0, hostname: '127.0.0.1' },
        embedding: {
          provider: 'openai',
          baseUrl: `${fixture.baseUrl}/v1`,
          model: 'text-embedding-v3',
          dimensions: 1024,
          queryPrefix: '',
        },
      },
      embedding: true,
      tick: false,
    });
    seedOldVector(shell, projectId);
    try {
      const starting = shell.start();
      await gated;
      expect(shell.kernel.semanticIndexEnabled()).toBe(false);
      release?.();
      await starting;
      expect(await waitFor(() => shell.kernel.semanticIndexEnabled())).toBe(true);
      const current = shell.kernel.neuronEmbeddingStore.listLatestEmbeddings();
      expect(current.some((row) => row.modelId === 'openai/text-embedding-v3@1024')).toBe(true);
      expect(shell.kernel.getHealthStatus().hasStaleVectors).toBe(false);
    } finally {
      release?.();
      await shell.stop();
      fixture.stop();
    }
  });

  test('a provider that never warms leaves semanticIndex false and records the degradation', async () => {
    let requests = 0;
    const fixture = startFixture(() => {
      requests += 1;
      return new Response('upstream down', { status: 503 });
    });
    const dataDir = makeTempDir();
    writeFileSync(join(dataDir, 'env'), 'COGMEM_EMBEDDING_API_KEY=sk-test-only\n', { mode: 0o600 });
    const shell = new CompanionShell({
      config: {
        dataDir,
        dbPath: join(dataDir, 'memory.sqlite'),
        projectId: 'embedding-down',
        terminalEnabled: false,
        http: { enabled: false, port: 0, hostname: '127.0.0.1' },
        embedding: {
          provider: 'openai',
          baseUrl: `${fixture.baseUrl}/v1`,
          model: 'text-embedding-v3',
          dimensions: 1024,
          queryPrefix: '',
        },
      },
      embedding: true,
      tick: false,
    });
    try {
      await shell.start();
      expect(await waitFor(() => requests > 0)).toBe(true);
      expect(shell.kernel.semanticIndexEnabled()).toBe(false);
      expect(await waitFor(() => {
        try {
          return readFileSync(join(dataDir, 'shell-events.jsonl'), 'utf8').includes('embedding_unavailable');
        } catch {
          return false;
        }
      })).toBe(true);
    } finally {
      await shell.stop();
      fixture.stop();
    }
  });
});

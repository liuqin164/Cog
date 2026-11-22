import { expect, test } from 'bun:test';
import { buildInnerProvider } from '../src/embedding/remote.ts';

test('a remote Ollama model uses the configured dimension', async () => {
  const vector = Array.from({ length: 768 }, () => 0.1);
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json({ embeddings: [vector] }),
  });
  try {
    const provider = buildInnerProvider({
      kind: 'ollama',
      baseUrl: `http://127.0.0.1:${server.port}`,
      model: 'custom-embedding:latest',
      apiKey: '',
      dimensions: 768,
    });

    expect(provider.dimensions).toBe(768);
    const [embedded] = await provider.embedBatch(['hello']);
    expect(embedded).toHaveLength(768);
  } finally {
    server.stop(true);
  }
});

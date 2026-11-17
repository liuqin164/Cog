/**
 * A fixture embedding endpoint in its own thread. `embedSync` blocks the main thread on a
 * SharedArrayBuffer, so a server living there could never answer the request it is waiting for.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parentPort } from 'node:worker_threads';

function vector(dimensions: number, value = 0.5): number[] {
  return Array.from({ length: dimensions }, () => value);
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk.toString('utf8'); });
  request.on('end', () => {
    let parsed: { input?: string[]; model?: string } = {};
    try {
      parsed = JSON.parse(body) as { input?: string[]; model?: string };
    } catch {
      // A malformed body is the client's problem; answer it like a real endpoint would.
    }
    parentPort?.postMessage({
      type: 'request',
      url: request.url,
      body: parsed,
      authorization: request.headers.authorization ?? null,
    });
    const inputs = parsed.input ?? [];
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/api/embed')) {
      response.end(JSON.stringify({ embeddings: inputs.map(() => vector(1024)) }));
      return;
    }
    if (request.url?.startsWith('/v1/embeddings')) {
      response.end(JSON.stringify({ data: inputs.map(() => ({ embedding: vector(1024, 0.25) })) }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
});

server.listen(0, '127.0.0.1', () => {
  parentPort?.postMessage({ type: 'port', port: (server.address() as AddressInfo).port });
});

parentPort?.on('message', (message: { type?: string }) => {
  if (message.type === 'close') server.close();
});

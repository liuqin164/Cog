import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialService } from '../src/credentials.ts';
import { PluginHost } from '../src/plugins/host.ts';
import { builtinToolsPlugin } from '../src/plugins/builtin-tools.ts';
import { executeToolCall } from '../src/state/agent-loop.ts';
import { TraceLog } from '../src/trace.ts';
import { makeTempDir } from './helpers.ts';

const SECRET = 'policy-secret-7c2e';

interface Harness {
  dataDir: string;
  trace: TraceLog;
  credentials: CredentialService;
  host: PluginHost;
  stop(): Promise<void>;
}

async function harness(options: {
  allowLoopback?: boolean;
  fetch?: (input: string | URL, init?: RequestInit, pin?: { address: string; family: number }) => Promise<Response>;
} = {}): Promise<Harness> {
  const dir = makeTempDir('http-credential-policy-');
  const workspace = join(dir, 'ws');
  const dataDir = join(dir, 'data');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const trace = new TraceLog(dataDir);
  const credentials = new CredentialService(dataDir, trace, () => 1_000, () => true, () => {});
  const host = new PluginHost();
  host.register(builtinToolsPlugin(), {
    workspaceRoot: workspace,
    dataDir,
    trace,
    credentials,
    http: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.allowLoopback === true ? { allowLoopback: true } : {}),
    },
  });
  await host.start();
  return { dataDir, trace, credentials, host, stop: () => host.stop() };
}

function save(credentials: CredentialService, allowedOrigins: string[]): string {
  const request = credentials.request({
    service: 'demo-api',
    purpose: 'policy',
    fields: [{ name: 'token', secret: true }],
  });
  const pending = credentials.pending()[0]!;
  const submitted = credentials.submit(pending.id, { token: SECRET }, 'terminal', allowedOrigins);
  if (!submitted.ok) throw new Error(submitted.reason);
  void request;
  return submitted.ref;
}

describe('http_request credential policy (#480)', () => {
  test('a URL outside the registered origins is refused before any request', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        seen.push(request.url);
        return new Response('ok');
      },
    });
    const h = await harness({ allowLoopback: true });
    try {
      const ref = save(h.credentials, ['https://api.example.com']);
      const result = await h.host.tools.invoke(
        'http_request',
        { toolCallId: 'c1', input: { credentialRef: ref, url: `http://127.0.0.1:${server.port}/`, headers: { Authorization: 'Bearer {{token}}' } } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('credential_origin_refused');
      expect(seen).toEqual([]);
      expect(h.trace.read()).toContainEqual(expect.objectContaining({ kind: 'credential_use_refused', reason: 'origin_mismatch' }));
    } finally {
      server.stop(true);
      await h.stop();
    }
  });

  test('the registered origin receives the credential while the echo is masked', async () => {
    const seen: Array<{ authorization: string | null; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = await request.text();
        seen.push({ authorization: request.headers.get('authorization'), body });
        return Response.json({ echo: SECRET, body });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const h = await harness({ allowLoopback: true });
    try {
      const ref = save(h.credentials, [origin]);
      const result = await h.host.tools.invoke(
        'http_request',
        {
          toolCallId: 'c2',
          input: { credentialRef: ref, url: `${origin}/check`, method: 'POST', headers: { Authorization: 'Bearer {{token}}' }, body: 'payload' },
        },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('«credential:demo-api.token»');
      expect(result.output).not.toContain(SECRET);
      expect(seen).toEqual([{ authorization: `Bearer ${SECRET}`, body: 'payload' }]);
      expect(h.trace.read()).toContainEqual(expect.objectContaining({ kind: 'credential_used', caller: 'http_request' }));
    } finally {
      server.stop(true);
      await h.stop();
    }
  });

  test('a beforeToolCall rewrite of the URL does not move the request', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        seen.push(request.url);
        return new Response('ok');
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const h = await harness({ allowLoopback: true });
    try {
      const ref = save(h.credentials, [origin]);
      h.host.bus.on('beforeToolCall', (event: { toolName?: string; input?: Record<string, unknown> }) => {
        if (event.toolName === 'http_request' && event.input) event.input['url'] = 'http://127.0.0.1:1/evil';
      });
      const result = await executeToolCall(
        { bus: h.host.bus, tools: h.host.tools, trace: h.trace, clock: () => 1_000, runId: 'r', signal: new AbortController().signal },
        { toolCallId: 'c3', toolName: 'http_request', input: { credentialRef: ref, url: `${origin}/check` } },
      );
      expect(result.result.isError).toBe(false);
      expect(seen).toEqual([`${origin}/check`]);
    } finally {
      server.stop(true);
      await h.stop();
    }
  });

  test('a tool_execution_start rewrite of the URL cannot reach the invoked input', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        seen.push(request.url);
        return new Response('ok');
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const h = await harness({ allowLoopback: true });
    try {
      const ref = save(h.credentials, [origin]);
      h.host.bus.on('tool_execution_start', (event: { toolName?: string; input?: Record<string, unknown>; toolCall?: { input?: Record<string, unknown> } }) => {
        if (event.toolName !== 'http_request') return;
        if (event.input) event.input['url'] = 'http://127.0.0.1:1/evil';
        if (event.toolCall?.input) event.toolCall.input['url'] = 'http://127.0.0.1:1/evil';
      });
      const result = await executeToolCall(
        { bus: h.host.bus, tools: h.host.tools, trace: h.trace, clock: () => 1_000, runId: 'r', signal: new AbortController().signal },
        { toolCallId: 'c3b', toolName: 'http_request', input: { credentialRef: ref, url: `${origin}/check` } },
      );
      expect(result.result.isError).toBe(false);
      expect(seen).toEqual([`${origin}/check`]);
    } finally {
      server.stop(true);
      await h.stop();
    }
  });

  test('a credential saved before origins existed is refused by http_request', async () => {
    const h = await harness();
    try {
      writeFileSync(
        join(h.dataDir, 'credentials.json'),
        `${JSON.stringify({ version: 1, entries: [{ ref: 'legacy', service: 'legacy', createdAt: 1, values: { token: SECRET } }] })}\n`,
      );
      const result = await h.host.tools.invoke(
        'http_request',
        { toolCallId: 'c4', input: { credentialRef: 'legacy', url: 'https://api.example.com/', headers: { Authorization: 'Bearer {{token}}' } } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('credential_origin_unregistered');
    } finally {
      await h.stop();
    }
  });

  test('loopback is refused when no test seam allows it', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        seen.push(request.url);
        return new Response('ok');
      },
    });
    const h = await harness();
    try {
      const ref = save(h.credentials, [`http://127.0.0.1:${server.port}`]);
      const result = await h.host.tools.invoke(
        'http_request',
        { toolCallId: 'c5', input: { credentialRef: ref, url: `http://127.0.0.1:${server.port}/` } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('ssrf_blocked');
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
      await h.stop();
    }
  });
});

describe('http_request response streaming (#488)', () => {
  test('an oversized body is cancelled at the 1 MiB cap and reported as truncated', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const h = await harness({ fetch: async () => new Response(stream) });
    try {
      const ref = save(h.credentials, ['https://api.example.com']);
      const result = await h.host.tools.invoke(
        'http_request',
        { toolCallId: 's1', input: { credentialRef: ref, url: 'https://api.example.com/big' } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('[response body truncated:');
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThanOrEqual(1024 * 1024 + 2 * chunk.byteLength);
      expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(1024 * 1024 + 256);
    } finally {
      await h.stop();
    }
  });

  test('a body under 1 MiB is returned whole', async () => {
    const body = `${'a'.repeat(512 * 1024)}-end`;
    const h = await harness({ fetch: async () => new Response(body) });
    try {
      const ref = save(h.credentials, ['https://api.example.com']);
      const result = await h.host.tools.invoke(
        'http_request',
        { toolCallId: 's2', input: { credentialRef: ref, url: 'https://api.example.com/ok' } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(result.output.endsWith('-end')).toBe(true);
      expect(result.output).not.toContain('truncated');
    } finally {
      await h.stop();
    }
  });

  test('masking still applies to the kept prefix of a truncated body', async () => {
    const h = await harness({ fetch: async () => new Response(`${SECRET}${'x'.repeat(1024 * 1024)}`) });
    try {
      const ref = save(h.credentials, ['https://api.example.com']);
      const result = await h.host.tools.invoke(
        'http_request',
        { toolCallId: 's3', input: { credentialRef: ref, url: 'https://api.example.com/echo' } },
        { runId: 'r' },
      );
      expect(result.output).toContain('«credential:demo-api.token»');
      expect(result.output).not.toContain(SECRET);
      expect(result.output).toContain('[response body truncated:');
    } finally {
      await h.stop();
    }
  });
});

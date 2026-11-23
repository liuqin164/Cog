import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { startObservatoryServer, type ObservatoryServerHandle } from '../src/observatory/HttpServer.js';
import { OBSERVATORY_TOKEN_HEADER, ensureObservatoryToken } from '../src/observatory/token.js';
import { makeTempDir } from './helpers/tmp.js';

const scratch = makeTempDir('cogmem-observatory-credentials-');
let kernel: MemoryKernel;
let handle: ObservatoryServerHandle;
let token: string;
const calls: Array<{ op: string; id?: string; values?: Record<string, string>; ref?: string; surface?: string }> = [];

const face = {
  pending: () => [{
    id: 'credential-1',
    service: 'demo-api',
    purpose: '演示',
    fields: [{ name: 'account', label: '账号' }, { name: 'password', label: '密码', secret: true }],
    requestedBy: 'companion',
    createdAt: 1_000,
  }],
  refs: () => [{ ref: 'demo-api', service: 'demo-api', createdAt: 1_000 }],
  submit: (id: string, values: Record<string, string>, surface: string, allowedOrigins?: string[]) => {
    calls.push({ op: 'submit', id, values, surface, allowedOrigins });
    return { ok: true as const, ref: 'demo-api' };
  },
  cancel: (id: string, surface: string) => {
    calls.push({ op: 'cancel', id, surface });
    return true;
  },
  revoke: (ref: string) => {
    calls.push({ op: 'revoke', ref });
    return true;
  },
};

beforeAll(async () => {
  token = ensureObservatoryToken(scratch);
  kernel = createMemoryKernel({ dbPath: join(scratch, 'memory.db'), projectTimeZone: 'UTC' });
  handle = await startObservatoryServer({ kernel, port: 0, credentials: face });
});

afterAll(() => {
  handle.stop();
  kernel.close();
  rmSync(scratch, { recursive: true, force: true });
});

function base(): string {
  return handle.url.replace(/\/$/u, '');
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:7338', [OBSERVATORY_TOKEN_HEADER]: token, ...headers },
    body: JSON.stringify(body),
  });
}

describe('the observatory credential face (#383)', () => {
  test('the trusted page lists pending requests and references without values', async () => {
    const response = await fetch(`${base()}/credentials`);
    expect(response.status).toBe(200);
    const body = await response.json() as { pending: Array<{ id: string; fields: unknown[] }>; refs: Array<{ ref: string }> };
    expect(body.pending[0]?.id).toBe('credential-1');
    expect(body.pending[0]?.fields).toHaveLength(2);
    expect(body.refs[0]?.ref).toBe('demo-api');
    expect(JSON.stringify(body)).not.toContain('password-value');
  });

  test('submission needs the local write token and reaches the host as the web surface', async () => {
    const refused = await post('/credentials/submit', { id: 'credential-1', values: { account: 'alice', password: 'pw' } }, { [OBSERVATORY_TOKEN_HEADER]: 'wrong' });
    expect(refused.status).toBe(403);
    expect(calls).toHaveLength(0);
    const saved = await post('/credentials/submit', { id: 'credential-1', values: { account: 'alice', password: 'password-value' }, allowedOrigins: ['https://api.example.com'] });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, ref: 'demo-api' });
    expect(calls.at(-1)).toEqual({
      op: 'submit',
      id: 'credential-1',
      values: { account: 'alice', password: 'password-value' },
      surface: 'web',
      allowedOrigins: ['https://api.example.com'],
    });
  });

  test('a cross-origin text/plain body is refused before reaching the host', async () => {
    const before = calls.length;
    const response = await fetch(`${base()}/credentials/submit`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example', [OBSERVATORY_TOKEN_HEADER]: token },
      body: JSON.stringify({ id: 'credential-1', values: { password: 'leak' } }),
    });
    expect(response.status).toBe(415);
    expect(calls).toHaveLength(before);
  });

  test('cancel and revoke use the same write lock and land on the host', async () => {
    expect((await post('/credentials/cancel', { id: 'credential-1' })).status).toBe(200);
    expect((await post('/credentials/revoke', { ref: 'demo-api' })).status).toBe(200);
    expect(calls.slice(-2)).toEqual([
      { op: 'cancel', id: 'credential-1', surface: 'web' },
      { op: 'revoke', ref: 'demo-api' },
    ]);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { startObservatoryServer, type ObservatoryServerHandle } from '../src/observatory/HttpServer.js';
import { OBSERVATORY_TOKEN_HEADER, ensureObservatoryToken } from '../src/observatory/token.js';
import { makeTempDir } from './helpers/tmp.js';

const scratch = makeTempDir('cogmem-observatory-channels-');
let kernel: MemoryKernel;
let handle: ObservatoryServerHandle;
let token: string;
const calls: Array<{ op: string; id?: string; ref?: string }> = [];

const card = (state: 'disconnected' | 'pairing' | 'connected' | 'error', pairingCode?: string) => ({
  id: 'telegram',
  name: 'Telegram',
  state,
  detail: 'test',
  connectable: true,
  ...(pairingCode ? { pairingCode } : {}),
});

const face = {
  list: () => [card('disconnected')],
  begin: (id: string) => {
    calls.push({ op: 'begin', id });
    return { ok: true as const, requestId: 'credential-1' };
  },
  start: (id: string, ref: string) => {
    calls.push({ op: 'start', id, ref });
    return { ok: true as const, channel: card('pairing', 'ABC123') };
  },
  disconnect: (id: string) => {
    calls.push({ op: 'disconnect', id });
    return { ok: true as const, channel: card('disconnected') };
  },
};

beforeAll(async () => {
  token = ensureObservatoryToken(scratch);
  kernel = createMemoryKernel({ dbPath: join(scratch, 'memory.db'), projectTimeZone: 'UTC' });
  handle = await startObservatoryServer({ kernel, port: 0, channels: face });
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

describe('the observatory channel face (#416)', () => {
  test('the channel list needs the write token', async () => {
    expect((await fetch(`${base()}/channels`)).status).toBe(403);
    const response = await fetch(`${base()}/channels`, { headers: { [OBSERVATORY_TOKEN_HEADER]: token } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ channels: [card('disconnected')] });
  });

  test('begin, start and disconnect reach the host only with the write token', async () => {
    expect((await post('/channels/telegram/begin', {}, { [OBSERVATORY_TOKEN_HEADER]: 'wrong' })).status).toBe(403);
    const begin = await post('/channels/telegram/begin', {});
    expect(await begin.json()).toEqual({ ok: true, requestId: 'credential-1' });
    const start = await post('/channels/telegram/start', { ref: 'telegram-bot' });
    expect(await start.json()).toEqual({ ok: true, channel: card('pairing', 'ABC123') });
    const disconnect = await post('/channels/telegram/disconnect', {});
    expect(await disconnect.json()).toEqual({ ok: true, channel: card('disconnected') });
    expect(calls).toEqual([
      { op: 'begin', id: 'telegram' },
      { op: 'start', id: 'telegram', ref: 'telegram-bot' },
      { op: 'disconnect', id: 'telegram' },
    ]);
  });

  test('a cross-origin text/plain body is refused before reaching the host', async () => {
    const before = calls.length;
    const response = await fetch(`${base()}/channels/telegram/begin`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example', [OBSERVATORY_TOKEN_HEADER]: token },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(415);
    expect(calls).toHaveLength(before);
  });
});

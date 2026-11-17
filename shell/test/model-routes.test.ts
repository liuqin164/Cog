/**
 * The route layer: the named-route store, the runtime router, and the failure classes a custom
 * OpenAI-compatible endpoint produces — each judged against a real local fake endpoint, and each fed
 * through the existing failure ladder (`classifyProviderError`/`planFailure`), not around it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MgModelProvider } from '../src/plugins/mg-provider.ts';
import { ModelRouter } from '../src/model/router.ts';
import { BUILTIN_ROUTE_NAME, RouteStore, redactSecrets, redactUrl, safeRouteName, type ModelRoute } from '../src/model/routes.ts';
import { classifyEndpointFailure, classifyProviderError, planFailure, type RetryPolicy } from '../src/state/retry.ts';
import { makeTempDir } from './helpers.ts';

const POLICY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 };

const STORED: ModelRoute = { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek', model: 'deepseek-chat' };

function storeAt(dir: string): RouteStore {
  return new RouteStore(join(dir, 'routes.json')).load();
}

describe('the named route store', () => {
  test('adds, persists 0600, reloads, and upserts by name', () => {
    const dir = makeTempDir();
    const path = join(dir, 'routes.json');
    const store = new RouteStore(path).load();
    expect(store.list()).toEqual([]);
    expect(store.active).toBeUndefined();

    store.add(STORED);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.setActive('deepseek');

    const reloaded = new RouteStore(path).load();
    expect(reloaded.list()).toEqual([STORED]);
    expect(reloaded.active).toBe('deepseek');

    store.add({ ...STORED, model: 'deepseek-reasoner' });
    expect(store.list()).toEqual([{ ...STORED, model: 'deepseek-reasoner' }]);
  });

  test('the built-in name is reserved, and a stored mg route cannot shadow it', async () => {
    const dir = makeTempDir();
    const store = storeAt(dir);
    expect(() => store.add({ ...STORED, name: BUILTIN_ROUTE_NAME })).toThrow('route_name_reserved');

    // A hand-edited file that claims the built-in name is dropped on load, not silently preferred.
    await Bun.write(join(dir, 'hand.json'), JSON.stringify({ schema: 1, active: BUILTIN_ROUTE_NAME, routes: [{ ...STORED, name: BUILTIN_ROUTE_NAME }] }));
    const reloaded = new RouteStore(join(dir, 'hand.json')).load();
    expect(reloaded.list()).toEqual([]);
  });

  test('a missing file is an empty store; a corrupt one is remembered and never clobbered', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'routes.json');
    expect(storeAt(dir).list()).toEqual([]);
    expect(storeAt(dir).error).toBeUndefined();

    await Bun.write(path, '{ not json');
    const broken = storeAt(dir);
    expect(broken.list()).toEqual([]);
    expect(broken.error).toContain('routes_unreadable');

    // The next write keeps the unreadable bytes beside the file instead of losing them.
    broken.add(STORED);
    expect(existsSync(`${path}.broken`)).toBe(true);
    expect(storeAt(dir).list()).toEqual([STORED]);
  });

  test('a file that is not this schema is reported, not silently emptied', async () => {
    const dir = makeTempDir();
    await Bun.write(join(dir, 'routes.json'), JSON.stringify({ schema: 99, routes: [] }));
    const store = storeAt(dir);
    expect(store.error).toContain('routes_schema');
    expect(store.list()).toEqual([]);
  });

  test('entries missing a required field are dropped, and the drop is reported', async () => {
    const dir = makeTempDir();
    await Bun.write(join(dir, 'routes.json'), JSON.stringify({ schema: 1, active: 'ok', routes: [STORED, { name: 'half', baseUrl: 'https://x/v1' }] }));
    const store = storeAt(dir);
    expect(store.list()).toEqual([STORED]);
    expect(store.error).toContain('routes_invalid_entries');
  });

  test('a route without a name, URL or model is refused', () => {
    const store = storeAt(makeTempDir());
    expect(() => store.add({ name: 'x', baseUrl: '', apiKey: 'k', model: 'm' })).toThrow('route_invalid');
  });

  test('safeRouteName never hands the built-in name to a user route', () => {
    expect(safeRouteName('  deepseek  ')).toBe('deepseek');
    expect(safeRouteName('')).toBe('custom');
    expect(safeRouteName('mg')).toBe('custom');
  });

  test('redaction masks a known secret, including inside a URL query', () => {
    expect(redactSecrets('bad key sk-secret here', ['sk-secret'])).toBe('bad key *** here');
    expect(redactUrl('https://api.example/v1?key=sk-secret', ['sk-secret'])).not.toContain('sk-secret');
    expect(redactUrl('https://user:pass@api.example/v1', [])).not.toContain('pass');
    expect(redactUrl('https://user:sk-secret@api.example/v1', ['sk-secret'])).not.toContain('sk-secret');
    expect(redactUrl(undefined)).toBe('');
  });
});

describe('the model router', () => {
  test('the built-in mg route is always first, and the stored active route wins on construction', () => {
    const dir = makeTempDir();
    const store = storeAt(dir);
    store.add(STORED);
    const builtin: ModelRoute = { name: BUILTIN_ROUTE_NAME, baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'magpie', model: 'auto/deepseek-v4.1-flash' };

    const fresh = new ModelRouter({ store, builtin, timeoutMs: 1_000 });
    expect(fresh.active).toBe(BUILTIN_ROUTE_NAME);
    expect(fresh.labels()).toEqual(['mg/auto/deepseek-v4.1-flash', 'deepseek/deepseek-chat']);

    store.setActive('deepseek');
    const resumed = new ModelRouter({ store, builtin, timeoutMs: 1_000 });
    expect(resumed.active).toBe('deepseek');
    expect(resumed.name).toBe('deepseek');
    expect(resumed.model).toBe('deepseek-chat');
  });

  test('switching changes the endpoint in place and is remembered; unknown names are refused', () => {
    const dir = makeTempDir();
    const store = storeAt(dir);
    store.add(STORED);
    const builtin: ModelRoute = { name: BUILTIN_ROUTE_NAME, baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'magpie', model: 'auto/x' };
    const router = new ModelRouter({ store, builtin, timeoutMs: 1_000 });

    router.switchTo('deepseek');
    expect(router.active).toBe('deepseek');
    expect(router.model).toBe('deepseek-chat');
    expect(storeAt(dir).active).toBe('deepseek');

    router.switchTo('mg');
    expect(router.active).toBe('mg');
    expect(router.model).toBe('auto/x');
    // The built-in route is not user configuration, so no pointer is stored for it.
    expect(storeAt(dir).active).toBeUndefined();

    expect(() => router.switchTo('nope')).toThrow('route_unknown');
  });
});

// ── The fake OpenAI endpoint ────────────────────────────────────────────────────────────────────

interface FakeEndpoint {
  baseUrl: string;
  stop(): void;
  requests: string[];
}

function startFake(status: number, body: unknown, options: { delayMs?: number; statuses?: number[]; headers?: Record<string, string> } = {}): FakeEndpoint {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      requests.push(new URL(request.url).pathname);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const answer = options.statuses?.[requests.length - 1] ?? status;
      return new Response(JSON.stringify(body), { status: answer, headers: { 'content-type': 'application/json', ...options.headers } });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

function complete(provider: MgModelProvider, timeoutMs = 3_000): Promise<unknown> {
  return provider.complete({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    systemPrompt: 'probe',
    model: provider.model,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function failureOf(provider: MgModelProvider, timeoutMs?: number): Promise<string> {
  try {
    await complete(provider, timeoutMs);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to fail');
}

function providerFor(
  endpoint: FakeEndpoint,
  apiKey = 'sk-test',
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; maxTotalMs: number },
  onRetry?: (event: { attempt: number; status: number; delayMs: number }) => void,
): MgModelProvider {
  return new MgModelProvider({
    baseUrl: endpoint.baseUrl,
    apiKey,
    model: 'test-model',
    timeoutMs: 3_000,
    ...(retry ? { retry } : {}),
    ...(onRetry ? { onRetry } : {}),
  }, 'custom');
}

describe('custom endpoint failures land in the existing ladder', () => {
  test('200 is a normal turn (the fixture is a real call, not a mock)', async () => {
    const endpoint = startFake(200, { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
    try {
      const turn = (await complete(providerFor(endpoint))) as { text: string };
      expect(turn.text).toBe('OK');
      expect(endpoint.requests).toEqual(['/v1/chat/completions']);
    } finally {
      endpoint.stop();
    }
  });

  test('401 is auth: no retry, and the key echoed back by the endpoint is masked', async () => {
    const endpoint = startFake(401, { error: { message: 'Invalid API key provided: sk-leak-this' } });
    const provider = providerFor(endpoint, 'sk-leak-this');
    try {
      const message = await failureOf(provider);
      expect(message).toContain('401');
      expect(message).not.toContain('sk-leak-this');
      expect(message).toContain('***');
      expect(classifyEndpointFailure(message)).toBe('auth');
      expect(classifyProviderError(message)).toBe('fatal');
      expect(planFailure({ message, attempt: 0, policy: POLICY, overflowRecoveryUsed: false })).toMatchObject({ action: 'fail' });
    } finally {
      endpoint.stop();
    }
  });

  test('403 is auth too: no retry', async () => {
    const endpoint = startFake(403, { error: { message: 'Access denied' } });
    try {
      const message = await failureOf(providerFor(endpoint));
      expect(classifyEndpointFailure(message)).toBe('auth');
      expect(planFailure({ message, attempt: 0, policy: POLICY, overflowRecoveryUsed: false })).toMatchObject({ action: 'fail' });
    } finally {
      endpoint.stop();
    }
  });

  test('404 is model-not-found: no retry, the hint is the model name', async () => {
    const endpoint = startFake(404, { error: { message: "The model 'test-model' does not exist" } });
    try {
      const message = await failureOf(providerFor(endpoint));
      expect(classifyEndpointFailure(message)).toBe('model_not_found');
      expect(planFailure({ message, attempt: 0, policy: POLICY, overflowRecoveryUsed: false })).toMatchObject({ action: 'fail', kind: 'fatal' });
    } finally {
      endpoint.stop();
    }
  });

  test('429 is retried by the provider, and the retry count reaches the caller', async () => {
    const endpoint = startFake(429, { error: { message: 'rate limit exceeded, slow down' } });
    const retries: Array<{ attempt: number; status: number; delayMs: number }> = [];
    try {
      const message = await failureOf(providerFor(
        endpoint,
        'sk-test',
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, maxTotalMs: 1_000 },
        (event) => retries.push(event),
      ));
      expect(endpoint.requests).toHaveLength(3);
      expect(retries.map((event) => event.attempt)).toEqual([1, 2]);
      expect(classifyEndpointFailure(message)).toBe('rate_limit');
      expect(message).toContain('provider_retry: attempts=3');
      // The run ladder does not retry it again: the provider already spent the budget (#282).
      expect(planFailure({ message, attempt: 0, policy: POLICY, overflowRecoveryUsed: false })).toMatchObject({ action: 'fail' });
    } finally {
      endpoint.stop();
    }
  });

  test('a 429 followed by 200 succeeds, and the retry is accounted', async () => {
    const endpoint = startFake(200, { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }, { statuses: [429, 200] });
    const retries: Array<{ attempt: number; status: number; delayMs: number }> = [];
    try {
      const turn = (await complete(providerFor(
        endpoint,
        'sk-test',
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, maxTotalMs: 1_000 },
        (event) => retries.push(event),
      ))) as { text: string };
      expect(turn.text).toBe('OK');
      expect(endpoint.requests).toHaveLength(2);
      expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 1 }]);
    } finally {
      endpoint.stop();
    }
  });

  test('a 400 is not retried: the provider loop only takes 429/5xx', async () => {
    const endpoint = startFake(400, { error: { message: 'bad request' } });
    try {
      const message = await failureOf(providerFor(endpoint, 'sk-test', { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, maxTotalMs: 1_000 }));
      expect(endpoint.requests).toHaveLength(1);
      expect(message).not.toContain('provider_retry');
    } finally {
      endpoint.stop();
    }
  });

  test('a refused connection is retryable with exponential backoff', async () => {
    const endpoint = startFake(200, { choices: [] });
    const port = new URL(endpoint.baseUrl).port;
    endpoint.stop();
    const provider = new MgModelProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'test-model', timeoutMs: 3_000 }, 'custom');
    const message = await failureOf(provider);
    expect(classifyEndpointFailure(message)).toBe('unreachable');
    expect(classifyProviderError(message)).toBe('retryable');
    expect(planFailure({ message, attempt: 0, policy: POLICY, overflowRecoveryUsed: false })).toMatchObject({ action: 'retry', delayMs: 1_000 });
    expect(planFailure({ message, attempt: 2, policy: POLICY, overflowRecoveryUsed: false })).toMatchObject({ action: 'retry', delayMs: 4_000 });
  });

  test('a timeout is the diagnosis, and it is not retried', async () => {
    const endpoint = startFake(200, { choices: [{ message: { content: 'too late' } }] }, { delayMs: 300 });
    const provider = new MgModelProvider({ baseUrl: endpoint.baseUrl, apiKey: 'sk-test', model: 'test-model', timeoutMs: 60 }, 'custom');
    try {
      const message = await failureOf(provider, 60);
      expect(classifyEndpointFailure(message)).toBe('timeout');
      expect(classifyProviderError(message)).toBe('timeout');
      expect(planFailure({ message, attempt: 0, policy: POLICY, overflowRecoveryUsed: false })).toMatchObject({ action: 'fail', kind: 'timeout' });
    } finally {
      endpoint.stop();
    }
  });
});

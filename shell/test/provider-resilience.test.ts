/**
 * #282: a 429 from the gateway is retried inside the provider's budget, and a run that still fails
 * says so on the user's face instead of ending silently. The endpoint is a real local HTTP server so
 * the status, the retry, and the accounting are the production path, not a mock of it.
 */
import { describe, expect, test } from 'bun:test';
import { makeShell, makeTempDir } from './helpers.ts';
import { MgModelProvider, type ProviderRetryPolicy } from '../src/plugins/mg-provider.ts';

interface FakeEndpoint {
  baseUrl: string;
  requests: string[];
  stop(): void;
}

interface StubReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Server-side latency before the reply, for the budget-exhausted edge. */
  delayMs?: number;
}

function startStub(replies: StubReply[]): FakeEndpoint {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      requests.push(new URL(request.url).pathname);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

function startFake(statuses: number[], body: unknown): FakeEndpoint {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      const status = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

const OK = { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] };
const LIMITED = { error: { message: 'rate limit exceeded, slow down' } };

interface RetryEvent {
  attempt: number;
  status: number;
  delayMs: number;
}

function providerFor(endpoint: FakeEndpoint, retry: Partial<ProviderRetryPolicy>, retries: RetryEvent[]): MgModelProvider {
  return new MgModelProvider({
    baseUrl: endpoint.baseUrl,
    apiKey: 'sk-test',
    model: 'test-model',
    timeoutMs: 10_000,
    retry,
    onRetry: (event) => retries.push(event),
  }, 'test');
}

function complete(provider: MgModelProvider): Promise<{ text: string }> {
  return provider.complete({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    systemPrompt: 'probe',
    model: provider.model,
    signal: AbortSignal.timeout(10_000),
  }) as Promise<{ text: string }>;
}

describe('provider 429 resilience', () => {
  test('a 429 followed by 200 completes the run, and the retry is in the trace', async () => {
    const endpoint = startFake([429, 200], OK);
    const dir = makeTempDir();
    const shell = makeShell(dir, undefined, {
      // Long enough for the default 1 s + 2 s backoff; production's cap is 120 s (#240).
      model: { baseUrl: endpoint.baseUrl, apiKey: 'sk-test', model: 'test-model', timeoutMs: 10_000 },
    });
    await shell.start();
    try {
      const summary = await shell.submit('hello');
      expect(summary?.stopReason).toBe('run_complete');
      expect(summary?.assistantText).toBe('OK');
      expect(endpoint.requests).toHaveLength(2);
      const retries = shell.trace.read().filter((record) => record.kind === 'provider_retry');
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ status: 429, attempt: 1 });
    } finally {
      await shell.stop();
      endpoint.stop();
    }
  }, 20_000);

  test('a persistent 429 ends the run with a visible, retryable explanation', async () => {
    const endpoint = startFake([429], LIMITED);
    const dir = makeTempDir();
    const shell = makeShell(dir, undefined, {
      model: { baseUrl: endpoint.baseUrl, apiKey: 'sk-test', model: 'test-model', timeoutMs: 10_000 },
    });
    const notices: string[] = [];
    const printed: string[] = [];
    shell.host.bus.on('companion_notice', (event: { text?: string }) => notices.push(String(event.text)));
    shell.host.bus.on('terminal_print', (event: { text?: string }) => printed.push(String(event.text)));
    await shell.start();
    try {
      const summary = await shell.submit('hello');
      expect(summary?.stopReason).toBe('run_error');
      // 3 calls total: the first plus the two retries the provider budget allows.
      expect(endpoint.requests).toHaveLength(3);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('429');
      expect(notices[0]).toContain('重试');
      expect(printed).toEqual([`${notices[0]}\n`]);
      expect(shell.state).toBe('IDLE');
      const trace = shell.trace.read();
      expect(trace.filter((record) => record.kind === 'provider_retry')).toHaveLength(2);
      expect(trace.some((record) => record.kind === 'run_failure_announced')).toBe(true);
      expect(trace.some((record) => record.kind === 'provider_call_failed' && String(record.message).includes('provider_retry: attempts=3'))).toBe(true);
    } finally {
      await shell.stop();
      endpoint.stop();
    }
  }, 20_000);
});

describe('Retry-After is honoured inside the retry budget', () => {
  // The exponential fallback is 10 ms here, so a 1 s wait can only come from the header.
  const headerWins: Partial<ProviderRetryPolicy> = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 8_000, maxTotalMs: 10_000 };

  test('a seconds value delays the retry by that many seconds', async () => {
    const endpoint = startStub([
      { status: 429, body: LIMITED, headers: { 'retry-after': '1' } },
      { status: 200, body: OK },
    ]);
    const retries: RetryEvent[] = [];
    try {
      const startedAt = Date.now();
      const turn = await complete(providerFor(endpoint, headerWins, retries));
      const elapsed = Date.now() - startedAt;
      expect(turn.text).toBe('OK');
      expect(endpoint.requests).toHaveLength(2);
      expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 1_000 }]);
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      // An unbounded wait would have taken the 8 s cap; the header's 1 s is what happened.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      endpoint.stop();
    }
  }, 20_000);

  test('an HTTP-date delays the retry until that date', async () => {
    const at = new Date(Date.now() + 2_000).toUTCString();
    const endpoint = startStub([
      { status: 429, body: LIMITED, headers: { 'retry-after': at } },
      { status: 200, body: OK },
    ]);
    const retries: RetryEvent[] = [];
    try {
      const startedAt = Date.now();
      const turn = await complete(providerFor(endpoint, headerWins, retries));
      const elapsed = Date.now() - startedAt;
      expect(turn.text).toBe('OK');
      expect(endpoint.requests).toHaveLength(2);
      expect(retries).toHaveLength(1);
      // HTTP-date has second granularity, so "2 s ahead" parses to 1–2 s of waiting.
      expect(retries[0]!.delayMs).toBeGreaterThanOrEqual(900);
      expect(retries[0]!.delayMs).toBeLessThanOrEqual(2_100);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(4_500);
    } finally {
      endpoint.stop();
    }
  }, 20_000);

  test('a value above maxDelayMs is capped instead of waiting for it', async () => {
    const endpoint = startStub([
      { status: 429, body: LIMITED, headers: { 'retry-after': '30' } },
      { status: 200, body: OK },
    ]);
    const retries: RetryEvent[] = [];
    try {
      const startedAt = Date.now();
      const turn = await complete(providerFor(endpoint, { ...headerWins, maxDelayMs: 50 }, retries));
      const elapsed = Date.now() - startedAt;
      expect(turn.text).toBe('OK');
      expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 50 }]);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      endpoint.stop();
    }
  }, 20_000);

  test('a wait longer than the remaining budget is truncated, then the run fails within budget', async () => {
    const endpoint = startStub([
      { status: 429, body: LIMITED, headers: { 'retry-after': '5' } },
      { status: 429, body: LIMITED },
    ]);
    const retries: RetryEvent[] = [];
    try {
      const startedAt = Date.now();
      const message = await complete(providerFor(endpoint, { ...headerWins, maxTotalMs: 400 }, retries))
        .then(() => 'unexpected success', (error: unknown) => String(error instanceof Error ? error.message : error));
      const elapsed = Date.now() - startedAt;
      // The 5 s header is cut to what is left of the 400 ms budget, so only one retry fits.
      expect(endpoint.requests).toHaveLength(2);
      expect(retries).toHaveLength(1);
      expect(retries[0]!.delayMs).toBeGreaterThan(0);
      expect(retries[0]!.delayMs).toBeLessThanOrEqual(400);
      expect(elapsed).toBeLessThan(2_000);
      expect(message).toContain('429');
      expect(message).toContain('provider_retry: attempts=2');
    } finally {
      endpoint.stop();
    }
  }, 20_000);

  test('an exhausted budget truncates the wait to zero: no sleep, no retry', async () => {
    const endpoint = startStub([
      // The slow 429 arrives after the 100 ms budget is already gone.
      { status: 429, body: LIMITED, headers: { 'retry-after': '1' }, delayMs: 250 },
    ]);
    const retries: RetryEvent[] = [];
    try {
      const startedAt = Date.now();
      const message = await complete(providerFor(endpoint, { ...headerWins, maxTotalMs: 100 }, retries))
        .then(() => 'unexpected success', (error: unknown) => String(error instanceof Error ? error.message : error));
      const elapsed = Date.now() - startedAt;
      expect(endpoint.requests).toHaveLength(1);
      expect(retries).toHaveLength(0);
      expect(elapsed).toBeLessThan(1_500);
      expect(message).toContain('429');
      expect(message).not.toContain('provider_retry');
    } finally {
      endpoint.stop();
    }
  }, 20_000);

  test('a non-numeric, non-date header falls back to the exponential delay', async () => {
    const endpoint = startStub([
      { status: 429, body: LIMITED, headers: { 'retry-after': 'soon' } },
      { status: 200, body: OK },
    ]);
    const retries: RetryEvent[] = [];
    try {
      const turn = await complete(providerFor(endpoint, headerWins, retries));
      expect(turn.text).toBe('OK');
      expect(endpoint.requests).toHaveLength(2);
      expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 10 }]);
    } finally {
      endpoint.stop();
    }
  }, 20_000);

  test('a date in the past retries immediately without crashing', async () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const endpoint = startStub([
      { status: 429, body: LIMITED, headers: { 'retry-after': past } },
      { status: 200, body: OK },
    ]);
    const retries: RetryEvent[] = [];
    try {
      const turn = await complete(providerFor(endpoint, headerWins, retries));
      expect(turn.text).toBe('OK');
      expect(endpoint.requests).toHaveLength(2);
      expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 0 }]);
    } finally {
      endpoint.stop();
    }
  }, 20_000);
});

/**
 * #282: a 429 from the gateway is retried inside the provider's budget, and a run that still fails
 * says so on the user's face instead of ending silently. The endpoint is a real local HTTP server so
 * the status, the retry, and the accounting are the production path, not a mock of it.
 */
import { describe, expect, test } from 'bun:test';
import { makeShell, makeTempDir } from './helpers.ts';

interface FakeEndpoint {
  baseUrl: string;
  requests: string[];
  stop(): void;
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

import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { EventBus } from '../src/bus.ts';
import { AgentRuntime, type ToolInvoker } from '../src/state/agent-loop.ts';
import { RunCage } from '../src/plugins/cage.ts';
import { MgModelProvider } from '../src/plugins/mg-provider.ts';
import { TraceLog } from '../src/trace.ts';
import { makeShell, makeTempDir, recordEvents, waitUntil } from './helpers.ts';

interface FakeEndpoint {
  baseUrl: string;
  stop(): void;
}

function startSse(payloads: string[], delayMs = 20): FakeEndpoint {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          for (const payload of payloads) {
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            await Bun.sleep(delayMs);
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function startJson(body: unknown): FakeEndpoint {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

const delta = (content: string): string => JSON.stringify({ choices: [{ delta: { content } }] });

function providerAt(baseUrl: string): MgModelProvider {
  return new MgModelProvider({ baseUrl, apiKey: 'sk-test', model: 'test-model', timeoutMs: 5_000 }, 'test');
}

function runtime(bus: EventBus, provider: MgModelProvider, trace?: TraceLog): AgentRuntime {
  const tools: ToolInvoker = {
    list: () => [],
    invoke: async (name, call) => ({ toolCallId: call.toolCallId, toolName: name, output: '', isError: false }),
  };
  return new AgentRuntime({
    bus,
    tools,
    provider,
    budget: new RunCage({ maxTurnsPerRun: 4, maxTokensPerRun: 10_000, toolWhitelist: null }),
    systemPrompt: () => 'system',
    trace,
    clock: () => Date.now(),
  });
}

function complete(provider: MgModelProvider, onDelta?: (chunk: string) => void) {
  return provider.complete({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    systemPrompt: 'system',
    model: provider.model,
    signal: AbortSignal.timeout(5_000),
    onDelta,
  });
}

describe('mg provider streaming', () => {
  test('three SSE deltas become three message_update events with the whole final text', async () => {
    const endpoint = startSse([
      delta('alpha '),
      delta('beta '),
      delta('gamma'),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]);
    const bus = new EventBus();
    const updates = recordEvents(bus, ['message_update']);
    const trace = new TraceLog(makeTempDir());
    try {
      const summary = await runtime(bus, providerAt(endpoint.baseUrl), trace).run({ runId: 'r1', sessionId: 's1', userText: 'hi' });
      expect(updates).toHaveLength(3);
      expect(updates.map((event) => event.payload.delta)).toEqual(['alpha ', 'beta ', 'gamma']);
      expect(summary.assistantText).toBe('alpha beta gamma');
      const calls = trace.read().filter((record) => record.kind === 'provider_call');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.provider_stream).toBe(true);
      expect(calls[0]!.ttftMs).toBeNumber();
      expect(calls[0]!.durationMs as number).toBeGreaterThanOrEqual(calls[0]!.ttftMs as number);
    } finally {
      endpoint.stop();
    }
  });

  test('a non-SSE body takes the whole-response path and the trace says so', async () => {
    const endpoint = startJson({ choices: [{ message: { content: 'alpha beta gamma' }, finish_reason: 'stop' }] });
    const bus = new EventBus();
    const updates = recordEvents(bus, ['message_update']);
    const trace = new TraceLog(makeTempDir());
    try {
      const summary = await runtime(bus, providerAt(endpoint.baseUrl), trace).run({ runId: 'r2', sessionId: 's2', userText: 'hi' });
      expect(updates).toHaveLength(1);
      expect(updates[0]!.payload.delta).toBe('alpha beta gamma');
      expect(summary.assistantText).toBe('alpha beta gamma');
      const calls = trace.read().filter((record) => record.kind === 'provider_call');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.provider_stream).toBe(false);
    } finally {
      endpoint.stop();
    }
  });

  test('streamed tool-call arguments are accumulated and parsed after the stream ends', async () => {
    const endpoint = startSse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo', arguments: '{"va' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'lue":1}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ]);
    try {
      const turn = await complete(providerAt(endpoint.baseUrl));
      expect(turn.streamed).toBe(true);
      expect(turn.toolCalls).toEqual([{ toolCallId: 'call-1', toolName: 'echo', input: { value: 1 } }]);
    } finally {
      endpoint.stop();
    }
  });

  test('the terminal channel prints deltas and does not print the final message twice', async () => {
    const endpoint = startSse([delta('alpha '), delta('beta '), delta('gamma'), '[DONE]'], 40);
    const dir = makeTempDir();
    const input = new PassThrough();
    const writes: string[] = [];
    const output = {
      write(chunk: string | Uint8Array) {
        writes.push(chunk.toString());
        return true;
      },
    } as NodeJS.WritableStream;
    const shell = makeShell(dir, undefined, {
      model: { baseUrl: endpoint.baseUrl, apiKey: 'sk-test', model: 'test-model', timeoutMs: 5_000 },
      terminalEnabled: true,
    }, { terminalInput: input, terminalOutput: output });
    await shell.start();
    try {
      input.write('hi\n');
      await waitUntil(() => writes.join('').includes('alpha beta gamma\n'));
      const printed = writes.join('');
      expect(printed.split('alpha beta gamma').length - 1).toBe(1);
      expect(writes).toContain('alpha ');
      expect(writes).toContain('beta ');
      expect(writes).toContain('gamma');
    } finally {
      await shell.stop();
      endpoint.stop();
    }
  });
});

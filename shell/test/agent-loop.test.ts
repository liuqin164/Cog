import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/bus.ts';
import { AgentRuntime, type ToolInvoker } from '../src/state/agent-loop.ts';
import { RunCage } from '../src/plugins/cage.ts';
import { recordEvents, ScriptedProvider, type RecordedEvent } from './helpers.ts';

function tools(overrides: Partial<ToolInvoker> = {}): ToolInvoker {
  const definitions = [{ name: 'echo', description: 'echo', parameters: {}, source: 'test' }];
  return {
    list: () => definitions,
    invoke: async (name, call) => ({ toolCallId: call.toolCallId, toolName: name, output: `echo:${JSON.stringify(call.input)}`, isError: false }),
    ...overrides,
  };
}

function runtime(bus: EventBus, provider: ScriptedProvider, invoker = tools(), cage = new RunCage({ maxTurnsPerRun: 10, maxTokensPerRun: 10_000, toolWhitelist: null })) {
  return new AgentRuntime({ bus, tools: invoker, provider, budget: cage, systemPrompt: () => 'system' });
}

describe('Pi-aligned loop', () => {
  test('event order is verbatim and a tool call adds a second turn', async () => {
    const bus = new EventBus();
    const seen = recordEvents(bus, [
      'before_agent_start', 'agent_start', 'turn_start', 'message_start', 'message_update', 'message_end',
      'tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_end',
    ]);
    const provider = new ScriptedProvider([
      { text: 'let me look', toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: { value: 1 } }] },
      { text: 'all done', toolCalls: [] },
    ]);
    const summary = await runtime(bus, provider).run({ runId: 'r1', sessionId: 's1', userText: 'hi' });
    expect(seen.map((event) => event.name)).toEqual([
      'before_agent_start', 'agent_start',
      'message_start', 'message_end',
      'turn_start', 'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_end', 'turn_end',
      'turn_start', 'message_start', 'message_update', 'message_end', 'turn_end',
      'agent_end',
    ]);
    // The two leading message events are the user message entering the loop (Pi's tree: message_start/end).
    expect(seen[2].payload.message.role).toBe('user');
    expect(summary.stopReason).toBe('run_complete');
    expect(summary.assistantText).toContain('all done');
    expect(summary.toolResults[0].output).toBe('echo:{"value":1}');
    // The model sees the tool result as a `tool` message before the second call.
    expect(provider.calls[1].messages.some((message) => message.role === 'tool' && message.content.includes('echo:'))).toBe(true);
  });

  test('beforeToolCall block short-circuits execution and later hooks', async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on('beforeToolCall', () => {
      calls.push('first');
      return { block: true, reason: 'whitelist says no' };
    });
    bus.on('beforeToolCall', () => {
      calls.push('second');
      return undefined;
    });
    let executed = 0;
    const provider = new ScriptedProvider([
      { text: 'tool', toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: {} }] },
      { text: 'done', toolCalls: [] },
    ]);
    const summary = await runtime(bus, provider, tools({ invoke: async (name, call) => { executed += 1; return { toolCallId: call.toolCallId, toolName: name, output: 'ran', isError: false }; } })).run({ runId: 'r', sessionId: 's', userText: 'x' });
    expect(calls).toEqual(['first']);
    expect(executed).toBe(0);
    expect(summary.toolResults[0].isError).toBe(true);
    expect(summary.toolResults[0].output).toBe('whitelist says no');
  });

  test('steering drains after the tool batch and before the next turn', async () => {
    const bus = new EventBus();
    const provider = new ScriptedProvider([
      { text: 'first', toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: {} }] },
      { text: 'second', toolCalls: [] },
    ]);
    const runner = runtime(bus, provider);
    bus.on('tool_execution_end', () => runner.steer('change of plan'));
    const summary = await runner.run({ runId: 'r', sessionId: 's', userText: 'start' });
    expect(summary.turns).toBe(2);
    const secondCall = provider.calls[1].messages;
    expect(secondCall.some((message) => message.role === 'user' && message.content === 'change of plan')).toBe(true);
  });

  test('steering injected with no tools still gets a turn before follow-up', async () => {
    const bus = new EventBus();
    const provider = new ScriptedProvider([
      { text: 'plain answer', toolCalls: [] },
      { text: 'after steering', toolCalls: [] },
      { text: 'after followup', toolCalls: [] },
    ]);
    const runner = runtime(bus, provider);
    let steered = false;
    bus.on('message_end', (event: { message?: { role?: string } }) => {
      if (event.message?.role === 'assistant' && !steered) {
        steered = true;
        runner.steer('steer now');
      }
    });
    runner.followUp('follow up later');
    const summary = await runner.run({ runId: 'r', sessionId: 's', userText: 'start' });
    expect(summary.turns).toBe(3);
    expect(provider.calls[1].messages.some((message) => message.role === 'user' && message.content === 'steer now')).toBe(true);
    expect(provider.calls[2].messages.some((message) => message.role === 'user' && message.content === 'follow up later')).toBe(true);
  });

  test('turn budget overrun ends the run with budget_exceeded', async () => {
    const bus = new EventBus();
    const provider = new ScriptedProvider([{ text: 'looping', toolCalls: [{ toolCallId: 'c', toolName: 'echo', input: {} }] }]);
    const cage = new RunCage({ maxTurnsPerRun: 2, maxTokensPerRun: 10_000, toolWhitelist: null });
    const summary = await runtime(bus, provider, tools(), cage).run({ runId: 'r', sessionId: 's', userText: 'go' });
    expect(summary.stopReason).toBe('budget_exceeded');
    expect(summary.turns).toBe(2);
    expect(summary.error).toContain('turn_budget_exceeded');
  });

  test('afterToolCall can replace a result and terminate the run', async () => {
    const bus = new EventBus();
    bus.on('afterToolCall', () => ({ result: { toolCallId: 'c1', toolName: 'echo', output: 'rewritten', isError: false }, terminate: true }));
    const provider = new ScriptedProvider([
      { text: 'tool', toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: {} }] },
      { text: 'should not be called', toolCalls: [] },
    ]);
    const summary = await runtime(bus, provider).run({ runId: 'r', sessionId: 's', userText: 'go' });
    expect(summary.toolResults[0].output).toBe('rewritten');
    expect(summary.turns).toBe(1);
    expect(summary.stopReason).toBe('run_complete');
  });

  test('a provider failure becomes run_error, not an unhandled rejection', async () => {
    const bus = new EventBus();
    const provider = new ScriptedProvider([() => {
      throw new Error('gateway down');
    }]);
    const summary = await runtime(bus, provider).run({ runId: 'r', sessionId: 's', userText: 'go' });
    expect(summary.stopReason).toBe('run_error');
    expect(summary.error).toContain('gateway down');
  });
});

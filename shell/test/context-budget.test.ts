import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/bus.ts';
import { AgentRuntime, type ToolInvoker } from '../src/state/agent-loop.ts';
import { accountRequest, estimateMessagesTokens, estimateTokens, fitRequestToBudget, TOOL_RESULT_TOKEN_LIMIT, type ContextAccount } from '../src/state/context-budget.ts';
import { RunCage } from '../src/plugins/cage.ts';
import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

function tools(): ToolInvoker {
  const definitions = [{ name: 'echo', description: 'echo a value', parameters: { type: 'object' }, source: 'test' }];
  return {
    list: () => definitions,
    invoke: async (name, call) => ({ toolCallId: call.toolCallId, toolName: name, output: 'ok', isError: false }),
  };
}

function runtime(bus: EventBus, provider: ScriptedProvider, onContextAssembled?: (account: ContextAccount) => void) {
  return new AgentRuntime({
    bus,
    tools: tools(),
    provider,
    budget: new RunCage({ maxTurnsPerRun: 10, maxTokensPerRun: 10_000, toolWhitelist: null }),
    systemPrompt: () => 'SYS',
    onContextAssembled,
  });
}

describe('context accounting (character-class estimate, #318)', () => {
  test('ASCII is 4 chars/token, tool-call arguments are counted, Chinese is charged by its class', () => {
    expect(estimateTokens({ role: 'user', content: 'abcd' })).toBe(1);
    expect(estimateTokens({ role: 'user', content: 'abcde' })).toBe(2);
    expect(estimateTokens({ role: 'tool', content: 'x'.repeat(8), toolCallId: 'c1', toolName: 'echo' })).toBe(2);
    // 'hi' (2) + 'echo' (4) + '{"value":1}' (11) = 17 chars.
    expect(estimateTokens({ role: 'assistant', content: 'hi', toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: { value: 1 } }] })).toBe(5);
    expect(estimateTokens({ role: 'system', content: '', toolsAdded: ['a', 'b'] })).toBe(3);
    expect(estimateMessagesTokens([{ role: 'user', content: 'abcd' }, { role: 'assistant', content: 'abcd' }])).toBe(2);
    // 1,000 Chinese characters are 640 estimated tokens, not the 250 chars/4 reported (#318).
    expect(estimateTokens({ role: 'user', content: '中文'.repeat(500) })).toBe(640);
  });

  test('the account is the request sum: system prompt, tool schemas, messages, per role', () => {
    const account = accountRequest({
      messages: [{ role: 'user', content: 'abcd' }, { role: 'tool', content: 'x'.repeat(8), toolCallId: 'c1', toolName: 'echo' }],
      systemPrompt: 'abcdefgh',
      tools: [{ name: 'echo', description: 'echo a value', parameters: { type: 'object' } }],
    });
    expect(account.systemTokens).toBe(2);
    expect(account.messageTokens).toBe(3);
    expect(account.byRole).toEqual({ user: 1, assistant: 0, tool: 2, system: 0 });
    expect(account.toolTokens).toBeGreaterThan(0);
    expect(account.totalTokens).toBe(account.systemTokens + account.toolTokens + account.messageTokens);
    expect(account.messages).toBe(2);
  });

  test('a transformContext-injected block is inside the measured request', async () => {
    const bus = new EventBus();
    const accounts: ContextAccount[] = [];
    bus.on('transformContext', (value: unknown) => {
      if (!Array.isArray(value)) return value;
      return [...value, { role: 'system', content: 'X'.repeat(400) }];
    });
    const provider = new ScriptedProvider([{ text: 'ok', toolCalls: [] }]);
    await runtime(bus, provider, (account) => accounts.push(account)).run({ runId: 'r', sessionId: 's', userText: 'hi' });

    expect(accounts).toHaveLength(1);
    const sent = provider.calls[0];
    const expected = accountRequest({ messages: sent.messages, systemPrompt: sent.systemPrompt, tools: sent.tools });
    // The measured request is exactly what the provider received — including the injected block and
    // the system prompt, neither of which is a message event this process emits.
    expect(accounts[0]).toEqual(expected);
    expect(accounts[0].messageTokens).toBeGreaterThanOrEqual(100);
  });

  test('the gauge reports the measured request, not a running total of message events', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '好的。', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      await shell.submit('你好，今天过得怎么样？');
      const sent = provider.calls[0];
      const account = accountRequest({ messages: sent.messages, systemPrompt: sent.systemPrompt, tools: sent.tools });
      expect(shell.currentStatus().contextTokens).toBe(account.totalTokens);
      // The old accumulator was a fixed 500 plus the text of every message event, so it could never
      // carry the system prompt or the four tool schemas — both of which the provider is charged for.
      expect(account.systemTokens).toBeGreaterThan(0);
      expect(account.toolTokens).toBeGreaterThan(0);
      expect(account.totalTokens).not.toBe(500 + Math.ceil('你好，今天过得怎么样？'.length / 4) + Math.ceil('好的。'.length / 4));
    } finally {
      await shell.stop();
    }
  });
});

describe('the whole request carries the tool-output budget (#319)', () => {
  test('a 40 KB result is re-assembled to its 2k-token head plus a key the model can read', () => {
    const raw = 'x'.repeat(40_000);
    const fitted = fitRequestToBudget({
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'mem:evt-42' } }] },
        { role: 'tool', content: raw, toolCallId: 'c1', toolName: 'read' },
      ],
      systemPrompt: 'SYS',
      tools: [],
      budgetTokens: 12_000,
    });

    const result = fitted.messages.find((message) => message.role === 'tool')!;
    expect(result.toolCallId).toBe('c1');
    expect(result.toolName).toBe('read');
    expect(estimateTokens(result)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_LIMIT);
    expect(result.content).toContain('tool output folded');
    expect(result.content).toContain('mem:evt-42');
    expect(result.content.length).toBeLessThan(raw.length);
    expect(fitted.toolOutput.rawTokens).toBeGreaterThan(9_000);
    expect(fitted.toolOutput.toolOutputTokens).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_LIMIT);
    expect(fitted.toolOutput.foldedResults).toBe(1);
    expect(fitted.toolOutput.totalTokens).toBeLessThanOrEqual(12_000);
  });

  test('the newest result keeps its head; an older one is cut to the remaining budget', () => {
    const fitted = fitRequestToBudget({
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'old', toolName: 'bash', input: { command: 'cat old' } }] },
        { role: 'tool', content: 'a'.repeat(20_000), toolCallId: 'old', toolName: 'bash' },
        { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'new', toolName: 'bash', input: { command: 'cat new' } }] },
        { role: 'tool', content: 'b'.repeat(20_000), toolCallId: 'new', toolName: 'bash' },
      ],
      systemPrompt: 'SYS',
      tools: [],
      budgetTokens: 6_000,
    });

    const old = fitted.messages.find((message) => message.toolCallId === 'old')!;
    const newest = fitted.messages.find((message) => message.toolCallId === 'new')!;
    // The old result does not fit after the newest one, so its body is shorter than it was.
    expect(estimateTokens(old)).toBeLessThan(5_000);
    expect(old.content).toContain('tool output folded');
    expect(old.content).toContain('tool_call:old');
    expect(newest.content.startsWith('b')).toBe(true);
    expect(estimateTokens(newest)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_LIMIT);
    expect(newest.content).toContain('tool_call:new');
    expect(fitted.toolOutput.foldedResults).toBe(2);
    expect(fitted.toolOutput.totalTokens).toBeLessThanOrEqual(6_000);
  });

  test('the provider receives the folded result, not the 40 KB body', async () => {
    const bus = new EventBus();
    const raw = 'x'.repeat(40_000);
    const definition = { name: 'dump', description: 'return 40 KB', parameters: { type: 'object' }, source: 'test' };
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'dump', input: {} }] },
      { text: 'done', toolCalls: [] },
    ]);
    const seen: ContextAccount[] = [];
    const runtime = new AgentRuntime({
      bus,
      tools: {
        list: () => [definition],
        invoke: async (name, call) => ({ toolCallId: call.toolCallId, toolName: name, output: raw, isError: false }),
      },
      provider,
      budget: new RunCage({ maxTurnsPerRun: 10, maxTokensPerRun: 10_000, toolWhitelist: null }),
      systemPrompt: () => 'SYS',
      requestBudget: () => 12_000,
      onContextAssembled: (account) => seen.push(account),
    });

    await runtime.run({ runId: 'r', sessionId: 's', userText: 'dump it' });

    const toolMessage = provider.calls[1]!.messages.find((message) => message.role === 'tool')!;
    expect(estimateTokens(toolMessage)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_LIMIT);
    expect(toolMessage.content).toContain('tool output folded');
    expect(toolMessage.content).toContain('tool_call:c1');
    expect(seen.at(-1)!.toolOutputTokens).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_LIMIT);
    expect(seen.at(-1)!.totalTokens).toBeLessThanOrEqual(12_000);
  });
});


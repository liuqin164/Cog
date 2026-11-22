import { describe, expect, test } from 'bun:test';
import { sessionContextPlugin } from '../src/plugins/session-context.ts';
import {
  accountRequest,
  estimateTokens,
  fitRequestToBudget,
  TOOL_RESULT_RESERVE,
  TOOL_RESULT_TOKEN_LIMIT,
} from '../src/state/context-budget.ts';

describe('one ruler for fitting and assembly (#439)', () => {
  test('the calibrated factor reaches the fit and surfaces the overrun it hides today', () => {
    const messages = [
      { role: 'user' as const, content: 'read it' },
      { role: 'assistant' as const, content: '', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'a' } }] },
      { role: 'tool' as const, content: 'x'.repeat(40_000), toolCallId: 'c1', toolName: 'read' },
    ];
    const raw = fitRequestToBudget({ messages, systemPrompt: 'SYS', tools: [], budgetTokens: 4_000 });
    const calibrated = fitRequestToBudget({ messages, systemPrompt: 'SYS', tools: [], budgetTokens: 4_000, scale: 2 });
    expect(raw.toolOutput.overBudgetTokens).toBe(0);
    expect(calibrated.toolOutput.overBudgetTokens).toBeGreaterThan(0);
    expect(calibrated.toolOutput.overBudgetTokens).toBeGreaterThan(raw.toolOutput.overBudgetTokens);
  });

  test('zero headroom still keeps the newest tool result out of a stub', () => {
    const fitted = fitRequestToBudget({
      messages: [
        { role: 'system', content: 's'.repeat(8_000) },
        { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'old', toolName: 'bash', input: { command: 'cat old' } }] },
        { role: 'tool', content: 'o'.repeat(20_000), toolCallId: 'old', toolName: 'bash' },
        { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'new', toolName: 'bash', input: { command: 'cat new' } }] },
        { role: 'tool', content: 'n'.repeat(40_000), toolCallId: 'new', toolName: 'bash' },
      ],
      systemPrompt: 'SYS',
      tools: [],
      budgetTokens: 500,
    });
    const newest = fitted.messages.find((message) => message.toolCallId === 'new')!;
    const older = fitted.messages.find((message) => message.toolCallId === 'old')!;
    expect(newest.content.startsWith('n')).toBe(true);
    expect(estimateTokens(newest)).toBeGreaterThan(TOOL_RESULT_TOKEN_LIMIT / 2);
    expect(older.content.startsWith('o')).toBe(false);
  });

  test('the lane target subtracts tool schemas and the tool-result reserve', () => {
    const tools = [{ name: 'echo', description: 'e'.repeat(400), parameters: { type: 'object' } }];
    const toolTokens = accountRequest({ messages: [], systemPrompt: '', tools }).toolTokens;
    const targets: number[] = [];
    const backend = {
      recall: () => ({ items: [] }),
      assembleSessionContext: (input: { targetTokens: number }) => {
        targets.push(input.targetTokens);
        return { lanes: [], decisionTrace: [], autoExpanded: [] };
      },
    };
    const handlers = new Map<string, (value: unknown, context?: { runId?: string }) => unknown>();
    sessionContextPlugin({
      agentId: 'a',
      projectId: 'p',
      sessionId: 's',
      targetTokens: () => 10_800,
      calibrationFactor: () => 1,
      clock: () => ({ now: Date.now() }),
      tailTurns: 6,
      pinned: () => [],
      profile: () => [],
      variablePrompt: () => '',
      ledgerSeq: () => 0,
    }).apply({
      getService: () => backend,
      on: (name: string, handler: (value: unknown, context?: { runId?: string }) => unknown) => {
        handlers.set(name, handler);
      },
      logger: { error: () => {} },
    } as never, {});
    handlers.get('prepareRequest')!({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'SYS',
      tools,
      model: 'm',
    }, { runId: 'run-1' });
    expect(targets).toEqual([10_800 - toolTokens - TOOL_RESULT_RESERVE]);
  });
});

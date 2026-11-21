import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

function makeKernel() {
  return createMemoryKernel({
    dbPath: join(makeTempDir('cogmem-dream-input-slicing-'), 'memory.db'),
    vectorBackend: 'sqlite-vec',
  });
}

interface PromptEvent {
  eventId: string;
  role?: string;
  rawEventType?: string;
  text: string;
  truncated: boolean;
  originalLength: number;
}

async function capturePrompt(kernel: ReturnType<typeof makeKernel>, eventIds: string[]): Promise<PromptEvent[]> {
  let prompt = '';
  await kernel.runDreamCurator({
    projectId: 'demo',
    eventIds,
    limit: 100,
    mode: 'candidate',
    dreamMode: 'micro',
    generateText: async (_system, user) => {
      prompt = user;
      return '{}';
    },
  });
  return JSON.parse(prompt).rawLedgerEvents;
}

test('curator input keeps both ends and marks truncation per role', async () => {
  const kernel = makeKernel();
  try {
    const backend = new KernelAgentMemoryBackend(kernel);
    const userText = `${'前'.repeat(8990)}尾部规矩`;
    const assistantText = `${'后'.repeat(3990)}助手尾部`;
    const turn = await backend.rememberTurnWithResult({
      agentId: 'owner',
      projectId: 'demo',
      sessionId: 's',
      userText,
      assistantText,
      ingestMode: 'raw_then_dream',
    });
    const tool = kernel.recordToolCall({
      projectId: 'demo',
      threadId: 't',
      toolName: 'read',
      content: `${'工'.repeat(1995)}工具尾部`,
      occurredAt: Date.now(),
    });
    const events = await capturePrompt(kernel, [...turn.rawEventIds, tool.eventId]);

    const user = events.find((event) => event.role === 'user');
    expect(user.truncated).toBe(true);
    expect(user.originalLength).toBe(userText.length);
    expect(user.text).toContain('尾部规矩');
    expect(user.text).toContain('characters omitted');
    expect(user.text.length).toBeLessThan(8000 + 80);

    const assistant = events.find((event) => event.role === 'assistant' && event.rawEventType === 'message');
    expect(assistant.truncated).toBe(true);
    expect(assistant.originalLength).toBe(assistantText.length);
    expect(assistant.text).toContain('助手尾部');
    expect(assistant.text.length).toBeLessThan(3000 + 80);

    const toolEvent = events.find((event) => event.eventId === tool.eventId);
    expect(toolEvent.truncated).toBe(true);
    expect(toolEvent.originalLength).toBe(1999);
    expect(toolEvent.text).toContain('工具尾部');
    expect(toolEvent.text.length).toBeLessThan(1200 + 80);
  } finally {
    kernel.close();
  }
});

test('curator input compresses tool events before assistant and user events', async () => {
  const kernel = makeKernel();
  try {
    const backend = new KernelAgentMemoryBackend(kernel);
    const userText = `${'前'.repeat(8990)}用户尾部`;
    const assistantText = `${'后'.repeat(3990)}助手尾部`;
    const turn = await backend.rememberTurnWithResult({
      agentId: 'owner',
      projectId: 'demo',
      sessionId: 's',
      userText,
      assistantText,
      ingestMode: 'raw_then_dream',
    });
    const tools = Array.from({ length: 30 }, (_, index) => kernel.recordToolCall({
      projectId: 'demo',
      threadId: 't',
      toolName: 'read',
      content: `${'工'.repeat(1993)}工具尾部`,
      occurredAt: Date.now() + index,
    }));
    const events = await capturePrompt(kernel, [...turn.rawEventIds, ...tools.map((tool) => tool.eventId)]);

    const user = events.find((event) => event.role === 'user');
    const assistant = events.find((event) => event.role === 'assistant' && event.rawEventType === 'message');
    const toolEvents = events.filter((event) => event.rawEventType === 'tool_call');
    expect(user.text.length).toBeGreaterThan(7900);
    expect(user.text.length).toBeLessThan(8100);
    expect(assistant.text.length).toBeGreaterThan(2900);
    expect(assistant.text.length).toBeLessThan(3100);
    expect(toolEvents.every((event) => event.text.length < 400)).toBe(true);
  } finally {
    kernel.close();
  }
});

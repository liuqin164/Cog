import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { readPriorContext } from '../src/engine/PriorContext.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

test('prior context returns matching ledger events oldest to newest', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-prior-context-'), 'memory.db') });
  try {
    const old = kernel.recordRawEvent({
      projectId: 'demo',
      threadId: 't',
      role: 'user',
      content: '发布窗口改到周三晚上。',
      occurredAt: 1_000,
    });
    const current = kernel.recordRawEvent({
      projectId: 'demo',
      threadId: 't',
      role: 'user',
      content: '发布窗口改到周四晚上。',
      occurredAt: 2_000,
    });
    const slice = readPriorContext({ eventStore: kernel.eventStore }, {
      projectId: 'demo',
      keys: ['发布', '窗口'],
      asOf: current.occurredAt + 1,
      excludeEventIds: [current.eventId],
    });

    expect(slice.items).toHaveLength(1);
    expect(slice.items[0]?.sourceRefs[0]).toMatchObject({ kind: 'event', eventId: old.eventId });
    expect(slice.items[0]?.text).toContain('周三');
    expect(slice.block).toContain('<COGMEM_PRIOR_CONTEXT>');
  } finally {
    kernel.close();
  }
});

test('prior context honours the event and token budget', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-prior-context-'), 'memory.db') });
  try {
    for (let index = 0; index < 3; index += 1) {
      kernel.recordRawEvent({
        projectId: 'demo',
        threadId: 't',
        role: 'user',
        content: `发布窗口第 ${index} 次变更 ${'细节'.repeat(40)}`,
        occurredAt: 1_000 + index,
      });
    }
    const eventBudget = readPriorContext({ eventStore: kernel.eventStore }, {
      projectId: 'demo',
      keys: ['发布'],
      asOf: 2_000,
      budget: { maxEvents: 1 },
    });
    expect(eventBudget.items).toHaveLength(1);

    const tokenBudget = readPriorContext({ eventStore: kernel.eventStore }, {
      projectId: 'demo',
      keys: ['发布'],
      asOf: 2_000,
      budget: { maxTokens: 10 },
    });
    expect(tokenBudget.items).toHaveLength(0);
    expect(tokenBudget.block).toBe('');
  } finally {
    kernel.close();
  }
});

test('curator renders prior context and keeps evidence in the current window', async () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-prior-context-'), 'memory.db') });
  try {
    kernel.recordRawEvent({
      projectId: 'demo',
      threadId: 't',
      role: 'user',
      content: '发布窗口改到周三晚上。',
      occurredAt: 1_000,
    });
    const current = kernel.recordRawEvent({
      projectId: 'demo',
      threadId: 't',
      role: 'user',
      content: '发布窗口改到周四晚上。',
      occurredAt: 2_000,
    });
    let prompt: Record<string, unknown> = {};
    await kernel.runDreamCurator({
      projectId: 'demo',
      eventIds: [current.eventId],
      mode: 'candidate',
      dreamMode: 'normal',
      generateText: async (_system, user) => {
        prompt = JSON.parse(user) as Record<string, unknown>;
        return JSON.stringify({
          candidates: {
            temporalFactUpdateCandidates: [{
              claim: '发布窗口从周三改到周四。',
              previousValue: '周三',
              newValue: '周四',
              confidence: 0.9,
              evidenceEventIds: [current.eventId],
            }],
          },
        });
      },
    });

    expect(String(prompt.priorContext)).toContain('<COGMEM_PRIOR_CONTEXT>');
    expect(String(prompt.priorContext)).toContain('周三');
    const candidate = kernel.listDreamCandidates({ projectId: 'demo', candidateTypes: ['temporal_fact_update'], limit: 10 })[0];
    expect(candidate).toBeDefined();
    expect((candidate!.content as { priorContextRefs?: unknown[] }).priorContextRefs?.length).toBeGreaterThan(0);
    expect((candidate!.evidence as Array<{ eventId?: string }>).map((item) => item.eventId)).toEqual([current.eventId]);
  } finally {
    kernel.close();
  }
});

test('prior context includes matching sealed frames with source refs', () => {
  const slice = readPriorContext({
    eventStore: { searchRawEvents: () => [] },
    frameStore: {
      list: () => [{
        schemaVersion: 'memory_frame.v1',
        frameId: 'frame:1',
        projectId: 'demo',
        episodeId: 'episode-1',
        title: '发布窗口',
        summary: '改到周三晚上。',
        episodeKind: 'other',
        nodes: [{
          frameNodeId: 'node:1',
          dimension: 'topic',
          label: '发布窗口',
          confidence: 0.9,
          evidenceEventIds: ['evt-old'],
        }],
        relations: [],
        temporalReferences: [],
        stateTransitions: [],
        confidence: 0.9,
        evidenceEventIds: ['evt-old'],
        processor: { promptVersion: 'v1', generatedAt: 500 },
      }],
    },
  }, {
    projectId: 'demo',
    keys: ['发布窗口'],
    asOf: 1_000,
  });

  expect(slice.items).toHaveLength(1);
  expect(slice.items[0]?.sourceRefs[0]).toMatchObject({ kind: 'frame', frameId: 'frame:1', episodeId: 'episode-1' });
  expect(slice.block).toContain('改到周三晚上');
});

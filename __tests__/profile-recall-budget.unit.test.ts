import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

function seedEntry(kernel: MemoryKernel, projectId: string, key: string, value: string, sourceEventId?: string): void {
  const now = Date.now();
  kernel.eventStore.append({
    streamId: `profile-entry:${projectId}:${key}`,
    streamType: 'system',
    eventType: 'PROFILE_ENTRY_COMPILED',
    projectId,
    sourceId: 'profile',
    occurredAt: now,
    payload: {
      entryId: `profile:${projectId}:${key}`,
      ledger: 'preferences',
      key,
      value,
      sourceRefs: sourceEventId
        ? [{ eventId: sourceEventId, eventType: 'RAW_EVENT_RECORDED', role: 'user' }]
        : [],
      recordedAt: now,
      compiledAt: now,
      version: 1,
    },
  });
}

test('profile items are appended without taking slots from ordinary recall', () => {
  const dir = makeTempDir('cogmem-profile-budget-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db') });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    const source = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'profile-source',
      sessionId: 'profile-source',
      role: 'user',
      content: '旧的偏好来源',
      occurredAt: 1_000,
    });
    seedEntry(kernel, 'p', 'owner.deploy', '部署脚本', source.eventId);
    for (let index = 0; index < 5; index += 1) {
      kernel.recordRawEvent({
        projectId: 'p',
        threadId: `ordinary-${index}`,
        sessionId: `ordinary-${index}`,
        role: 'user',
        content: `部署脚本 记录 ${index}`,
        occurredAt: 2_000 + index,
      });
    }

    const recalled = backend.recall({ agentId: 'a', projectId: 'p', query: '部署脚本', limit: 5 });
    const ordinary = recalled.items.filter((item) => !item.id.startsWith('profile:'));
    const profile = recalled.items.filter((item) => item.id.startsWith('profile:'));

    expect(ordinary).toHaveLength(5);
    expect(profile.length).toBeGreaterThan(0);
    expect(recalled.items.length).toBeGreaterThan(5);
  } finally {
    kernel.close();
  }
});

test('stop words alone do not recall the profile, while an empty query still lists it', () => {
  const dir = makeTempDir('cogmem-profile-cues-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db') });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    for (const [index, [key, value]] of [['owner.any', '什么都可以'], ['owner.plan', '我们明天出发'], ['owner.move', '上次改期了']].entries()) {
      const source = kernel.recordRawEvent({
        projectId: 'p',
        threadId: `cue-source-${index}`,
        sessionId: `cue-source-${index}`,
        role: 'user',
        content: `来源 ${index}`,
        occurredAt: 1_000 + index,
      });
      seedEntry(kernel, 'p', key!, value!, source.eventId);
    }

    for (const query of ['什么', '我们', '上次']) {
      const recalled = backend.recall({ agentId: 'a', projectId: 'p', query, intent: 'memory_recall', limit: 5 });
      expect(recalled.items.filter((item) => item.id.startsWith('profile:'))).toHaveLength(0);
    }
    expect(kernel.profile.recall({ projectId: 'p' })).toHaveLength(3);
  } finally {
    kernel.close();
  }
});

test('a real cue still recalls the profile', () => {
  const dir = makeTempDir('cogmem-profile-cue-hit-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db') });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    const source = kernel.recordRawEvent({
      projectId: 'p',
      threadId: 'drink-source',
      sessionId: 'drink-source',
      role: 'user',
      content: '旧的饮品来源',
      occurredAt: 1_000,
    });
    seedEntry(kernel, 'p', 'owner.drink', '咖啡', source.eventId);

    const recalled = backend.recall({ agentId: 'a', projectId: 'p', query: '咖啡', limit: 5 });
    const profile = recalled.items.filter((item) => item.id.startsWith('profile:'));

    expect(profile).toHaveLength(1);
    expect(profile[0]!.text).toContain('咖啡');
  } finally {
    kernel.close();
  }
});

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import {
  SESSION_CONTEXT_LANES,
  SESSION_DEEP_SEGMENT_GAP_MS,
  type SessionContextAssembly,
} from '../src/session/index.js';
import { makeTempDir } from './helpers/tmp.js';

const T0 = Date.UTC(2026, 10, 23, 9, 0, 0);
const PROJECT = 'cache-prefix';
const AGENT = 'cache-agent';
const SESSION = 'cache-session';

function commonPrefixBytes(left: string, right: string): number {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function digestText(assembly: SessionContextAssembly): string {
  return assembly.lanes.find((lane) => lane.lane === 'digest')!.text;
}

function assemble(backend: KernelAgentMemoryBackend): SessionContextAssembly {
  return backend.assembleSessionContext({
    projectId: PROJECT,
    agentId: AGENT,
    sessionId: SESSION,
    targetTokens: 200_000,
    pinned: ['P1: be exact', 'P2: never invent'],
    profile: ['profile: prefers terse answers'],
    tailTurns: 4,
  });
}

describe('the cache prefix is pinned + profile + digest, append-only inside a segment (#475)', () => {
  test('the lane order is pinned → profile → digest → working_set → tail → recall', () => {
    expect([...SESSION_CONTEXT_LANES]).toEqual(['pinned', 'profile', 'digest', 'working_set', 'tail', 'recall']);
  });

  test('two assemblies one turn apart keep the earlier prefix byte for byte', async () => {
    const dir = makeTempDir('cogmem-cache-prefix-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const backend = new KernelAgentMemoryBackend(kernel);
    try {
      for (let index = 0; index < 12; index += 1) {
        await backend.captureConversationTurn({
          projectId: PROJECT,
          agentId: AGENT,
          sessionId: SESSION,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：继续整理文档，检查第 ${index} 节。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      const first = assemble(backend);
      await backend.captureConversationTurn({
        projectId: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        channel: 'terminal',
        speaker: 'owner',
        text: '第 12 轮：继续整理文档，检查第 12 节。',
        occurredAt: T0 + 12_000,
      });
      const second = assemble(backend);

      expect(first.stablePrefix).toContain('[pinned]');
      expect(first.stablePrefix).toContain('[profile]');
      expect(first.stablePrefix).toContain('[digest]');
      expect(second.stablePrefix.startsWith(first.stablePrefix)).toBe(true);
      expect(commonPrefixBytes(first.stablePrefix, second.stablePrefix)).toBe(Buffer.byteLength(first.stablePrefix));
      expect(digestText(second).startsWith(digestText(first))).toBe(true);
    } finally {
      kernel.close();
    }
  });

  test('an episode card created between assemblies invalidates the prefix once, then appends', async () => {
    const dir = makeTempDir('cogmem-cache-card-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const backend = new KernelAgentMemoryBackend(kernel);
    try {
      for (let index = 0; index < 12; index += 1) {
        await backend.captureConversationTurn({
          projectId: PROJECT,
          agentId: AGENT,
          sessionId: SESSION,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：继续整理文档，待办第 ${index} 项。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      const first = assemble(backend);
      const compiled = await kernel.sessionContext.compileEpisodeCards({
        projectId: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        now: T0 + 12_000 + SESSION_DEEP_SEGMENT_GAP_MS + 1,
      });
      expect(compiled.created).toHaveLength(1);
      await backend.captureConversationTurn({
        projectId: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        channel: 'terminal',
        speaker: 'owner',
        text: '第二天：那份文档再核对一次。',
        occurredAt: T0 + 12_000 + SESSION_DEEP_SEGMENT_GAP_MS + 2,
      });
      const second = assemble(backend);
      expect(digestText(second)).toContain('情节卡（本段）');
      expect(second.stablePrefix.startsWith(first.stablePrefix)).toBe(false);
      expect(digestText(second).indexOf('情节卡（本段）')).toBeLessThan(digestText(second).indexOf('- owner:'));

      await backend.captureConversationTurn({
        projectId: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        channel: 'terminal',
        speaker: 'owner',
        text: '第 13 轮：继续整理文档。',
        occurredAt: T0 + 12_000 + SESSION_DEEP_SEGMENT_GAP_MS + 3,
      });
      const third = assemble(backend);
      expect(third.stablePrefix.startsWith(second.stablePrefix)).toBe(true);
      expect(digestText(third).startsWith(digestText(second))).toBe(true);
      expect(commonPrefixBytes(second.stablePrefix, third.stablePrefix)).toBe(Buffer.byteLength(second.stablePrefix));
    } finally {
      kernel.close();
    }
  });

  test('a card stays at the head of the digest across five later turns', async () => {
    const dir = makeTempDir('cogmem-cache-card-stable-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const backend = new KernelAgentMemoryBackend(kernel);
    const cardNow = T0 + 3 * 60 * 60_000;
    try {
      for (let index = 0; index < 12; index += 1) {
        await backend.captureConversationTurn({
          projectId: PROJECT,
          agentId: AGENT,
          sessionId: SESSION,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: `第 ${index} 轮：继续整理文档，待办第 ${index} 项。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      const compiled = await kernel.sessionContext.compileEpisodeCards({
        projectId: PROJECT,
        agentId: AGENT,
        sessionId: SESSION,
        now: cardNow,
      });
      expect(compiled.created).toHaveLength(1);

      let previous = assemble(backend);
      const cardIndex = digestText(previous).indexOf('情节卡（本段）');
      expect(cardIndex).toBeGreaterThanOrEqual(0);
      expect(cardIndex).toBeLessThan(digestText(previous).indexOf('- owner:'));

      for (let round = 0; round < 5; round += 1) {
        await backend.captureConversationTurn({
          projectId: PROJECT,
          agentId: AGENT,
          sessionId: SESSION,
          channel: 'terminal',
          speaker: 'owner',
          text: `第 ${12 + round} 轮：继续整理文档。`,
          occurredAt: cardNow + (round + 1) * 1_000,
        });
        const next = assemble(backend);
        expect(next.stablePrefix.startsWith(previous.stablePrefix)).toBe(true);
        expect(digestText(next).startsWith(digestText(previous))).toBe(true);
        expect(digestText(next).indexOf('情节卡（本段）')).toBe(cardIndex);
        previous = next;
      }
    } finally {
      kernel.close();
    }
  });

  test('each new card invalidates the prefix once, then later turns append', async () => {
    const dir = makeTempDir('cogmem-cache-two-cards-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const backend = new KernelAgentMemoryBackend(kernel);
    const nowA = T0 + 12_000 + SESSION_DEEP_SEGMENT_GAP_MS + 1;
    try {
      for (let index = 0; index < 12; index += 1) {
        await backend.captureConversationTurn({
          projectId: PROJECT,
          agentId: AGENT,
          sessionId: SESSION,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: index === 0 ? '决定：第一段由「阿青」负责。' : `第 ${index} 轮：继续整理文档。`,
          occurredAt: T0 + index * 1_000,
        });
      }
      expect((await kernel.sessionContext.compileEpisodeCards({
        projectId: PROJECT, agentId: AGENT, sessionId: SESSION, now: nowA,
      })).created).toHaveLength(1);
      const before = assemble(backend);

      for (let index = 0; index < 10; index += 1) {
        await backend.captureConversationTurn({
          projectId: PROJECT,
          agentId: AGENT,
          sessionId: SESSION,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text: index === 0 ? '决定：第二段由「阿岚」负责。' : `第 ${12 + index} 轮：继续整理文档。`,
          occurredAt: nowA + 1_000 + index * 1_000,
        });
      }
      const nowB = nowA + 20_000 + SESSION_DEEP_SEGMENT_GAP_MS;
      expect((await kernel.sessionContext.compileEpisodeCards({
        projectId: PROJECT, agentId: AGENT, sessionId: SESSION, now: nowB,
      })).created).toHaveLength(1);

      let previous = assemble(backend);
      expect(previous.stablePrefix.startsWith(before.stablePrefix)).toBe(false);
      expect(digestText(previous).match(/情节卡（本段）/gu)).toHaveLength(2);
      expect(digestText(previous).lastIndexOf('情节卡（本段）')).toBeLessThan(digestText(previous).indexOf('- owner:'));

      for (let round = 0; round < 5; round += 1) {
        await backend.captureConversationTurn({
          projectId: PROJECT,
          agentId: AGENT,
          sessionId: SESSION,
          channel: 'terminal',
          speaker: 'owner',
          text: `第 ${22 + round} 轮：继续整理文档。`,
          occurredAt: nowB + (round + 1) * 1_000,
        });
        const next = assemble(backend);
        expect(next.stablePrefix.startsWith(previous.stablePrefix)).toBe(true);
        expect(digestText(next).startsWith(digestText(previous))).toBe(true);
        expect(digestText(next).lastIndexOf('情节卡（本段）')).toBeLessThan(digestText(next).indexOf('- owner:'));
        previous = next;
      }
    } finally {
      kernel.close();
    }
  });
});

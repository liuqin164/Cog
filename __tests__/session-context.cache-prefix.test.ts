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

  test('an episode card created between assemblies appends instead of inserting', async () => {
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
      expect(second.stablePrefix.startsWith(first.stablePrefix)).toBe(true);
      expect(digestText(second).startsWith(digestText(first))).toBe(true);
      expect(digestText(second)).toContain('情节卡（本段）');
      expect(commonPrefixBytes(first.stablePrefix, second.stablePrefix)).toBe(Buffer.byteLength(first.stablePrefix));
    } finally {
      kernel.close();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import {
  assembleSessionContext,
  type SessionContextAssembly,
  type SessionDigest,
} from '../src/session/index.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * The fold whitelist (#255): a constraint stays verbatim, and ordinary process content still folds.
 *
 * The red-team case is the review's own: a prohibition planted at turn 3 must still be in the
 * context, word for word, after 50 turns. The reverse case is the guard against a whitelist so wide
 * that nothing folds: a normal process turn in the same lane must leave the text and stay browsable.
 */

const EMPTY_DIGEST: SessionDigest = { sessionId: 's', entries: [], tail: [], truncated: false };
const CONSTRAINT = '部署窗口是周二凌晨两点，周五绝对不能部署';
const PROCESS = '第 10 轮：继续整理会话上下文，检查第 10 项。';

const scratch = makeTempDir('cogmem-fold-whitelist-');
const dbPath = join(scratch, 'memory.db');
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const PROJECT = 'p-255';
const AGENT = 'cog';
const SESSION = 's-255';

let kernel: MemoryKernel;
let backend: KernelAgentMemoryBackend;

beforeAll(async () => {
  kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  backend = new KernelAgentMemoryBackend(kernel);
  for (let i = 0; i < 50; i += 1) {
    await backend.captureConversationTurn({
      projectId: PROJECT,
      agentId: AGENT,
      sessionId: SESSION,
      channel: 'terminal',
      speaker: 'owner',
      text: i === 2 ? CONSTRAINT : i === 9 ? PROCESS : `第 ${i + 1} 轮：继续整理会话上下文，检查第 ${i + 1} 项。`,
      occurredAt: T0 + i * 1000,
    });
  }
}, 120_000);

afterAll(() => {
  kernel.close();
});

describe('a constraint is never folded (#255)', () => {
  test('the turn-3 prohibition is still in the context, verbatim, after 50 turns', () => {
    const before = backend.sessionDigest({ projectId: PROJECT, agentId: AGENT, sessionId: SESSION, tailTurns: 4 });
    const processEntryId = before.entries.find((entry) => entry.text === PROCESS)!.entryId;

    const assembly = backend.assembleSessionContext({
      projectId: PROJECT,
      agentId: AGENT,
      sessionId: SESSION,
      targetTokens: 70,
      tailTurns: 4,
      pinned: ['system: be terse'],
    });

    // The discriminator is a literal comparison, not a semantic one.
    expect(assembly.text).toContain(CONSTRAINT);
    const digest = assembly.lanes.find((lane) => lane.lane === 'digest')!;
    expect(digest.items.map((item) => item.text)).toEqual([CONSTRAINT]);

    // The reverse discriminator: ordinary process content in the same lane still folds, and its
    // text is one recall away rather than silently gone.
    expect(assembly.text).not.toContain(PROCESS);
    expect(digest.browseIds).toContain(processEntryId);
    const decision = assembly.decisionTrace.find((entry) => entry.lane === 'digest')!;
    expect(decision.action).toBe('trimmed');
    expect(decision.browseIds).toContain(processEntryId);
  });

  test('a correction turn stays verbatim through the episode classifier\'s existing marker', async () => {
    const correctionSession = 's-255-correction';
    const correction = '不对，部署窗口不是周二，是周四。';
    for (let i = 0; i < 30; i += 1) {
      await backend.captureConversationTurn({
        projectId: PROJECT,
        agentId: AGENT,
        sessionId: correctionSession,
        channel: 'terminal',
        speaker: i === 2 ? 'owner' : i % 2 === 0 ? 'owner' : 'agent',
        text: i === 2 ? correction : `第 ${i + 1} 轮：继续整理会话上下文，检查第 ${i + 1} 项。`,
        occurredAt: T0 + i * 1000,
      });
    }
    const assembly = backend.assembleSessionContext({
      projectId: PROJECT,
      agentId: AGENT,
      sessionId: correctionSession,
      targetTokens: 60,
      tailTurns: 4,
      pinned: ['system: be terse'],
    });
    expect(assembly.text).toContain(correction);
  }, 120_000);
});

describe('the assembler enforces the whitelist on every lane', () => {
  test('a protected open loop survives a working-set downgrade; the process item still folds', () => {
    const assembly = assembleSessionContext({
      projectId: 'p',
      agentId: 'a',
      sessionId: 's',
      targetTokens: 12,
      pinned: ['system'],
      workingSet: ['普通过程：已经完成第 3 步，等待下一步。'],
      openLoops: [{ id: 'commitment:1', text: '承诺：周五前回那封邮件', protected: true }],
    }, EMPTY_DIGEST);

    expect(assembly.text).toContain('承诺：周五前回那封邮件');
    expect(assembly.text).not.toContain('普通过程');
    const working = assembly.lanes.find((lane) => lane.lane === 'working_set')!;
    expect(working.items.map((item) => item.id)).toEqual(['commitment:1']);
    expect(working.browseIds).toContain('working:0');
    expect(assembly.decisionTrace).toContainEqual(expect.objectContaining({
      lane: 'working_set',
      action: 'trimmed',
      omittedItems: 1,
    }));
  });

  test('a protected id stays in the digest even when the protected text alone exceeds the target', () => {
    const digest: SessionDigest = {
      sessionId: 's',
      entries: [{
        entryId: 'e-correction',
        kind: 'turn',
        sessionId: 's',
        occurredAt: 0,
        speaker: 'owner',
        text: '不对，是周四。',
        sourceRefs: ['evt-1'],
        anchor: false,
      }],
      tail: [],
      truncated: false,
    };
    const assembly = assembleSessionContext({
      projectId: 'p',
      agentId: 'a',
      sessionId: 's',
      targetTokens: 2,
      protectedIds: ['e-correction'],
    }, digest);
    expect(assembly.text).toContain('不对，是周四。');
    expect(assembly.lanes.find((lane) => lane.lane === 'digest')!.status).toBe('included');
    expect(assembly.usedTokens).toBeGreaterThan(2);
  });

  test('a lane with no protected item still becomes a browse-only pointer', () => {
    const assembly: SessionContextAssembly = assembleSessionContext({
      projectId: 'p',
      agentId: 'a',
      sessionId: 's',
      targetTokens: 2,
      recall: [{ id: 'recall:1', text: '普通召回内容，用来把预算挤过目标带宽。' }],
    }, EMPTY_DIGEST);
    const recall = assembly.lanes.find((lane) => lane.lane === 'recall')!;
    expect(recall.status).toBe('downgraded');
    expect(recall.browseIds).toEqual(['recall:1']);
  });
});

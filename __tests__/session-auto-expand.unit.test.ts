import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend, type AgentRecallItem } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import {
  assembleSessionContext,
  type SessionContextAssembly,
  type SessionDigest,
} from '../src/session/index.js';
import type { SessionContextItem } from '../src/session/index.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * Deterministic auto-expansion (#253, roadmap B3).
 *
 * The discriminator is a literal comparison: a stub named by the newest text is expanded into
 * `working_set` word for word, an unrelated message expands nothing, and the expansion never costs
 * a constraint or an open loop its place. This is a cost optimisation, not a correctness fix: the
 * stub is still browsable either way.
 */

const EMPTY_DIGEST: SessionDigest = { sessionId: 's', entries: [], tail: [], truncated: false };
const ORIGINAL = '团队把「上传失败」的重试上限定为 12,500 次，由「小明」负责。';
const STUB = 'User: 团队把「上传失败」的重试上限定为 12,500 次，由「小明」负责。\nAgent: 记下了。';

function stub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-stub-1',
    text: STUB,
    originalText: ORIGINAL,
    anchorEvent: 'evt-stub-1',
    sourceLocator: 'cogmem memory show --event evt-stub-1 --before 2 --after 2 --json',
    sourceRefs: ['evt-stub-1'],
    ...overrides,
  };
}

function assemble(input: Parameters<typeof assembleSessionContext>[0]): SessionContextAssembly {
  return assembleSessionContext({ projectId: 'p', agentId: 'a', sessionId: 's', targetTokens: 4000, ...input }, EMPTY_DIGEST);
}

describe('a named stub is expanded into working_set (#253)', () => {
  test('an entity word from the stub expands the ledger text verbatim', () => {
    const assembly = assemble({ recall: [stub()], recentText: ['上传失败的重试上限是多少？'] });
    const working = assembly.lanes.find((lane) => lane.lane === 'working_set')!;
    expect(working.items.map((item) => item.text)).toEqual([ORIGINAL]);
    expect(assembly.text).toContain(ORIGINAL);
    expect(assembly.autoExpanded).toEqual(['evt-stub-1']);
    // The stub stays in the recall lane: the expansion is a projection, not a move.
    expect(assembly.lanes.find((lane) => lane.lane === 'recall')!.items.map((item) => item.text)).toEqual([STUB]);
  });

  test('the key alone is enough, and normalization ignores case and spacing', () => {
    const assembly = assemble({ recall: [stub()], recentText: ['please read EVT-STUB-1'] });
    expect(assembly.autoExpanded).toEqual(['evt-stub-1']);
    expect(assembly.text).toContain(ORIGINAL);
  });

  test('an unrelated message expands nothing, even when a word grazes the stub', () => {
    const assembly = assemble({ recall: [stub()], recentText: ['今天午饭吃什么？上传的文件稍后再说。'] });
    expect(assembly.autoExpanded).toEqual([]);
    const working = assembly.lanes.find((lane) => lane.lane === 'working_set')!;
    expect(working.items).toEqual([]);
  });

  test('an item whose text already is the ledger row is not a stub and is not expanded', () => {
    const assembly = assemble({
      recall: [stub({ text: ORIGINAL })],
      recentText: ['上传失败怎么处理？'],
    });
    expect(assembly.autoExpanded).toEqual([]);
    expect(assembly.text.split(ORIGINAL).length - 1).toBe(1);
  });

  test('an original already rendered in another lane is not duplicated', () => {
    const digest: SessionDigest = {
      sessionId: 's',
      entries: [{
        entryId: 'digest:evt-1',
        kind: 'turn',
        sessionId: 's',
        occurredAt: 0,
        speaker: 'owner',
        text: ORIGINAL,
        sourceRefs: ['evt-1'],
        anchor: true,
      }],
      tail: [],
      truncated: false,
    };
    const assembly = assembleSessionContext(
      { projectId: 'p', agentId: 'a', sessionId: 's', targetTokens: 4000, recall: [stub()], recentText: ['上传失败怎么处理？'] },
      digest,
    );
    expect(assembly.autoExpanded).toEqual([]);
  });

  test('a protected stub is not expanded: the constraint is already verbatim (#255)', () => {
    const assembly = assemble({
      recall: [stub({ protected: true })],
      recentText: ['上传失败怎么处理？'],
    });
    expect(assembly.autoExpanded).toEqual([]);
  });
});

describe('an expansion is budgeted like any working_set item, and gives way first', () => {
  test('over budget the expansion is trimmed before an open loop leaves the lane', () => {
    const assembly = assemble({
      targetTokens: 12,
      workingSet: ['普通过程：已经完成第 3 步。'],
      openLoops: [{ id: 'commitment:1', text: '承诺：周五前回那封邮件', protected: true }],
      recall: [stub()],
      recentText: ['上传失败怎么处理？'],
    });
    expect(assembly.text).toContain('承诺：周五前回那封邮件');
    expect(assembly.text).not.toContain(ORIGINAL);
    expect(assembly.autoExpanded).toEqual([]);
    expect(assembly.decisionTrace).toContainEqual(expect.objectContaining({
      lane: 'working_set',
      action: 'trimmed',
    }));
    expect(assembly.decisionTrace.find((entry) => entry.lane === 'working_set')!.browseIds)
      .toContain('evt-stub-1');
  });

  test('the trace records the expansion object and count when it fits', () => {
    const assembly = assemble({ recall: [stub()], recentText: ['上传失败怎么处理？'] });
    expect(assembly.autoExpanded.length).toBe(1);
    expect(assembly.autoExpanded[0]).toBe('evt-stub-1');
  });
});

test('a profile summary expands into the ledger original it stands for', async () => {
  const ORIGINAL_TEXT = '他说那句「过阵子再说」先不动，我听他的。';
  const KEY = '发布计划';
  const VALUE = '「先别动发布」';
  const SUMMARY = `${KEY}: ${VALUE}`;
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-atlas-expand-'), 'memory.db') });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    const source = kernel.recordRawEvent({
      projectId: 'p',
      sessionId: 's',
      threadId: 's',
      role: 'user',
      content: ORIGINAL_TEXT,
    });
    const eventId = source.eventId;
    kernel.eventStore.append({
      streamId: `profile-entry:${KEY}`,
      streamType: 'system',
      eventType: 'PROFILE_ENTRY_COMPILED',
      projectId: 'p',
      sourceId: 'profile',
      occurredAt: Date.now(),
      payload: {
        entryId: 'profile:发布计划',
        projectId: 'p',
        ledger: 'facts',
        key: KEY,
        value: VALUE,
        sourceRefs: [{ eventId, eventType: 'RAW_EVENT_RECORDED', role: 'user' }],
        recordedAt: Date.now(),
        compiledAt: Date.now(),
        version: 1,
      },
    });

    const recalled = backend.recall({ agentId: 'a', projectId: 'p', query: '先别动发布', limit: 5 });
    const profile = recalled.items.find((item): item is AgentRecallItem => item.text === SUMMARY);
    expect(profile).toBeDefined();
    expect(profile!.sourceContext?.event?.text).toBe(ORIGINAL_TEXT);

    const toContextItem = (item: AgentRecallItem): SessionContextItem => ({
      id: item.sourceAnchor?.eventId ?? item.id,
      text: item.text,
      originalText: item.sourceContext?.event?.text,
      sourceRefs: [item.sourceAnchor?.eventId ?? item.id],
      anchorEvent: item.sourceAnchor?.eventId,
      sourceLocator: `read mem:${item.sourceAnchor?.eventId}`,
    });
    const assembly = assemble({
      recall: recalled.items.map(toContextItem),
      recentText: ['先别动发布'],
    });

    expect(assembly.autoExpanded.length).toBeGreaterThan(0);
    expect(assembly.lanes.find((lane) => lane.lane === 'working_set')!.items.map((item) => item.text))
      .toContain(ORIGINAL_TEXT);
    expect(assembly.text).toContain(ORIGINAL_TEXT);
  } finally {
    kernel.close();
  }
});

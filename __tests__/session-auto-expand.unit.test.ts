import { describe, expect, test } from 'bun:test';

import {
  assembleSessionContext,
  type SessionContextAssembly,
  type SessionDigest,
} from '../src/session/index.js';

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

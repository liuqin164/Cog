/**
 * #249 A5: the shell's request is the kernel's six-lane projection, and both faces report it.
 *
 * These are the discriminators the swap had not been asked for yet: the frozen lane order, a
 * downgraded lane's browse-only stub with its text still one recall away, `/context` agreeing with
 * the `context_assembled` trace, and the ruling on #249 (comment 6910745618) as a standing check —
 * a turn pushed out of the verbatim tail is carried verbatim by the digest, never silently dropped.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_CONTEXT_LANES, type SessionContextLaneName, type SessionContextLaneStatus } from 'cogmem';
import type { LaneAssemblyView } from '../src/state/session-lanes.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

/** One lane's rendered bytes: its `[lane]` header up to the next lane header. */
const laneBlock = (text: string, lane: string): string => {
  const start = text.indexOf(`[${lane}]`);
  if (start < 0) return '';
  const rest = text.slice(start + lane.length + 2);
  const next = rest.search(/\n\[[a-z_]+\]/);
  return next < 0 ? rest : rest.slice(0, next);
};

const LANE_LABELS: Record<SessionContextLaneName, string> = {
  pinned: '钉死',
  profile: '画像',
  digest: '摘要',
  working_set: '工作集',
  recall: '召回',
  tail: '尾巴',
};

const STATUS_WORDS: Record<SessionContextLaneStatus, string> = {
  included: '在场',
  downgraded: '已降级为指针',
  empty: '空',
};

describe('the six-lane assembly (#249 A5)', () => {
  test('lanes render in the frozen pinned → profile → digest → working_set → recall → tail order', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('lanes-order-'), provider, { dream: NO_DREAM, tailTurns: 2 });
    await shell.start();
    try {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'seed-1',
        userText: '部署窗口是周二凌晨两点，周五绝对不能部署',
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      await shell.submit('第一轮：部署窗口是什么时候');
      await shell.submit('第二轮：继续');
      await shell.submit('第三轮：部署窗口还是周二吗');

      const view = shell.currentStatus().contextLanes!;
      expect(view.lanes.map((lane) => lane.lane)).toEqual([...SESSION_CONTEXT_LANES]);

      // The provider sees the non-stable lanes in that same order: the kernel's render order, not a
      // plugin's insertion order.
      const last = asText(provider.calls.at(-1)!.messages);
      const positions = (['digest', 'working_set', 'recall', 'tail'] as const).map((lane) => last.indexOf(`[${lane}]`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((left, right) => left - right)).toEqual(positions);
      // The stable prefix is the pinned lane verbatim, so the provider's cache prefix starts there.
      expect(provider.calls.at(-1)!.systemPrompt.startsWith(shell.systemPromptSections().pinned)).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('over budget, a lane leaves a browse-only stub and its text is still recallable', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('lanes-budget-'), provider, { dream: NO_DREAM, contextSweetSpot: 10 });
    await shell.start();
    try {
      await shell.submit('第一轮：回滚逻辑要看旧版本');
      await shell.submit('第二轮：部署窗口是周二');
      await shell.submit('第三轮：继续');

      const view = shell.currentStatus().contextLanes!;
      const tail = view.lanes.find((lane) => lane.lane === 'tail')!;
      expect(tail.status).toBe('downgraded');
      expect(tail.browseIds.length).toBeGreaterThan(0);
      const covered = Math.min(20, tail.browseIds.length);
      expect(asText(provider.calls.at(-1)!.messages)).toContain(`[tail: browse-only, ${tail.browseIds.length} item(s); keys: newest ${covered} of ${tail.browseIds.length}]`);
      expect(view.decisionTrace.some((decision) => decision.lane === 'tail' && decision.action === 'downgraded' && decision.browseIds.length > 0)).toBe(true);

      // The pointer is honest: the ids the lane left behind resolve to the ledger's exact text.
      const page = shell.backend.recallSession({
        projectId: shell.config.projectId,
        agentId: shell.config.agentId,
        sessionId: shell.config.sessionId,
        mode: 'time',
        limit: 50,
      });
      const recovered = page.items.filter((item) => tail.browseIds.includes(item.eventId)).map((item) => item.text);
      expect(recovered).toContain('第二轮：部署窗口是周二');
      expect(recovered).toContain('收到二。');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a downgraded stub carries a key that read mem: resolves to the original text (#276)', async () => {
    const seed = '部署窗口定在周二凌晨两点。';
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('lanes-stub-keys-'), provider, { dream: NO_DREAM, contextSweetSpot: 10 });
    await shell.start();
    try {
      const recorded = await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'seed-276',
        userText: seed,
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });
      const key = recorded.rawEventIds[0]!;
      await shell.submit('部署窗口是什么时候');

      const recall = shell.currentStatus().contextLanes!.lanes.find((lane) => lane.lane === 'recall')!;
      expect(recall.status).toBe('downgraded');
      expect(recall.browseIds).toContain(key);
      expect(asText(provider.calls.at(-1)!.messages)).toContain(`anchorEvent=${key}`);

      const read = await shell.host.tools.invoke('read', { toolCallId: 'c1', input: { path: `mem:${key}` } }, { runId: 'r' });
      expect(read.isError).toBe(false);
      expect(read.output).toBe(seed);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a long session\'s digest pointer reaches the newest evicted turn, not the oldest (#317)', async () => {
    const provider = new ScriptedProvider([{ text: '收到。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('lanes-newest-key-'), provider, { dream: NO_DREAM, contextSweetSpot: 300 });
    await shell.start();
    try {
      const texts: string[] = [];
      for (let index = 0; index < 71; index += 1) {
        const text = `第 ${index} 轮：继续整理会话上下文，检查第 ${index} 项。`;
        texts.push(text);
        await shell.backend.captureConversationTurn({
          projectId: shell.config.projectId,
          agentId: shell.config.agentId,
          sessionId: shell.config.sessionId,
          channel: 'terminal',
          speaker: index % 2 === 0 ? 'owner' : 'agent',
          text,
          occurredAt: 1_700_000_000_000 + index * 1000,
        });
      }
      await shell.submit('第 72 轮：继续');

      const request = asText(provider.calls.at(-1)!.messages);
      const header = request.indexOf('[digest: browse-only');
      expect(header).toBeGreaterThanOrEqual(0);
      const rest = request.slice(header);
      const nextLane = rest.indexOf('\n[');
      const block = nextLane < 0 ? rest : rest.slice(0, nextLane);
      const keys = [...block.matchAll(/anchorEvent=(evt-\S+)/g)].map((match) => match[1]!);
      expect(keys.length).toBe(20);
      const newest = keys.at(-1)!;

      const read = await shell.host.tools.invoke('read', { toolCallId: 'c1', input: { path: `mem:${newest}` } }, { runId: 'r' });
      expect(read.isError).toBe(false);
      expect(read.output).toBe(texts[62]);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('/context and the context_assembled trace report the same composition', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('lanes-faces-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('第一轮：部署窗口是周二');
      await shell.submit('第二轮：继续');

      const traced = shell.trace.read().filter((record) => record.kind === 'context_assembled').at(-1)!.lanes as LaneAssemblyView;
      const view = shell.currentStatus().contextLanes!;
      expect(view).toEqual(traced);

      const text = (await shell.runCommand('context')).text;
      expect(text).toContain(`目标带宽 ${view.targetTokens} token`);
      let cursor = -1;
      for (const lane of view.lanes) {
        const line = `${LANE_LABELS[lane.lane]}：${lane.items} 条，约 ${lane.tokens} token，${STATUS_WORDS[lane.status]}`;
        const at = text.indexOf(line);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a turn pushed out of the verbatim tail is carried verbatim by the digest (ruling 6910745618)', async () => {
    const provider = new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }, { text: '收到三。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('lanes-ruling-'), provider, { dream: NO_DREAM, tailTurns: 2 });
    await shell.start();
    try {
      await shell.submit('第一轮：回滚逻辑要看旧版本');
      await shell.submit('第二轮：部署窗口是周二');
      await shell.submit('第三轮：继续');

      const third = asText(provider.calls[2].messages);
      expect(laneBlock(third, 'tail')).not.toContain('第一轮：回滚逻辑要看旧版本');
      expect(laneBlock(third, 'digest')).toContain('第一轮：回滚逻辑要看旧版本');
      expect(laneBlock(third, 'digest')).toContain('收到一。');

      const digest = shell.currentStatus().contextLanes!.lanes.find((lane) => lane.lane === 'digest')!;
      expect(digest.status).toBe('included');
      expect(digest.items).toBeGreaterThan(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

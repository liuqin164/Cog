/**
 * #268: the projection actions a turn took are counted on `context_assembled`, and `/context`
 * reads the same numbers. A round with a fold and a `mem:` drill must trace exactly those actions;
 * a zero is reported as zero rather than omitted.
 */
import { describe, expect, test } from 'bun:test';

import type { LaneAssemblyView, ContextMetrics } from '../src/state/session-lanes.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const EVENT_TEXT = '账本原文：部署窗口是周二凌晨两点。';

describe('context projection metrics (#268)', () => {
  test('a fold and a mem: drill are counted on the trace, and /context shows the same numbers', async () => {
    let eventId = '';
    const provider = new ScriptedProvider([
      () => ({
        text: '',
        toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: `mem:${eventId}` } }],
      }),
      { text: '读完了。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir(), provider, { dream: NO_DREAM, contextSweetSpot: 10 });
    await shell.start();
    try {
      eventId = shell.kernel.recordRawEvent({
        projectId: shell.config.projectId,
        threadId: 'drill',
        role: 'user',
        content: EVENT_TEXT,
      }).eventId;

      const summary = await shell.submit('第一轮：读一下账本原文');
      expect(summary!.toolResults[0]!.isError).toBe(false);
      expect(summary!.toolResults[0]!.output).toBe(EVENT_TEXT);

      const traces = shell.trace.read().filter((record) => record.kind === 'context_assembled');
      const traced = traces.at(-1)!;
      const metrics = traced.metrics as ContextMetrics;
      const lanes = traced.lanes as LaneAssemblyView;
      // Every count is present, even at zero.
      expect(Object.keys(metrics).sort()).toEqual(['autoExpands', 'drills', 'folds']);
      // Folds are the assembly's own decision trace, action for action.
      expect(metrics.folds).toBe(lanes.decisionTrace.length);
      expect(metrics.folds).toBeGreaterThan(0);
      expect(metrics.drills).toBe(1);
      // #253 is still in flight; this is the reserved field reading a real zero.
      expect(metrics.autoExpands).toBe(0);

      const text = (await shell.runCommand('context')).text;
      expect(text).toContain(`本轮折叠 ${metrics.folds} 次`);
      expect(text).toContain('下钻 1 次');
      expect(text).toContain('自动展开 0 次');
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

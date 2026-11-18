/**
 * Deterministic auto-expansion at the shell (#253, roadmap B3).
 *
 * A recalled stub carries a drill-down key and a ledger original the model does not see. When the
 * request's own words name the stub, the shell expands that original into `working_set` before the
 * provider call, so the drill-down round trip is not needed. The match is deterministic and the
 * count lands in the `context_assembled` trace.
 */
import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const ORIGINAL = '团队把「上传失败」的重试上限定为 12,500 次，由「小明」负责。';

const asText = (messages: Array<{ content: unknown }> | undefined) => (messages ?? []).map((message) => String(message.content)).join('\n');

/** One lane's rendered bytes: its `[lane]` header up to the next lane header. */
const laneBlock = (text: string, lane: string): string => {
  const start = text.indexOf(`[${lane}]`);
  if (start < 0) return '';
  const rest = text.slice(start + lane.length + 2);
  const next = rest.search(/\n\[[a-z_]+\]/);
  return next < 0 ? rest : rest.slice(0, next);
};

/**
 * A memory whose source turn is outside the shell's session: the original is not already in the
 * tail or the digest, so the expansion is the only way it reaches the request.
 */
async function seedOutsideSession(shell: ReturnType<typeof makeShell>): Promise<void> {
  await shell.backend.rememberTurnWithResult({
    agentId: shell.config.agentId,
    projectId: shell.config.projectId,
    sessionId: 'seeded-elsewhere',
    turnId: 'seed-auto-expand',
    userText: ORIGINAL,
    assistantText: '记下了。',
    ingestMode: 'immediate_compile',
  });
}

describe('a named stub is expanded before the provider request (#253)', () => {
  test('the entity word puts the ledger original into working_set, verbatim', async () => {
    const provider = new ScriptedProvider([{ text: '重试上限是 12,500 次。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('auto-expand-hit-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await seedOutsideSession(shell);
      await shell.submit('上传失败的重试上限是多少？');

      const request = asText(provider.calls[0]!.messages);
      expect(laneBlock(request, 'working_set')).toContain(ORIGINAL);
      // The stub itself is still in the recall lane with its key; expansion is a projection.
      expect(request).toContain('<COGMEM_RECALL_CONTEXT');
      expect(request).toContain('anchorEvent=');

      const traced = shell.trace.read().filter((record) => record.kind === 'context_assembled').at(-1)!;
      const lanes = traced.lanes as { autoExpanded: string[] };
      expect(lanes.autoExpanded).toHaveLength(1);
      expect(shell.currentStatus().contextLanes!.autoExpanded).toEqual(lanes.autoExpanded);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an ordinary message with the stub present expands nothing', async () => {
    const provider = new ScriptedProvider([{ text: '好的。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('auto-expand-miss-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await seedOutsideSession(shell);
      await shell.submit('把那个上限再说一遍');

      const request = asText(provider.calls[0]!.messages);
      expect(request).toContain('<COGMEM_RECALL_CONTEXT');
      expect(laneBlock(request, 'working_set')).not.toContain(ORIGINAL);
      const traced = shell.trace.read().filter((record) => record.kind === 'context_assembled').at(-1)!;
      expect((traced.lanes as { autoExpanded: string[] }).autoExpanded).toEqual([]);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the model output is part of the trigger on the next request', async () => {
    const provider = new ScriptedProvider([
      { text: '我先查「上传失败」的处理。', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'echo hi' } }] },
      { text: '好的。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('auto-expand-assistant-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await seedOutsideSession(shell);
      await shell.submit('把那个重试上限的事再说一遍');
      expect(provider.calls.length).toBeGreaterThanOrEqual(2);

      // The owner's message does not name the stub; the model's own output does.
      expect(laneBlock(asText(provider.calls[0]!.messages), 'working_set')).not.toContain(ORIGINAL);
      expect(laneBlock(asText(provider.calls[1]!.messages), 'working_set')).toContain(ORIGINAL);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

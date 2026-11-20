import { describe, expect, test } from 'bun:test';
import { laneReportLines } from '../src/state/session-lanes.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };

describe('the profile lane compiles incrementally (#329)', () => {
  test('owner facts reach the next /context without a command', async () => {
    const provider = new ScriptedProvider([
      { text: '记下了。', toolCalls: [] },
      { text: '记下了。', toolCalls: [] },
      { text: '记下了。', toolCalls: [] },
      { text: '在。', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('profile-lane-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('我住在东京都世田谷区三丁目十二号。');
      await shell.submit('我每天早上七点起床。');
      await shell.submit('我对花生过敏，回答请简短一点。');
      await shell.tick(Date.now());
      await shell.submit('继续。');

      const projectId = shell.config.projectId;
      const entries = shell.kernel.profile.entries({ projectId });
      expect(entries.length).toBeGreaterThanOrEqual(3);
      const context = (await shell.runCommand('context')).text;
      expect(context).toContain('画像：');
      expect(context).not.toContain('画像：0 条');

      const allergy = entries.find((entry) => entry.key.includes('allergic_to'))!;
      const evidence = allergy.sourceRefs[0]!.eventId!;
      const read = await shell.host.tools.invoke('read', { toolCallId: 'evidence', input: { path: `mem:${evidence}` } }, { runId: 'evidence' });
      expect(String(read.output)).toContain('花生');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('fifty idle ticks do not recompile the profile', async () => {
    const provider = new ScriptedProvider([{ text: '记下了。', toolCalls: [] }, { text: '在。', toolCalls: [] }]);
    const shell = makeShell(makeTempDir('profile-ticks-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      await shell.submit('我对花生过敏。');
      const base = Date.now();
      await shell.tick(base);
      const compiles = (): number => shell.trace.read().filter((record) => record.kind === 'profile_compiled').length;
      for (let index = 1; index <= 50; index += 1) await shell.tick(base + index * 30_000);
      const afterFirstFifty = compiles();
      for (let index = 51; index <= 100; index += 1) await shell.tick(base + index * 30_000);
      expect(compiles()).toBe(afterFirstFifty);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an empty profile lane says why it is empty', () => {
    const line = laneReportLines({
      targetTokens: 100,
      usedTokens: 0,
      lanes: [{ lane: 'profile', status: 'empty', tokens: 0, items: 0, browseIds: [] }],
      decisionTrace: [],
      autoExpanded: [],
    }).find((entry) => entry.startsWith('画像：'))!;
    expect(line).toContain('尚无画像条目：账本里还没有可编译的证据');
  });
});

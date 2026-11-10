import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

describe('shell wiring', () => {
  test('transitions reach the plugin bus, the companion plugins are services, and WAKING stores the time block', async () => {
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'x', toolCalls: [] }]));
    const transitions: Array<{ from: string; to: string; trigger: string }> = [];
    shell.host.bus.on('companion_transition', (record: { from: string; to: string; trigger: string }) => {
      transitions.push(record);
    });
    await shell.start();
    try {
      expect(transitions.map((record) => `${record.from}->${record.to}:${record.trigger}`)).toEqual([
        'DORMANT->WAKING:boot',
        'WAKING->IDLE:context_injected',
      ]);
      for (const service of ['clock', 'model', 'cage', 'builtinTools', 'capture', 'recall', 'dream', 'emergence']) {
        expect(shell.host.hasService(service)).toBe(true);
      }
      expect(shell.machine.runtime.lastTimeContext).toContain('<time-context>');
      expect(shell.systemPrompt()).toContain('<time-context>');
    } finally {
      await shell.stop();
    }
  });

  test('a restart keeps the day and the last topic, and the next turn recalls the earlier one', async () => {
    const dir = makeTempDir();
    const first = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]));
    await first.start();
    await first.backend.rememberTurnWithResult({
      agentId: first.config.agentId,
      projectId: first.config.projectId,
      sessionId: first.config.sessionId,
      turnId: 'continuity-seed',
      userText: '我常去街角那家蓝色遮阳篷的面包店买可颂',
      assistantText: '记下了：蓝色遮阳篷的面包店。',
      ingestMode: 'immediate_compile',
    });
    await first.submit('记一下：蓝色遮阳篷那家面包店');
    expect(first.machine.runtime.lastInteractionText).toContain('蓝色遮阳篷');
    await first.stop();
    expect(first.state).toBe('DORMANT');

    // A new process on the same data dir and database: this is what "会话恢复" is for a resident shell.
    const provider = new ScriptedProvider([{ text: '就是你上次说的那家。', toolCalls: [] }]);
    const second = makeShell(dir, provider);
    await second.start();
    try {
      expect(second.state).toBe('IDLE');
      // The runtime half of continuity survives: the last topic is still there for the emergence check.
      expect(second.machine.runtime.lastInteractionText).toContain('蓝色遮阳篷');
      // A clean restart boots; it is not a kill recovery.
      expect(second.trace.read().some((record) => record.kind === 'recovery')).toBe(false);

      await second.submit('我刚才说的那家店有什么特征？');
      const firstPrompt = provider.calls[0].messages.map((message) => message.content).join('\n');
      // The memory half: recall from the same database brings the earlier turn back into the prompt.
      expect(firstPrompt).toContain('<recall-context>');
      expect(firstPrompt).toContain('蓝色遮阳篷');
      expect(second.state).toBe('IDLE');
      expect(second.trace.read().some((record) => record.kind === 'illegal_transition')).toBe(false);
    } finally {
      await second.stop();
    }
  }, 30_000);
});

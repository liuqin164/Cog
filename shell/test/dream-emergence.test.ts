import { describe, expect, test } from 'bun:test';
import { EmergenceService } from '../src/plugins/emergence.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

/** The dream window is wide open here so a test can call `runDream` at any wall-clock hour. */
const DREAM_ALL_DAY = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 24 };

function makeDreamShell(dir: string, provider: ScriptedProvider) {
  return makeShell(dir, provider, { dream: DREAM_ALL_DAY });
}

describe('night integration (DREAMING)', () => {
  test('the product is written as the companion agent with full sourceRefs, once per day', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeDreamShell(dir, provider);
    await shell.start();
    try {
      const clock = shell.host.getService<{ dreamTargetDate(at?: number): string }>('clock');
      const date = clock.dreamTargetDate();
      const dayThread = `companion-day:${date}`;
      const seed = await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        threadId: dayThread,
        turnId: 'seed-turn-1',
        userText: '今天修好了花园的栅栏',
        assistantText: '记下了：花园的栅栏今天修好了。',
        ingestMode: 'immediate_compile',
      });
      await shell.runDream(Date.now());
      const dreamEvents = shell.kernel
        .getThreadEvents(`companion-dream:${date}`, { projectId: shell.config.projectId, limit: 50 })
        .filter((event) => (event.payload as { metadata?: { kind?: string } }).metadata?.kind === 'dream-integration');
      expect(dreamEvents).toHaveLength(1);
      const metadata = (dreamEvents[0].payload as { metadata?: Record<string, unknown> }).metadata!;
      expect(metadata.sourceAgent).toBe(shell.config.agentId);
      expect(Array.isArray(metadata.sourceRefs)).toBe(true);
      expect((metadata.sourceRefs as unknown[]).length).toBeGreaterThanOrEqual(2);
      expect(metadata.sourceEventIds).toContain(seed.rawEventIds[0]);
      const summary = (dreamEvents[0].payload as { text?: string }).text ?? '';
      expect(summary).not.toContain('今天修好了花园的栅栏');
      expect(summary).not.toContain('花园的栅栏今天修好了');
      expect(summary).toContain(String(metadata.sourceEventIds!.length));
      expect(summary).toContain(seed.rawEventIds[0]!);
      // The product is a deterministic rule over the day's ledger, so its provenance must say
      // rule extraction. `llm_inference` here was the audit lie #231 exists to stop.
      const integrated = shell.trace.read().find((record) => record.kind === 'dream_integrated');
      expect(integrated?.dreamEventId).toBeTruthy();
      expect(shell.state).toBe('IDLE');
      expect(shell.machine.runtime.lastDreamDate).toBe(date);
      expect(shell.machine.wakeIntents.some((intent) => intent.reason === 'morning_after_dream' && !intent.consumedAt)).toBe(true);

      // Idempotence at the tick level: a second tick on the same day dreams nothing.
      await shell.tick(Date.now());
      const afterSecond = shell.kernel
        .getThreadEvents(`companion-dream:${date}`, { projectId: shell.config.projectId, limit: 50 })
        .filter((event) => (event.payload as { metadata?: { kind?: string } }).metadata?.kind === 'dream-integration');
      expect(afterSecond).toHaveLength(1);
    } finally {
      await shell.stop();
    }
  });
});

describe('dream and run do not collide', () => {
  test('a message arriving during the night integration wakes the shell without an illegal transition', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '我醒着，先回你。', toolCalls: [] }]);
    const shell = makeDreamShell(dir, provider);
    await shell.start();
    try {
      // The integration is replaced with one that takes a message mid-flight: the state machine must
      // survive the DREAMING -> WAKING -> IDLE -> RUNNING -> IDLE move and the dream must not then
      // dispatch dream_complete from IDLE.
      (shell as unknown as { dream: { integrate: (...args: unknown[]) => Promise<unknown> } }).dream = {
        integrate: async (localDate: unknown) => {
          await shell.submit('做梦时来消息了');
          return { localDate, eventCount: 0, sourceRefs: [], summary: 'partial', kernelNightRan: false };
        },
      };
      await shell.runDream(Date.now());
      expect(shell.state).toBe('IDLE');
      expect(shell.trace.read().some((record) => record.kind === 'illegal_transition')).toBe(false);
      expect(shell.trace.read().some((record) => record.kind === 'dream_finished_after_wake')).toBe(true);
    } finally {
      await shell.stop();
    }
  });
});

describe('emergence decision point (kernel surfacing)', () => {
  test('a due promise is a candidate with grade/occasion/modulation steps; a life-marked one is withheld', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'unused', toolCalls: [] }]);
    const shell = makeDreamShell(dir, provider);
    await shell.start();
    try {
      const at = Date.now();
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'low-1',
        userText: '我明天把蓝色遮阳篷面包店的地址发你',
        assistantText: '记下了：明天发面包店地址。',
        timestamp: at,
        ingestMode: 'immediate_compile',
      });
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'high-1',
        userText: '我明天把病历发你',
        assistantText: '记下了：明天发病历。',
        timestamp: at + 1,
        ingestMode: 'immediate_compile',
      });
      shell.kernel.commitments.compile({ projectId: shell.config.projectId, now: at + 2_000 });
      const due = shell.kernel.commitments.list({ projectId: shell.config.projectId, now: at + 2_000 })[0]!.dueAt;
      const emergence = new EmergenceService(shell.backend, { agentId: shell.config.agentId, projectId: shell.config.projectId, trace: shell.trace });
      const decision = emergence.decide(due);
      const low = decision.candidates.find((candidate) => candidate.text.includes('面包店'));
      expect(low).toBeDefined();
      expect(low!.source).toBe('commitment');
      expect(low!.sensitivity).toBe('daily');
      expect(low!.decisionTrace.steps.find((step) => step.rule === 'sensitivity')).toBeDefined();
      expect(low!.decisionTrace.steps.find((step) => step.rule === 'occasion')).toBeDefined();
      expect(low!.decisionTrace.steps.find((step) => step.rule === 'modulation')).toBeDefined();

      expect(decision.candidates.some((candidate) => candidate.text.includes('病历'))).toBe(false);
      const high = decision.withheld.find((item) => item.reason.includes('sensitivity=high'));
      expect(high).toBeDefined();
      expect(high!.sensitivity).toBe('high');
      expect(high!.reason).toContain('channel=withheld:policy');

      // No user text is needed: with nothing due the same query is empty, not a guess.
      const none = emergence.decide(at);
      expect(none.candidates).toHaveLength(0);

      // The decision is deterministic; the model was never called to manufacture a candidate.
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  });
});

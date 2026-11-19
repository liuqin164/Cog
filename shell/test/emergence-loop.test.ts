import { describe, expect, test } from 'bun:test';
import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const BASE = Date.UTC(2026, 10, 15, 12, 0, 0);
/** 2026-01-02 04:00 UTC = Jan 1 23:00 in New York; 05:10 UTC = Jan 2 00:10 there. Tokyo is Jan 2 at both. */
const NY_LATE = Date.UTC(2026, 0, 2, 4, 0, 0);
const NY_AFTER = Date.UTC(2026, 0, 2, 5, 10, 0);

function emerge(shell: CompanionShell, id: string): void {
  (shell as unknown as { emergence: unknown }).emergence = {
    decide: () => ({
      candidates: [{ id, text: `autonomous thought ${id}`, reason: 'test', sourceRefs: [{ eventId: id }] }],
      suppressed: [],
    }),
  };
}

/**
 * #229: the tick recalled the sentence the user had just said, got that same turn back, and ran it
 * again as if it were new user input. On an empty database there is nothing else to surface, so ten
 * ticks after one sentence must start no run and add no user turn.
 */
describe('emergence does not consume its own query (#229)', () => {
  test('one sentence and ten ticks add no model run and no role=user event', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '好的。', toolCalls: [] }]);
    // 12:00 UTC is 21:00 Asia/Tokyo, outside the 2–5 dream window in the shell's UTC test config.
    const shell = makeShell(dir, provider, {}, { now: () => BASE });
    await shell.start();
    try {
      await shell.submit('我昨天在蓝色遮阳篷那家店买了可颂');
      const threadId = `companion-day:${shell.host.getService<{ localDate(at?: number): string }>('clock').localDate()}`;
      const userEvents = () => shell.kernel
        .getThreadEvents(threadId, { projectId: shell.config.projectId, limit: 500 })
        .filter((event) => event.role === 'user').length;
      const runs = provider.calls.length;
      const userTurns = userEvents();

      for (let tick = 1; tick <= 10; tick += 1) {
        await shell.tick(BASE + tick * 30_000);
      }

      expect(userEvents()).toBe(userTurns);
      expect(provider.calls.length).toBe(runs);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('an autonomous run books its content with origin=emergence and no user turn', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '我想起了那家面包店。', toolCalls: [] }]);
    const shell = makeShell(dir, provider, {}, { now: () => BASE });
    await shell.start();
    try {
      emerge(shell, 'evt-autonomous-1');
      await shell.tick(BASE);
      const threadId = `companion-day:${shell.host.getService<{ localDate(at?: number): string }>('clock').localDate()}`;
      const events = shell.kernel.getThreadEvents(threadId, { projectId: shell.config.projectId, limit: 50 });
      expect(events.filter((event) => event.role === 'user')).toHaveLength(0);
      const booked = events.find((event) => (event.payload as { metadata?: { origin?: string } }).metadata?.origin === 'emergence');
      expect(booked).toBeDefined();
      // The recalled candidate entered the run as data, not as a user message.
      const prompt = provider.calls[0].messages;
      expect(prompt.some((message) => message.role === 'user')).toBe(false);
      expect(prompt.some((message) => message.role === 'system' && message.content.includes('<COGMEM_RECALL_CONTEXT'))).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a candidate is consumed once and the Tokyo day has a hard cap', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'one', toolCalls: [] }, { text: 'two', toolCalls: [] }]);
    const shell = makeShell(dir, provider, {}, { now: () => BASE });
    await shell.start();
    try {
      emerge(shell, 'evt-repeat');
      await shell.tick(BASE);
      expect(provider.calls).toHaveLength(1);
      // Same event again: the checkpoint's consumed key still refuses it.
      await shell.tick(BASE + 31 * 60_000);
      expect(provider.calls).toHaveLength(1);

      emerge(shell, 'evt-next');
      await shell.tick(BASE + 62 * 60_000);
      expect(provider.calls).toHaveLength(2);
      expect(shell.machine.runtime.emergence?.count).toBe(2);

      // A full Tokyo day's count blocks a fresh event without consulting recall again.
      shell.machine.updateRuntime({ emergence: { day: shell.machine.runtime.emergence!.day, count: 8, consumed: [] } });
      emerge(shell, 'evt-capped');
      await shell.tick(BASE + 93 * 60_000);
      expect(provider.calls).toHaveLength(2);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('consumed keys and the Tokyo day count survive a restart', async () => {
    const dir = makeTempDir();
    const first = makeShell(dir, new ScriptedProvider([{ text: 'one', toolCalls: [] }]), {}, { now: () => BASE });
    await first.start();
    emerge(first, 'evt-before-restart');
    await first.tick(BASE);
    expect(first.machine.runtime.emergence?.count).toBe(1);
    await first.stop();

    const provider = new ScriptedProvider([{ text: 'two', toolCalls: [] }]);
    const second = makeShell(dir, provider, {}, { now: () => BASE });
    await second.start();
    try {
      emerge(second, 'evt-after-restart');
      // A fresh candidate is not blocked by a shell-side cooldown; only the consumed key is.
      await second.tick(BASE + 60_000);
      expect(provider.calls).toHaveLength(1);
      expect(second.machine.runtime.emergence?.count).toBe(2);

      await second.tick(BASE + 3 * 60_000);
      expect(provider.calls).toHaveLength(1);
    } finally {
      await second.stop();
    }
  }, 30_000);
});

describe('the emergence day cap follows the configured zone (#285)', () => {
  test("a full New York day resets after its midnight", async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'new day', toolCalls: [] }]);
    let now = NY_LATE;
    const shell = makeShell(dir, provider, { timeZone: 'America/New_York' }, { now: () => now });
    await shell.start();
    try {
      emerge(shell, 'evt-new-day');
      shell.machine.updateRuntime({ emergence: { day: '2026-01-01', count: 8, consumed: [] } });
      now = NY_AFTER;
      await shell.tick(NY_AFTER);
      expect(provider.calls).toHaveLength(1);
      expect(shell.machine.runtime.emergence?.day).toBe('2026-01-02');
      expect(shell.machine.runtime.emergence?.count).toBe(1);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the same instants do not reset a Tokyo day (regression)', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'must not run', toolCalls: [] }]);
    let now = NY_LATE;
    const shell = makeShell(dir, provider, { timeZone: 'Asia/Tokyo' }, { now: () => now });
    await shell.start();
    try {
      emerge(shell, 'evt-same-day');
      shell.machine.updateRuntime({ emergence: { day: '2026-01-02', count: 8, consumed: [] } });
      now = NY_AFTER;
      await shell.tick(NY_AFTER);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

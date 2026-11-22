import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CheckpointStore, MAX_CONSUMED_WAKE_INTENTS } from '../src/state/checkpoint.ts';
import { StateMachine } from '../src/state/machine.ts';
import { TraceLog } from '../src/trace.ts';
import { makeTempDir } from './helpers.ts';

describe('consumed wake intents stay bounded (#440)', () => {
  test('the checkpoint keeps pending intents and only the newest consumed ones', () => {
    const dir = makeTempDir();
    const store = new CheckpointStore(dir);
    const machine = new StateMachine({ checkpoint: store, trace: new TraceLog(dir) });
    for (let index = 0; index < 100; index += 1) {
      const intent = machine.addWakeIntent({ at: index, reason: `done-${index}` });
      machine.consumeWakeIntent(intent.id);
    }
    const pending = machine.addWakeIntent({ at: 10_000, reason: 'keep-me' });
    expect(machine.wakeIntents.filter((intent) => intent.consumedAt !== undefined).length).toBeLessThanOrEqual(MAX_CONSUMED_WAKE_INTENTS);

    const saved = JSON.parse(readFileSync(store.path, 'utf8')) as { wakeIntents: Array<{ id: string; consumedAt?: number }> };
    expect(saved.wakeIntents.length).toBeLessThanOrEqual(MAX_CONSUMED_WAKE_INTENTS + 1);
    expect(saved.wakeIntents.some((intent) => intent.id === pending.id && intent.consumedAt === undefined)).toBe(true);

    const restored = new StateMachine({ checkpoint: store, trace: new TraceLog(dir) });
    restored.restore();
    expect(restored.wakeIntents.some((intent) => intent.id === pending.id && intent.consumedAt === undefined)).toBe(true);
    expect(restored.dueWakeIntent(10_000)?.id).toBe(pending.id);
    expect(restored.wakeIntents.filter((intent) => intent.consumedAt !== undefined).length).toBeLessThanOrEqual(MAX_CONSUMED_WAKE_INTENTS);
  });
});

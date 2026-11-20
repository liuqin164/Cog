import { describe, expect, test } from 'bun:test';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryKernel } from 'cogmem';

import { enqueueAway } from '../src/presence.ts';
import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

const DAY = 86_400_000;

function scan(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path).includes(Buffer.from(needle));
}

describe('/forget covers the shell checkpoint and trace', () => {
  test('a legacy checkpoint loads and its text moves behind a ledger reference', async () => {
    const dir = makeTempDir('forget-shell-legacy-');
    const data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    const checkpoint = join(data, 'checkpoint.json');
    writeFileSync(checkpoint, JSON.stringify({
      version: 1,
      state: 'IDLE',
      seq: 4,
      wakeIntents: [],
      runtime: {
        lastInteractionText: 'legacy display copy',
        openAssignment: { id: 'assignment-legacy', origin: 'user_message', text: 'legacy assignment text', startedAt: 1 },
        awayQueue: [{ id: 'away-legacy', text: 'legacy away text', reason: 'legacy', at: 1 }],
      },
      history: [],
      updatedAt: 1,
    }));

    const shell = makeShell(dir, new ScriptedProvider([{ text: '在。', toolCalls: [] }]));
    await shell.start();
    try {
      expect(shell.machine.runtime.openAssignment?.text).toBe('legacy assignment text');
      expect(shell.machine.runtime.awayQueue?.[0]?.text).toBe('legacy away text');
      const saved = readFileSync(checkpoint, 'utf8');
      expect(saved).not.toContain('legacy assignment text');
      expect(saved).not.toContain('lastInteractionText');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the marker leaves checkpoint.json, .prev and both trace generations', async () => {
    const dir = makeTempDir('forget-shell-');
    const data = join(dir, 'data');
    const marker = 'zz-shell-forget-4c81';
    const shell = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]));
    await shell.start();
    try {
      await shell.submit(`${marker} 我的旧住址是青叶町十二号。`);
    } finally {
      await shell.stop();
    }

    const trace = join(data, 'shell-events.jsonl');
    expect(scan(join(data, 'checkpoint.json'), marker)).toBe(false);
    expect(scan(join(data, 'checkpoint.json.prev'), marker)).toBe(false);
    expect(scan(trace, marker)).toBe(true);
    appendFileSync(join(data, 'shell-events.jsonl.1'), `${JSON.stringify({ at: Date.now(), kind: 'run_prompt', runId: 'old', chars: marker.length, text: marker })}\n`);

    const second = makeShell(dir, new ScriptedProvider([{ text: '好。', toolCalls: [] }]));
    await second.start();
    try {
      const now = Date.now();
      await second.runCommand('forget', `${new Date(now - DAY).toISOString()} ${new Date(now + DAY).toISOString()}`);
      const receipt = await second.runCommand('forget', 'confirm');
      expect(receipt.text).toContain('checkpoint');
      expect(receipt.text).toContain('trace');
      for (const file of ['checkpoint.json', 'checkpoint.json.prev', 'shell-events.jsonl', 'shell-events.jsonl.1']) {
        expect(scan(join(data, file), marker), file).toBe(false);
      }
    } finally {
      await second.stop();
    }
  }, 30_000);

  test('a snapshot into a new directory restores the open assignment and away queue', async () => {
    const dir = makeTempDir('forget-shell-export-');
    const shell = makeShell(dir, new ScriptedProvider([{ text: '好。', toolCalls: [] }]));
    await shell.start();
    try {
      await shell.submit('把这份报告整理完，然后等我确认');
      shell.machine.updateRuntime({
        awayQueue: enqueueAway(shell.machine.runtime, {
          id: 'away-1',
          text: '你不在时攒下的一条浮现',
          reason: 'test',
          at: Date.now(),
        }),
      });
      const before = {
        assignment: shell.machine.runtime.openAssignment?.text,
        away: shell.machine.runtime.awayQueue?.[0]?.text,
      };
      const snapshot = join(dir, 'memory.snap');
      await shell.kernel.exportSnapshot(snapshot);
      await shell.stop();

      const moved = makeTempDir('forget-shell-restore-');
      mkdirSync(join(moved, 'data', 'snapshots'), { recursive: true });
      cpSync(join(dir, 'data', 'checkpoint.json'), join(moved, 'data', 'checkpoint.json'));
      cpSync(join(dir, 'data', 'checkpoint.json.prev'), join(moved, 'data', 'checkpoint.json.prev'));
      const bare = createMemoryKernel({ dbPath: join(moved, 'data', 'memory.sqlite'), projectTimeZone: 'UTC' });
      await bare.importSnapshot(snapshot, { overwrite: true });
      for (const suffix of ['-wal', '-shm']) rmSync(join(moved, 'data', `memory.sqlite${suffix}`), { force: true });
      const restored = makeShell(moved, new ScriptedProvider([{ text: '在。', toolCalls: [] }]));
      await restored.start();
      try {
        expect(restored.machine.runtime.openAssignment?.text).toBe(before.assignment);
        expect(restored.machine.runtime.awayQueue?.[0]?.text).toBe(before.away);
      } finally {
        await restored.stop();
      }
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessLock, RuntimeLockHeldError, type RuntimeLock } from '../src/process-lock.ts';
import { makeTempDir, spawnFixture } from './helpers.ts';

function readLock(path: string): RuntimeLock {
  return JSON.parse(readFileSync(path, 'utf8')) as RuntimeLock;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (!pid) throw new Error('spawn did not report a pid');
  return pid;
}

describe('ProcessLock', () => {
  test('acquire writes the pid it reads back', () => {
    const lock = new ProcessLock(makeTempDir('lock-readback-'));
    expect(lock.acquire(424242, 1000)).toEqual({});
    expect(readLock(lock.path)).toEqual({ pid: 424242, at: 1000 });
  });

  test('a live holder is refused and the lock is not overwritten', () => {
    const lock = new ProcessLock(makeTempDir('lock-live-'));
    lock.acquire(process.pid, 1);
    expect(() => lock.acquire(process.pid + 1, 2)).toThrow(RuntimeLockHeldError);
    expect(readLock(lock.path).pid).toBe(process.pid);
  });

  test('a stale pid is renamed aside and taken over', async () => {
    const lock = new ProcessLock(makeTempDir('lock-stale-'));
    const pid = await deadPid();
    writeFileSync(lock.path, JSON.stringify({ pid, at: 1 }), 'utf8');
    expect(lock.acquire(process.pid, 2)).toEqual({ recoveredStalePid: pid });
    expect(readLock(lock.path)).toEqual({ pid: process.pid, at: 2 });
  });

  test('an unreadable lock is taken over', () => {
    const lock = new ProcessLock(makeTempDir('lock-corrupt-'));
    writeFileSync(lock.path, '{', 'utf8');
    expect(lock.acquire(process.pid, 2)).toEqual({});
    expect(readLock(lock.path).pid).toBe(process.pid);
  });

  test('two concurrent processes produce exactly one holder', async () => {
    for (let round = 0; round < 12; round += 1) {
      const dir = makeTempDir('lock-race-');
      const go = join(dir, 'go');
      const done = join(dir, 'done');
      const first = spawnFixture('lock-race-process.ts', [dir, go, done]);
      const second = spawnFixture('lock-race-process.ts', [dir, go, done]);
      const exits = Promise.all([first.exited(), second.exited()]);
      try {
        await Promise.all([first.waitFor('ready'), second.waitFor('ready')]);
        writeFileSync(go, '');
        const deadline = Date.now() + 10_000;
        while (![first, second].every((harness) => harness.events.some((event) => event.event === 'acquired' || event.event === 'held'))) {
          if (Date.now() > deadline) throw new Error(`round ${round}: ${JSON.stringify([...first.events, ...second.events])}\n${first.stderr}\n${second.stderr}`);
          await Bun.sleep(2);
        }
        writeFileSync(done, '');
        await exits;
        const events = [...first.events, ...second.events];
        const acquired = events.filter((event) => event.event === 'acquired');
        const held = events.filter((event) => event.event === 'held');
        expect(acquired, `round ${round}: ${JSON.stringify(events)}`).toHaveLength(1);
        expect(held, `round ${round}: ${JSON.stringify(events)}`).toHaveLength(1);
        expect(held[0].holder).toBe(acquired[0].pid);
        expect(readLock(join(dir, 'runtime.lock')).pid).toBe(acquired[0].pid);
      } finally {
        writeFileSync(done, '');
        first.child.kill();
        second.child.kill();
      }
    }
  }, 60_000);
});

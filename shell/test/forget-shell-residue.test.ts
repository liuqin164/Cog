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
        pendingSteering: ['legacy steering text'],
        openAssignment: { id: 'assignment-legacy', origin: 'user_message', text: 'legacy assignment text', startedAt: 1 },
        awayQueue: [{ id: 'away-legacy', text: 'legacy away text', reason: 'legacy', at: 1 }],
      },
      history: [],
      updatedAt: 1,
    }));

    const shell = makeShell(dir, new ScriptedProvider([{ text: '在。', toolCalls: [] }]));
    await shell.start();
    try {
      expect(shell.machine.runtime.pendingSteering?.[0]?.text).toBe('legacy steering text');
      expect(shell.machine.runtime.openAssignment?.text).toBe('legacy assignment text');
      expect(shell.machine.runtime.awayQueue?.[0]?.text).toBe('legacy away text');
      const saved = readFileSync(checkpoint, 'utf8');
      expect(saved).not.toContain('legacy steering text');
      expect(saved).not.toContain('legacy assignment text');
      expect(saved).not.toContain('lastInteractionText');
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the steering and follow-up queues store ledger references, and /forget empties both files', async () => {
    const dir = makeTempDir('forget-shell-queue-');
    const data = join(dir, 'data');
    const marker = 'zz-queued-steering-8d2e';
    const steering = `${marker} 先看西边`;
    const followUp = `${marker} 再看东边`;
    const shell = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]));
    await shell.start();
    try {
      const steeringId = shell.stateLedger.record('steering.text', steering);
      const followUpId = shell.stateLedger.record('followup.text', followUp);
      shell.machine.updateRuntime({
        pendingSteering: [{ text: steering, textId: steeringId }],
        pendingFollowUps: [{ text: followUp, textId: followUpId }],
      });
      expect(shell.machine.runtime.pendingSteering?.[0]?.text).toBe(steering);
      expect(scan(join(data, 'checkpoint.json'), marker)).toBe(false);
      expect(scan(join(data, 'checkpoint.json.prev'), marker)).toBe(false);

      const now = Date.now();
      await shell.runCommand('forget', `${new Date(now - DAY).toISOString()} ${new Date(now + DAY).toISOString()}`);
      const receipt = await shell.runCommand('forget', 'confirm');
      expect(receipt.text).toContain('checkpoint');
      expect(shell.machine.runtime.pendingSteering ?? []).toHaveLength(0);
      expect(shell.machine.runtime.pendingFollowUps ?? []).toHaveLength(0);
      for (const file of ['checkpoint.json', 'checkpoint.json.prev']) {
        expect(scan(join(data, file), marker), file).toBe(false);
      }
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

  test('a snapshot covered by /forget leaves no last-snapshot mark (#456)', async () => {
    const dir = makeTempDir('forget-shell-snapshot-');
    const now = Date.now();
    const shell = makeShell(
      dir,
      new ScriptedProvider([{ text: '在。', toolCalls: [] }]),
      { http: { enabled: true, port: 0, hostname: '127.0.0.1' } },
      { now: () => now },
    );
    await shell.start();
    try {
      await shell.submit('我的旧住址是青叶町十二号。');
      const manifest = await shell.kernel.backup.snapshot();
      expect(manifest?.verification.ok).toBe(true);
      const health = await (await fetch(`${shell.httpUrl}/observatory/health`)).json() as {
        snapshot: { file: string; ok: boolean } | null;
      };
      expect(health.snapshot).toMatchObject({ ok: true });

      const marker = (): { value?: string } | null => shell.kernel.factStore.getDatabase()
        .prepare(`SELECT value FROM _meta WHERE key='brain_snapshot_last'`)
        .get() as { value?: string } | null;
      expect(marker()?.value).toBeTruthy();

      await shell.runCommand('forget', `${new Date(now - DAY).toISOString()} ${new Date(now + DAY).toISOString()}`);
      const receipt = await shell.runCommand('forget', 'confirm');
      expect(receipt.text).toContain('本机快照 1 个');
      expect(marker()).toBeNull();

      const after = await (await fetch(`${shell.httpUrl}/observatory/health`)).json() as { snapshot: unknown };
      expect(after.snapshot).toBeNull();
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('a pending binding reference leaves the database bytes after confirm', async () => {
    const dir = makeTempDir('forget-shell-pending-');
    const data = join(dir, 'data');
    const marker = 'zz-pending-373-9a4c';
    const first = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]));
    await first.start();
    try {
      await first.submit(`${marker} 你把它放在哪里了?`);
    } finally {
      await first.stop();
    }
    const dbPath = join(data, 'memory.sqlite');
    const seeded = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
    try {
      const db = seeded.factStore.getDatabase();
      const event = db.prepare(`SELECT event_id FROM memory_events WHERE role='user' ORDER BY occurred_at DESC LIMIT 1`).get() as { event_id: string };
      db.prepare(`INSERT INTO interaction_units (unit_id, type, message_neuron_ids_json, semantic_text, status, created_at, updated_at)
        VALUES ('unit-probe', 'question', ?, ?, 'pending', ?, ?)`)
        .run(JSON.stringify([event.event_id]), `${marker} question`, Date.now(), Date.now());
      db.prepare(`INSERT INTO pending_bindings (pending_id, binding_type, unit_id, reference_text, status, created_at, updated_at)
        VALUES ('pending-probe', 'question', 'unit-probe', ?, 'pending', ?, ?)`)
        .run(`${marker} 你把它放在哪里了?`, Date.now(), Date.now());
    } finally {
      seeded.close();
    }
    expect(scan(dbPath, marker)).toBe(true);

    const second = makeShell(dir, new ScriptedProvider([{ text: '好。', toolCalls: [] }]));
    await second.start();
    try {
      const now = Date.now();
      const preview = await second.runCommand('forget', `${new Date(now - DAY).toISOString()} ${new Date(now + DAY).toISOString()}`);
      expect(preview.text).toContain('pending_bindings 待绑定引用 1 条');
      const receipt = await second.runCommand('forget', 'confirm');
      expect(receipt.text).toContain('pendingBindings 1');
      for (const file of ['memory.sqlite', 'memory.sqlite-wal', 'memory.sqlite-shm']) {
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

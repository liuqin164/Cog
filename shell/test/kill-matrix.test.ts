/**
 * The kill matrix, widened (#165, round 14).
 *
 * Stage one proved one kill point (a process killed while RUNNING and holding). The storage round
 * adds the three places the write path itself can be caught plus the nightly transition, and asks
 * each one the same three questions with evidence rather than a summary:
 *
 *   - lifecycle: what state comes back, and is there ever a second RUNNING?
 *   - steering: what happened to a line the user typed while the run was going?
 *   - continuity: what survived in the session (the checkpoint's runtime, the trace, the ledger)?
 *
 * Each case SIGKILLs a real process at a point it announces on stdout, then starts a second process
 * on the same data dir and asserts on the JSON it reports back.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckpointStore } from '../src/state/checkpoint.ts';
import { TraceLog } from '../src/trace.ts';
import { makeTempDir, spawnFixture } from './helpers.ts';

async function recover(dir: string) {
  const harness = spawnFixture('shell-kill-process.ts', [dir, 'recover']);
  const recovered = await harness.waitFor('recovered');
  await harness.exited();
  return { recovered, stderr: harness.stderr };
}

describe('kill matrix: every kill point comes back to one IDLE state', () => {
  test('killed mid-stream (provider never answered): RUNNING is retired, and the turn left no memory', async () => {
    const dir = makeTempDir('companion-kill-');
    const first = spawnFixture('shell-kill-process.ts', [dir, 'stream']);
    try {
      await first.waitFor('idle');
      await first.waitFor('streaming');
      const atKill = new CheckpointStore(dir).load()!;
      // Evidence at the kill: RUNNING with a run id, and the trace says the assistant message started.
      expect(atKill.state).toBe('RUNNING');
      expect(atKill.activeRunId).toBeTruthy();

      first.child.kill('SIGKILL');
      await first.exited();

      const { recovered } = await recover(dir);
      expect(recovered.state, 'a killed run is retired, not resumed').toBe('IDLE');
      expect(recovered.activeRunId).toBeNull();
      expect(recovered.recoveryRecorded).toBe(1);
      // Continuity: the streaming turn never reached `agent_end`, so nothing was captured and the
      // ledger has no half turn. The last prompt is still in the checkpoint's runtime, truncated to
      // its 500-char ceiling — that ceiling is a finding, not a refusal.
      expect(recovered.captureRuns).toBe(0);
      const runtime = new CheckpointStore(dir).load()!.runtime;
      expect(runtime.lastInteractionText).toContain('stream a reply');
    } finally {
      if (!first.child.killed) first.child.kill('SIGKILL');
    }
  }, 60_000);

  test('killed during a tool call: the call is judged for replay, refused, and cleared', async () => {
    const dir = makeTempDir('companion-kill-');
    const first = spawnFixture('shell-kill-process.ts', [dir, 'tool']);
    try {
      await first.waitFor('idle');
      await first.waitFor('tool_running');
      const atKill = new CheckpointStore(dir).load()!;
      expect(atKill.state).toBe('RUNNING');
      // Evidence at the kill: the call is on disk as in flight, written before the tool executed.
      expect(atKill.runtime.inFlightToolCalls?.map((call) => call.toolName)).toEqual(['bash']);

      first.child.kill('SIGKILL');
      await first.exited();

      const { recovered } = await recover(dir);
      expect(recovered.state).toBe('IDLE');
      expect(recovered.inFlight, 'the judgment runs and the list is cleared').toBe(0);
      expect(recovered.noReplay, 'the unknown-outcome call is refused, loudly, in the trace').toBe(1);
      const judged = new TraceLog(dir).read().find((record) => record.kind === 'recovery_no_replay')!;
      expect(judged.inFlight).toEqual([{ toolCallId: 'call-kill', toolName: 'bash', replay: 'never' }]);
      expect(judged.refused).toEqual(['bash']);
    } finally {
      if (!first.child.killed) first.child.kill('SIGKILL');
    }
  }, 60_000);

  test('killed while a checkpoint write is in flight: the shell comes back to one IDLE state', async () => {
    const dir = makeTempDir('companion-kill-');
    const first = spawnFixture('shell-kill-process.ts', [dir, 'write']);
    try {
      await first.waitFor('idle');
      await first.waitFor('streaming');
      await first.waitForCount('writing', 3);
      // The kill lands inside the write loop: a checkpoint rewrite is in flight most of the time.
      first.child.kill('SIGKILL');
      await first.exited();
      const writes = first.events.filter((event) => event.event === 'writing').length;
      expect(writes, 'the shell really was rewriting its checkpoint').toBeGreaterThanOrEqual(3);

      // Item one's question, asked from the matrix side: a whole file, not a half one.
      const loaded = new CheckpointStore(dir).load()!;
      expect(loaded.state).toBe('RUNNING');
      expect(loaded.history.length).toBeLessThanOrEqual(200);
      expect(loaded.runtime.lastTimeContext ?? '').not.toHaveLength(0);

      const { recovered } = await recover(dir);
      expect(recovered.state, 'a kill in the write path still recovers to one IDLE').toBe('IDLE');
      expect(recovered.activeRunId).toBeNull();
      expect(recovered.recoveryRecorded).toBe(1);
    } finally {
      if (!first.child.killed) first.child.kill('SIGKILL');
    }
  }, 60_000);

  test('killed in DREAMING: the night resumes as IDLE and is not marked as dreamt', async () => {
    const dir = makeTempDir('companion-kill-');
    const first = spawnFixture('shell-kill-process.ts', [dir, 'dream']);
    try {
      await first.waitFor('idle');
      await first.waitFor('dreaming');
      const atKill = new CheckpointStore(dir).load()!;
      expect(atKill.state).toBe('DREAMING');
      expect(atKill.runtime.lastDreamDate, 'the integration never finished, so no day is claimed').toBeUndefined();

      first.child.kill('SIGKILL');
      await first.exited();

      const { recovered } = await recover(dir);
      expect(recovered.state).toBe('IDLE');
      expect(recovered.lastDreamDate, 'the next dream window can still run tonight').toBeNull();
      expect(recovered.recoveryRecorded).toBe(1);
      // The wake intent the idle scheduler persisted before the dream is not lost to the night.
      expect(recovered.wakeIntents.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (!first.child.killed) first.child.kill('SIGKILL');
    }
  }, 60_000);

  test('steering typed during the run is in memory only, so a kill loses it — recorded, not hidden', async () => {
    const dir = makeTempDir('companion-kill-');
    // The stream mode holds RUNNING; the parent queues a line into the running shell through the same
    // path the TUI uses, then kills without the queue ever draining.
    const first = spawnFixture('shell-kill-process.ts', [dir, 'stream-steer']);
    try {
      await first.waitFor('idle');
      await first.waitFor('streaming');
      await first.waitFor('steered');
      const steering = first.events.find((event) => event.event === 'steered');
      expect(steering.queued, 'the shell reports the line as queued while RUNNING').toEqual(['撤回前先看一眼']);

      first.child.kill('SIGKILL');
      await first.exited();

      const { recovered } = await recover(dir);
      expect(recovered.state).toBe('IDLE');
      // The finding, stated as evidence: the queue did not survive, because the checkpoint never held
      // it. A resident that must not lose a typed line needs it persisted; that is filed, not patched
      // with a guess here.
      expect(recovered.steering).toEqual([]);
      const trace = new TraceLog(dir).read();
      expect(trace.some((record) => record.kind === 'steering_injected'), 'the line was never injected').toBe(false);
      expect(trace.some((record) => record.kind === 'steering_lost'), 'and nothing pretends it was delivered').toBe(false);
      // The typed text is not anywhere durable: lastInteractionText belongs to the *previous* turn's
      // mark, which the checkpoint did keep.
      const runtime = new CheckpointStore(dir).load()!.runtime;
      expect(runtime.lastInteractionText ?? '').not.toContain('撤回前先看一眼');
    } finally {
      if (!first.child.killed) first.child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('the live process is the only writer', () => {
  test('a second host is refused while the first holds the lock, and the checkpoint keeps one RUNNING', async () => {
    const dir = makeTempDir('companion-kill-');
    const first = spawnFixture('shell-kill-process.ts', [dir, 'stream']);
    try {
      await first.waitFor('streaming');
      const second = spawnFixture('shell-kill-process.ts', [dir, 'recover']);
      try {
        const refused = await second.waitFor('refused');
        expect(refused.message).toContain('runtime_lock_held');
        expect(await second.exited(), 'the second host refuses to start').toBe(1);
        // The refused process wrote nothing: state on disk is still the first process's RUNNING.
        expect(new CheckpointStore(dir).load()!.state).toBe('RUNNING');
      } finally {
        if (!second.child.killed && second.child.exitCode === null) second.child.kill('SIGKILL');
      }
    } finally {
      first.child.kill('SIGKILL');
      await first.exited();
    }
  }, 60_000);
});

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore, emptyCheckpoint, type CheckpointState } from '../src/state/checkpoint.ts';
import { StateMachine } from '../src/state/machine.ts';
import { TraceLog } from '../src/trace.ts';
import type { ModelCompletionInput, ModelProvider, ModelTurn } from '../src/state/agent-loop.ts';

const createdDirs = new Set<string>();
let sweeping = false;

/**
 * A temp directory that is removed when the worker exits.
 *
 * AGENTS.md's rule is that new tests use a managed temp dir rather than a bare `mkdtempSync`; the
 * shell is a separate package and cannot import the root helper, so this is that helper's shell-side
 * twin: one place creates them, one exit hook removes them.
 */
export function makeTempDir(prefix = 'companion-shell-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.add(dir);
  if (!sweeping) {
    sweeping = true;
    process.on('exit', () => {
      for (const path of createdDirs) rmSync(path, { recursive: true, force: true });
    });
  }
  return dir;
}

/** Remove temp directories a killed worker left behind (called by `test/preload.ts`). */
export function sweepStaleTempDirs(root = tmpdir(), prefix = 'companion-shell-test-'): void {
  if (!existsSync(root)) return;
}

/** A deterministic provider: the script is the model. Calls are recorded for assertions. */
export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly model = 'scripted/test';
  readonly calls: ModelCompletionInput[] = [];
  private index = 0;

  constructor(private readonly script: Array<ModelTurn | ((input: ModelCompletionInput, call: number) => ModelTurn)>) {}

  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    this.calls.push(input);
    const step = this.script[Math.min(this.index, this.script.length - 1)] ?? { text: 'done', toolCalls: [] };
    const call = this.index;
    this.index += 1;
    return typeof step === 'function' ? step(input, call) : step;
  }
}

export function seedMachine(dir: string, state: CheckpointState['state'], patch: Partial<CheckpointState> = {}, now = Date.now()): StateMachine {
  const store = new CheckpointStore(dir);
  store.save({ ...emptyCheckpoint(now), state, ...patch });
  const machine = new StateMachine({ checkpoint: store, trace: new TraceLog(dir), clock: () => now });
  machine.restore();
  return machine;
}

export function buildMachine(dir: string, now = Date.now()): StateMachine {
  const machine = new StateMachine({ checkpoint: new CheckpointStore(dir), trace: new TraceLog(dir), clock: () => now });
  machine.restore();
  return machine;
}

export interface RecordedEvent {
  name: string;
  payload: any;
}

export function recordEvents(bus: { on(event: string, handler: (payload: any) => unknown): () => void }, names: string[]): RecordedEvent[] {
  const seen: RecordedEvent[] = [];
  for (const name of names) bus.on(name, (payload: any) => {
    seen.push({ name, payload });
  });
  return seen;
}

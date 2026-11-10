import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionShell } from '../src/app.ts';
import type { ShellConfig } from '../src/config.ts';
import { CheckpointStore, emptyCheckpoint, type CheckpointState } from '../src/state/checkpoint.ts';
import { StateMachine } from '../src/state/machine.ts';
import { TraceLog } from '../src/trace.ts';
import type { ModelCompletionInput, ModelProvider, ModelTurn } from '../src/state/agent-loop.ts';

/**
 * A temp directory under the run's `TMPDIR`; `test/preload.ts` sweeps the whole family at the start
 * of the next run.
 *
 * AGENTS.md's rule is that new tests use a managed temp dir rather than a bare `mkdtempSync`; the
 * shell is a separate package and cannot import the root helper, so this is that helper's shell-side
 * twin. There used to be a `process.on('exit')` hook here to remove them at the end of the run, but
 * bun's test runner does not fire it — measured: the directory is still on disk after the run — so
 * the preload's sweep is the mechanism, and the exit of a run leaves one directory per test case
 * behind until the next run. The prefix list in the preload has to keep up with the prefixes used
 * here, which is why it is one array next to this comment's twin.
 */
export function makeTempDir(prefix = 'companion-shell-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
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

export interface TestShellOptions {
  terminalInput?: NodeJS.ReadableStream;
  terminalOutput?: NodeJS.WritableStream;
  now?: () => number;
  tick?: boolean;
}

/**
 * The one test shell: temp dirs inside the managed prefix, no terminal, no MCP face and no Pi adapter
 * unless the test asks for them. Six copies of this config literal had already started to drift.
 */
export function makeShell(dir: string, provider: ModelProvider, config: Partial<ShellConfig> = {}, options: TestShellOptions = {}): CompanionShell {
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  return new CompanionShell({
    config: {
      workspaceRoot: workspace,
      dataDir: join(dir, 'data'),
      dbPath: join(dir, 'data', 'memory.sqlite'),
      timeZone: 'UTC',
      projectId: 'companion-test',
      agentId: 'cogmem-companion-test',
      sessionId: 'session-test',
      terminalEnabled: false,
      mcp: { enabled: false, port: 0, hostname: '127.0.0.1', path: '/mcp', profile: 'core' },
      pi: { adapterEnabled: false, plugins: [] },
      ...config,
    },
    modelProvider: provider,
    tick: options.tick ?? false,
    now: options.now,
    terminalInput: options.terminalInput,
    terminalOutput: options.terminalOutput,
  });
}

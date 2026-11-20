/**
 * The process half of the continuity scorecard's kill scenario (#346).
 *
 * Starts a real `CompanionShell`, opens a user assignment, puts one away-queue entry in the
 * checkpoint through the shell's own `enqueueAway`, and blocks inside the provider. The parent
 * SIGKILLs it after the `ready` line; the next process is asked what the disk kept.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CompanionShell } from '../../../shell/src/app.ts';
import { enqueueAway } from '../../../shell/src/presence.ts';
import type { ModelProvider, ModelTurn } from '../../../shell/src/state/agent-loop.ts';

const dir = process.argv[2];
if (!dir) throw new Error('shell-kill: a data directory is required');

const workspace = join(dir, 'ws');
const dataDir = join(dir, 'data');
mkdirSync(workspace, { recursive: true });

let onProviderEntered: (() => void) | undefined;
const providerEntered = new Promise<void>((resolvePromise) => {
  onProviderEntered = resolvePromise;
});

let turns = 0;
const provider: ModelProvider = {
  name: 'kill-script',
  model: 'kill/script',
  async complete(): Promise<ModelTurn> {
    turns += 1;
    if (turns === 1) {
      return { text: '先声明任务再继续。', toolCalls: [{ toolCallId: 'c0', toolName: 'declare_task', input: { action: 'start' } }] };
    }
    process.stdout.write(`${JSON.stringify({ event: 'provider_entered' })}\n`);
    onProviderEntered?.();
    return await new Promise<ModelTurn>(() => {});
  },
};

const shell = new CompanionShell({
  config: {
    workspaceRoot: workspace,
    dataDir,
    dbPath: join(dataDir, 'memory.sqlite'),
    timeZone: 'UTC',
    projectId: 'companion-kill',
    agentId: 'cogmem-companion-kill',
    sessionId: 'session-kill',
    terminalEnabled: false,
    http: { enabled: false, port: 0, hostname: '127.0.0.1' },
    plugins: [],
    attach: { enabled: false },
  },
  modelProvider: provider,
  tick: false,
});

await shell.start();
shell.machine.updateRuntime({
  awayQueue: enqueueAway(shell.machine.runtime, {
    id: 'away-1',
    text: '你不在时攒下的一条浮现',
    reason: 'continuity-scorecard',
    at: Date.now(),
  }),
});
void shell.submit('把这份报告整理完，然后等我确认');
await providerEntered;
process.stdout.write(`${JSON.stringify({
  event: 'ready',
  assignment: shell.machine.runtime.openAssignment?.id ?? null,
  away: shell.machine.runtime.awayQueue?.length ?? 0,
})}\n`);
await new Promise(() => {});

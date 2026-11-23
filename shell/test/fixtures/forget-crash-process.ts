import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionShell } from '../../src/app.ts';
import type { ModelProvider } from '../../src/state/agent-loop.ts';

const dir = process.argv[2];
const mode = process.argv[3] ?? 'recover';
const marker = process.argv[4] ?? 'zz-forget-crash';
if (!dir) throw new Error('forget-crash-process: a data directory is required');

const provider: ModelProvider = {
  name: 'forget-crash',
  model: 'forget/crash',
  async complete() {
    return { text: '在。', toolCalls: [] };
  },
};

const shell = new CompanionShell({
  config: {
    workspaceRoot: join(dir, 'ws'),
    dataDir: join(dir, 'data'),
    dbPath: join(dir, 'data', 'memory.sqlite'),
    timeZone: 'UTC',
    projectId: 'companion-forget-crash',
    agentId: 'cogmem-forget-crash',
    sessionId: 'session-forget-crash',
    terminalEnabled: false,
    http: { enabled: false, port: 0, hostname: '127.0.0.1' },
    plugins: [],
    attach: { enabled: false },
  },
  modelProvider: provider,
  tick: false,
});

function say(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const data = join(dir, 'data');

if (mode === 'crash') {
  await shell.start();
  const text = `${marker} 我的旧住址是青叶町十二号。`;
  const steeringId = shell.stateLedger.record('steering.text', `${marker} 先看西边`);
  shell.machine.updateRuntime({ pendingSteering: [{ text: `${marker} 先看西边`, textId: steeringId }] });
  await shell.submit(text);
  const now = Date.now();
  shell.trace.append('command_proposed', { id: 'late', command: 'bash', args: `echo ${marker}`, reason: `${marker} 的旧住址` }, now + 86_400_000);
  await shell.runCommand('forget', `${new Date(now - 86_400_000).toISOString()} ${new Date(now + 86_400_000).toISOString()}`);
  shell.trace.forgetWindow = () => {
    process.kill(process.pid, 'SIGKILL');
    return 0;
  };
  say({ event: 'forgetting' });
  await shell.runCommand('forget', 'confirm');
  say({ event: 'survived' });
  process.exit(0);
}

await shell.start();
say({
  event: 'recovered',
  steering: shell.machine.runtime.pendingSteering ?? [],
  pendingForget: shell.machine.runtime.pendingForget ?? null,
  trace: read(shell.trace.path),
  checkpoint: read(join(data, 'checkpoint.json')),
  previous: read(join(data, 'checkpoint.json.prev')),
});
await shell.stop();
process.exit(0);

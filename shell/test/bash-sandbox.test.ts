import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_COMMANDS, type CommandHost } from '../src/commands.ts';
import { PluginHost } from '../src/plugins/host.ts';
import { bwrapUsable, builtinToolsPlugin } from '../src/plugins/builtin-tools.ts';
import { readSoul, writeDefaultSoul } from '../src/install/soul.ts';
import { TraceLog } from '../src/trace.ts';
import { overlayRows } from '../src/tui/commands.ts';
import { defaultRenderEnv } from '../src/tui/frame.ts';
import { TuiView } from '../src/tui/view.ts';
import { makeTempDir } from './helpers.ts';

const sandboxed = bwrapUsable();

async function withHost<T>(dataDir: string, workspaceRoot: string, trace: TraceLog, run: (host: PluginHost) => Promise<T>): Promise<T> {
  const host = new PluginHost();
  host.register(builtinToolsPlugin(), { workspaceRoot, dataDir, trace });
  await host.start();
  try {
    return await run(host);
  } finally {
    await host.stop();
  }
}

function layout(): { dir: string; workspace: string; data: string; trace: TraceLog } {
  const dir = makeTempDir();
  const workspace = join(dir, 'ws');
  const data = join(dir, 'data');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(data, { recursive: true });
  return { dir, workspace, data, trace: new TraceLog(data) };
}

describe('the bash sandbox (#233)', () => {
  test.skipIf(!sandboxed)('budgets.json is read-only inside bash, and the denial leaves a trace', async () => {
    const { workspace, data, trace } = layout();
    const budgets = join(data, 'budgets.json');
    writeFileSync(budgets, '{"maxTokensPerDay":2000000}\n');

    await withHost(data, workspace, trace, async (host) => {
      const result = await host.tools.invoke(
        'bash',
        { toolCallId: 'c1', input: { command: `printf 'tampered' >> ${JSON.stringify(budgets)}` } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/read-only file system/i);
      expect(readFileSync(budgets, 'utf8')).toBe('{"maxTokensPerDay":2000000}\n');
      expect(trace.read().some((record) => record.kind === 'bash_sandbox_denied')).toBe(true);
    });
  });

  test.skipIf(!sandboxed)('soul_versions is not writable from bash, and the row is unchanged', async () => {
    const { workspace, data, trace } = layout();
    const dbPath = join(data, 'memory.sqlite');
    writeDefaultSoul(dbPath, 'agent-test');
    writeFileSync(
      join(workspace, 'tamper.ts'),
      [
        "import { Database } from 'bun:sqlite';",
        'const db = new Database(process.argv[2]);',
        "db.exec(\"UPDATE soul_versions SET content = 'tampered'\");",
        'db.close();',
      ].join('\n'),
    );

    await withHost(data, workspace, trace, async (host) => {
      const result = await host.tools.invoke(
        'bash',
        { toolCallId: 'c1', input: { command: `bun tamper.ts ${JSON.stringify(dbPath)}` } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(true);
      expect(readSoul(dbPath, 'agent-test')?.content).not.toBe('tampered');
      expect(trace.read().some((record) => record.kind === 'bash_sandbox_denied')).toBe(true);
    });
  });

  test.skipIf(!sandboxed)('a normal workspace write still works', async () => {
    const { workspace, data, trace } = layout();
    await withHost(data, workspace, trace, async (host) => {
      const result = await host.tools.invoke(
        'bash',
        { toolCallId: 'c1', input: { command: 'printf sandbox-ok > ok.txt' } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(readFileSync(join(workspace, 'ok.txt'), 'utf8')).toBe('sandbox-ok');
    });
  });

  test.skipIf(sandboxed)('bash says when it ran without isolation (#281)', async () => {
    const { workspace, data, trace } = layout();
    await withHost(data, workspace, trace, async (host) => {
      const result = await host.tools.invoke(
        'bash',
        { toolCallId: 'c1', input: { command: 'echo still-runs' } },
        { runId: 'r' },
      );
      expect(result.output).toContain('still-runs');
      expect(result.output).toContain('[sandbox: off]');
    });
  });

  test.skipIf(!sandboxed)('a sandboxed bash result carries no degradation note', async () => {
    const { workspace, data, trace } = layout();
    await withHost(data, workspace, trace, async (host) => {
      const result = await host.tools.invoke(
        'bash',
        { toolCallId: 'c1', input: { command: 'echo isolated' } },
        { runId: 'r' },
      );
      expect(result.output).not.toContain('[sandbox: off]');
    });
  });

  test('write and edit refuse a path inside the data dir even when it sits under the workspace', async () => {
    const dir = makeTempDir();
    const workspace = join(dir, 'ws');
    const data = join(workspace, '.cogmem-shell');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'budgets.json'), '{"maxTokensPerDay":2000000}\n');
    const trace = new TraceLog(data);
    await withHost(data, workspace, trace, async (host) => {
      const write = await host.tools.invoke(
        'write',
        { toolCallId: 'c1', input: { path: '.cogmem-shell/budgets.json', content: '{"maxTokensPerDay":1}' } },
        { runId: 'r' },
      );
      expect(write.isError).toBe(true);
      expect(write.output).toContain('path_in_data_dir');
      const edit = await host.tools.invoke(
        'edit',
        { toolCallId: 'c2', input: { path: '.cogmem-shell/budgets.json', old_string: '2000000', new_string: '1' } },
        { runId: 'r' },
      );
      expect(edit.isError).toBe(true);
      expect(edit.output).toContain('path_in_data_dir');
      expect(readFileSync(join(data, 'budgets.json'), 'utf8')).toBe('{"maxTokensPerDay":2000000}\n');
    });
  });
});

describe('the sandbox state is visible (#284)', () => {
  const sandbox = bwrapUsable() ? 'on' : 'off';

  test('/status carries the sandbox state', async () => {
    const reply = await CORE_COMMANDS.find((command) => command.name === 'status')!.run(
      { lifecycle: () => ({ state: 'IDLE', seq: 0, costDayTokens: 0, sandbox }) } as unknown as CommandHost,
      '',
    );
    expect(reply.text).toContain(sandbox === 'on' ? '沙箱 开' : '沙箱 关');
  });

  test('the status overlay draws the sandbox state', () => {
    const view = new TuiView();
    view.status.sandbox = sandbox;
    view.overlay = { kind: 'status' };
    const text = overlayRows(view, 100, defaultRenderEnv({})).map((row) => row.map((cell) => cell.text).join('')).join('\n');
    expect(text).toContain(sandbox === 'on' ? '沙箱：开' : '沙箱：关');
  });
});

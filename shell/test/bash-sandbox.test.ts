import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginHost } from '../src/plugins/host.ts';
import { bwrapUsable, builtinToolsPlugin } from '../src/plugins/builtin-tools.ts';
import { readSoul, writeDefaultSoul } from '../src/install/soul.ts';
import { TraceLog } from '../src/trace.ts';
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

  test('write and edit refuse a path inside the data dir even when it sits under the workspace', async () => {
    const dir = makeTempDir();
    const workspace = join(dir, 'ws');
    const data = join(workspace, '.cogmem-shell');
    mkdirSync(data, { recursive: true });
    const trace = new TraceLog(data);
    await withHost(data, workspace, trace, async (host) => {
      const result = await host.tools.invoke(
        'write',
        { toolCallId: 'c1', input: { path: '.cogmem-shell/budgets.json', content: '{"maxTokensPerDay":1}' } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('path_in_data_dir');
    });
  });
});

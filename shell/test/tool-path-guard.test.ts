/**
 * #302: the four builtins run in the host process and were guarded by `path.resolve` alone, so a
 * symlink inside the workspace could point `read`/`write`/`edit` at any file the host could open.
 * The guard now compares real locations, and `read` gets the same data-dir exclusion `write` and
 * `edit` had.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinToolsPlugin } from '../src/plugins/builtin-tools.ts';
import { PluginHost } from '../src/plugins/host.ts';
import { makeTempDir } from './helpers.ts';

interface Layout {
  workspace: string;
  data: string;
  outside: string;
}

function layout(): Layout {
  const root = makeTempDir();
  const workspace = join(root, 'ws');
  const data = join(root, 'data');
  const outside = join(root, 'outside');
  for (const dir of [workspace, data, outside]) mkdirSync(dir, { recursive: true });
  return { workspace, data, outside };
}

async function withHost<T>(l: Layout, run: (host: PluginHost) => Promise<T>): Promise<T> {
  const host = new PluginHost();
  host.register(builtinToolsPlugin(), { workspaceRoot: l.workspace, dataDir: l.data });
  await host.start();
  try {
    return await run(host);
  } finally {
    await host.stop();
  }
}

describe('a symlink cannot carry a host tool out of the workspace (#302)', () => {
  test('read, write and edit refuse a symlink to an outside file', async () => {
    const l = layout();
    const secret = join(l.outside, 'secret.txt');
    writeFileSync(secret, 'outside-secret\n');
    symlinkSync(secret, join(l.workspace, 'passwd-like'));

    await withHost(l, async (host) => {
      const read = await host.tools.invoke('read', { toolCallId: 'c1', input: { path: 'passwd-like' } }, { runId: 'r' });
      expect(read.isError).toBe(true);
      expect(read.output).toContain('path_outside_workspace');
      expect(read.output).not.toContain('outside-secret');

      const write = await host.tools.invoke(
        'write',
        { toolCallId: 'c2', input: { path: 'passwd-like', content: 'overwritten' } },
        { runId: 'r' },
      );
      expect(write.isError).toBe(true);
      expect(write.output).toContain('path_outside_workspace');

      const edit = await host.tools.invoke(
        'edit',
        { toolCallId: 'c3', input: { path: 'passwd-like', old_string: 'outside', new_string: 'inside' } },
        { runId: 'r' },
      );
      expect(edit.isError).toBe(true);
      expect(edit.output).toContain('path_outside_workspace');
      expect(readFileSync(secret, 'utf8')).toBe('outside-secret\n');
    });
  });

  test('a symlinked directory pointing outside is refused for a file that does not exist yet', async () => {
    const l = layout();
    symlinkSync(l.outside, join(l.workspace, 'out'));

    await withHost(l, async (host) => {
      const write = await host.tools.invoke(
        'write',
        { toolCallId: 'c1', input: { path: 'out/planted.txt', content: 'planted' } },
        { runId: 'r' },
      );
      expect(write.isError).toBe(true);
      expect(write.output).toContain('path_outside_workspace');
      expect(existsSync(join(l.outside, 'planted.txt'))).toBe(false);
    });
  });

  test('a dangling symlink is refused rather than followed outside', async () => {
    const l = layout();
    symlinkSync(join(l.outside, 'created.txt'), join(l.workspace, 'ghost.txt'));

    await withHost(l, async (host) => {
      const write = await host.tools.invoke(
        'write',
        { toolCallId: 'c1', input: { path: 'ghost.txt', content: 'planted' } },
        { runId: 'r' },
      );
      expect(write.isError).toBe(true);
      expect(write.output).toContain('path_outside_workspace');
      expect(existsSync(join(l.outside, 'created.txt'))).toBe(false);
    });
  });

  test('read refuses the data dir under the workspace, directly and through a symlink', async () => {
    const root = makeTempDir();
    const workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
    const data = join(workspace, '.cogmem-shell');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'env'), 'MG_API_KEY=sk-live\n');
    symlinkSync(data, join(workspace, 'state'));
    const l: Layout = { workspace, data, outside: join(root, 'outside') };

    await withHost(l, async (host) => {
      const direct = await host.tools.invoke('read', { toolCallId: 'c0', input: { path: '.cogmem-shell/env' } }, { runId: 'r' });
      expect(direct.isError).toBe(true);
      expect(direct.output).toContain('path_in_data_dir');

      const read = await host.tools.invoke('read', { toolCallId: 'c1', input: { path: 'state/env' } }, { runId: 'r' });
      expect(read.isError).toBe(true);
      expect(read.output).toContain('path_in_data_dir');
      expect(read.output).not.toContain('sk-live');

    });
  });

  test('a symlink that resolves inside the workspace keeps working for all three', async () => {
    const l = layout();
    const target = join(l.workspace, 'target.txt');
    writeFileSync(target, 'inside\n');
    symlinkSync(target, join(l.workspace, 'alias.txt'));

    await withHost(l, async (host) => {
      const read = await host.tools.invoke('read', { toolCallId: 'c1', input: { path: 'alias.txt' } }, { runId: 'r' });
      expect(read.isError).toBe(false);
      expect(read.output).toBe('inside\n');

      const edit = await host.tools.invoke(
        'edit',
        { toolCallId: 'c2', input: { path: 'alias.txt', old_string: 'inside', new_string: 'still inside' } },
        { runId: 'r' },
      );
      expect(edit.isError).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('still inside\n');

      const write = await host.tools.invoke(
        'write',
        { toolCallId: 'c3', input: { path: 'alias.txt', content: 'rewritten\n' } },
        { runId: 'r' },
      );
      expect(write.isError).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('rewritten\n');
    });
  });

  test('creating a new nested file inside the workspace still works', async () => {
    const l = layout();
    await withHost(l, async (host) => {
      const write = await host.tools.invoke(
        'write',
        { toolCallId: 'c1', input: { path: 'new/deep/file.txt', content: 'fresh\n' } },
        { runId: 'r' },
      );
      expect(write.isError).toBe(false);
      expect(readFileSync(join(l.workspace, 'new', 'deep', 'file.txt'), 'utf8')).toBe('fresh\n');
    });
  });
});

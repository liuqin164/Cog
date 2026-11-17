/**
 * #301: `edit` used `String.replace(oldString, newString)`, whose string form interprets `$&`,
 * `$'`, `$n` and the backtick-dollar form in the replacement. A new_string holding one of those
 * was silently rewritten on disk. The fix uses a replacer function, so the file must match the
 * argument byte for byte.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinToolsPlugin } from '../src/plugins/builtin-tools.ts';
import { PluginHost } from '../src/plugins/host.ts';
import { makeTempDir } from './helpers.ts';

async function withHost<T>(run: (host: PluginHost, workspace: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const host = new PluginHost();
  host.register(builtinToolsPlugin(), { workspaceRoot: workspace, dataDir: join(dir, 'data') });
  await host.start();
  try {
    return await run(host, workspace);
  } finally {
    await host.stop();
  }
}

describe('edit writes new_string literally (#301)', () => {
  test('every $ replacement pattern survives verbatim', async () => {
    await withHost(async (host, workspace) => {
      const file = join(workspace, 'notes.txt');
      writeFileSync(file, 'before\nPLACEHOLDER\nafter\n');
      // `$&` is the match, `$'` is the text after it, $` the text before it, `$1` needs a group.
      const replacement = "costs $& plus $' plus $` plus $1 plus $$";
      const result = await host.tools.invoke(
        'edit',
        { toolCallId: 'c1', input: { path: 'notes.txt', old_string: 'PLACEHOLDER', new_string: replacement } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(`before\n${replacement}\nafter\n`);
    });
  });

  test('the exact-one-occurrence check is unchanged', async () => {
    await withHost(async (host, workspace) => {
      const file = join(workspace, 'twice.txt');
      writeFileSync(file, 'a a\n');
      const result = await host.tools.invoke(
        'edit',
        { toolCallId: 'c1', input: { path: 'twice.txt', old_string: 'a', new_string: 'b' } },
        { runId: 'r' },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('edit_not_unique: old_string occurs 2 times');
      expect(readFileSync(file, 'utf8')).toBe('a a\n');
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginHost } from '../src/plugins/host.ts';
import { builtinToolsPlugin } from '../src/plugins/builtin-tools.ts';
import { makeTempDir } from './helpers.ts';

/** The four tools on a bare host: no kernel, so a 32 KiB result is a tool test, not an ingest test. */
async function runBash(command: string) {
  const workspace = join(makeTempDir(), 'ws');
  mkdirSync(workspace, { recursive: true });
  const host = new PluginHost();
  host.register(builtinToolsPlugin(), { workspaceRoot: workspace });
  await host.start();
  try {
    const result = await host.tools.invoke('bash', { toolCallId: 'c1', input: { command } }, { runId: 'r' });
    return { workspace, result };
  } finally {
    await host.stop();
  }
}

describe('bash output capping', () => {
  test('a long output is capped and the whole thing is named on disk', async () => {
    // 40 000 bytes of 'a' plus the exit line is past the 32 KiB cap.
    const { workspace, result } = await runBash("head -c 40000 /dev/zero | tr '\\0' 'a'");
    expect(result.isError).toBe(false);
    expect(result.output).toContain('[truncated ');
    const match = /full output: (\S+)\]/u.exec(result.output);
    expect(match).not.toBeNull();
    // The pointer is inside the workspace, so the `read` tool can follow it.
    expect(match![1].startsWith('.companion-shell/bash-output/')).toBe(true);
    const full = readFileSync(join(workspace, match![1]), 'utf8');
    expect(full.startsWith('exit 0\n')).toBe(true);
    expect(full.length).toBeGreaterThan(40_000);
    expect(full.endsWith('a')).toBe(true);
  }, 30_000);

  test('a short output is returned whole, with no pointer', async () => {
    const { result } = await runBash('echo short-and-complete');
    expect(result.output).toBe('exit 0\nshort-and-complete\n');
    expect(result.output).not.toContain('full output:');
  }, 30_000);
});

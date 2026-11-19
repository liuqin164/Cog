/**
 * #277: a `cogmem` invocation inside the companion must resolve the companion's own database.
 *
 * The bug was not that the CLI was wrong; it was that the CLI resolved the operator's global
 * config (`~/.cogmem/config.toml`, db `~/.cogmem/memory.db`) while the resident served
 * `<dataDir>/memory.sqlite`. The shell now writes a config for its bash children and exports it as
 * `COGMEM_CONFIG`.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };

describe('the companion CLI resolves to the companion database (#277)', () => {
  test('the shell writes a config pointing at its own db and exports it to bash', async () => {
    const dir = makeTempDir('cli-config-');
    const shell = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      const cliConfig = join(dir, 'data', 'cogmem-cli.toml');
      expect(readFileSync(cliConfig, 'utf8')).toContain(`db_path = ${JSON.stringify(shell.config.dbPath)}`);

      const printed = await shell.host.tools.invoke('bash', {
        toolCallId: 'cli-config-env',
        input: { command: 'printf %s "$COGMEM_CONFIG"' },
      }, { runId: 'cli-config-env' });
      expect(printed.isError).toBe(false);
      expect(printed.output).toBe(cliConfig);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('the CLI reads a turn the resident wrote, through the generated config', async () => {
    const dir = makeTempDir('cli-config-read-');
    const shell = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      const token = 'companion-cli-db-probe-277';
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        turnId: 'cli-config-seed',
        userText: token,
        assistantText: '记下了。',
        ingestMode: 'immediate_compile',
      });

      const home = join(dir, 'home');
      mkdirSync(home, { recursive: true });
      const memoryBin = join(import.meta.dir, '..', '..', 'src', 'bin', 'memory.ts');
      const result = spawnSync(process.execPath, ['run', memoryBin, 'search', '--query', token, '--json'], {
        cwd: shell.config.workspaceRoot,
        env: {
          ...process.env,
          HOME: home,
          COGMEM_CONFIG: join(dir, 'data', 'cogmem-cli.toml'),
          COGMEM_UPDATE_CHECK: '0',
        },
        encoding: 'utf8',
        timeout: 20_000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(token);
    } finally {
      await shell.stop();
    }
  }, 30_000);
});

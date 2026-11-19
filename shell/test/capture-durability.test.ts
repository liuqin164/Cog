import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir, spawnFixture } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };

function dayThread(shell: ReturnType<typeof makeShell>): string {
  const clock = shell.host.getService<{ localDate(at?: number): string }>('clock');
  return `companion-day:${clock.localDate()}`;
}

describe('capture writes while the run is still going (#348)', () => {
  test('a tool result is readable by mem: before agent_end, and is written once', async () => {
    const dir = makeTempDir('capture-in-run-');
    let shell!: ReturnType<typeof makeShell>;
    let probe: { eventId: string; output: string; isError: boolean; rows: string[] } | undefined;
    const provider = new ScriptedProvider([
      { text: 'running it', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: "printf 'in-run-tool-result'" } }] },
      { text: 'done', toolCalls: [] },
    ]);
    shell = makeShell(dir, provider, { dream: NO_DREAM });
    await shell.start();
    shell.host.bus.on('tool_execution_end', async () => {
        const events = shell.kernel.getThreadEvents(dayThread(shell), { projectId: shell.config.projectId, limit: 100 });
        const result = events.find((event) => event.rawEventType === 'tool_result')!;
        const read = await shell.host.tools.invoke('read', { toolCallId: 'probe', input: { path: `mem:${result.eventId}` } }, { runId: 'probe' });
        probe = {
          eventId: result.eventId,
          output: read.output,
          isError: read.isError,
          rows: events.map((event) => `${event.rawEventType}:${event.role}`),
        };
    });
    try {
      await shell.submit('run it');
      expect(probe).toBeDefined();
      expect(probe!.isError).toBe(false);
      expect(probe!.output).toBe('in-run-tool-result');
      expect(probe!.rows).toEqual(['message:user', 'message:assistant', 'tool_call:assistant', 'tool_result:tool']);

      const rows = shell.kernel.getThreadEvents(dayThread(shell), { projectId: shell.config.projectId, limit: 100 });
      expect(rows.filter((event) => event.rawEventType === 'message' && event.role === 'user')).toHaveLength(1);
      expect(rows.filter((event) => event.rawEventType === 'tool_result')).toHaveLength(1);
      expect(rows.filter((event) => event.rawEventType === 'message' && event.role === 'assistant')).toHaveLength(2);
      expect(shell.trace.read().filter((record) => record.kind === 'capture_run')).toHaveLength(1);
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('a kill after a finished tool leaves the interrupted turn in the session view', async () => {
    const dir = makeTempDir('capture-kill-');
    const first = spawnFixture('shell-kill-process.ts', [dir, 'tool-complete']);
    try {
      await first.waitFor('idle');
      await first.waitFor('second_call');
      first.child.kill('SIGKILL');
      await first.exited();
    } finally {
      if (!first.child.killed) first.child.kill('SIGKILL');
    }

    const recovered = spawnFixture('shell-kill-process.ts', [dir, 'recover']);
    const report = await recovered.waitFor('recovered');
    await recovered.exited();

    expect(report.state).toBe('IDLE');
    expect(report.sessionTurns).toContainEqual(expect.objectContaining({ role: 'user', text: 'run a tool' }));
    const results = report.ledgerRows.filter((row: { rawEventType: string }) => row.rawEventType === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('kill-tool-result-marker');
    expect(report.toolResultRead).toBe('kill-tool-result-marker');
    expect(report.ledgerRows.filter((row: { rawEventType: string; role: string }) => row.rawEventType === 'message' && row.role === 'user')).toHaveLength(1);
  }, 60_000);
});

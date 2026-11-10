import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionShell } from '../src/app.ts';
import { SecretRedactor } from '../src/kernel-host.ts';
import { ScriptedProvider, makeTempDir } from './helpers.ts';

const FAKE_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const FAKE_KEY_2 = 'sk-ZZZZYYYYXXXXWWWWVVVVUUUU';
const FAKE_PASSWORD = 'hunter2hunter2';
const FAKE_BEARER = 'Bearer abcdef1234567890token';

function makeShell(dir: string, provider: ScriptedProvider) {
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
    },
    modelProvider: provider,
    tick: false,
  });
}

function payloadTexts(shell: CompanionShell, threadId: string): string[] {
  return shell.kernel
    .getThreadEvents(threadId, { projectId: shell.config.projectId, limit: 500 })
    .map((event) => JSON.stringify(event.payload ?? {}));
}

describe('secret discipline: everything captured goes through the kernel redacted and marked', () => {
  test('a bash tool output holding a key reaches the ledger only as its redacted form', async () => {
    const dir = makeTempDir();
    const workspace = join(dir, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'secret.txt'), `API_KEY=${FAKE_KEY}\npassword = "${FAKE_PASSWORD}"\n`, 'utf8');
    const provider = new ScriptedProvider([
      { text: 'reading the file', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'cat secret.txt' } }] },
      { text: 'I read it', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      const clock = shell.host.getService<{ localDate(at?: number): string }>('clock');
      const threadId = `companion-day:${clock.localDate()}`;
      const summary = await shell.submit('看看那个文件');
      expect(summary!.toolResults[0].isError).toBe(false);
      const texts = payloadTexts(shell, threadId);
      expect(texts.join('\n')).not.toContain(FAKE_KEY);
      expect(texts.join('\n')).not.toContain(FAKE_PASSWORD);
      expect(texts.join('\n')).toContain('REDACTED');
      const marked = shell.kernel
        .getThreadEvents(threadId, { projectId: shell.config.projectId, limit: 500 })
        .some((event) => Number((event.payload as { metadata?: { secretFindings?: { total?: number } } }).metadata?.secretFindings?.total ?? 0) > 0);
      expect(marked).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('a terminal record and a terminal turn are redacted the same way', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'noted', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    await shell.start();
    try {
      const clock = shell.host.getService<{ localDate(at?: number): string }>('clock');
      const threadId = `companion-day:${clock.localDate()}`;
      await shell.submit(`帮我看下这个 ${FAKE_KEY_2} 和 ${FAKE_BEARER}`);
      const capture = shell.host.getService<{ captureTerminalRecord(text: string, threadId: string, title?: string): Promise<unknown> }>('capture');
      await capture.captureTerminalRecord(`Authorization: ${FAKE_BEARER}`, threadId, 'terminal transcript');
      const texts = payloadTexts(shell, threadId);
      expect(texts.join('\n')).not.toContain(FAKE_KEY_2);
      expect(texts.join('\n')).not.toContain('abcdef1234567890token');
      expect(texts.join('\n')).toContain('REDACTED');
    } finally {
      await shell.stop();
    }
  });

  test('the redactor is the kernel table: it reports the count it removed', () => {
    const redactor = new SecretRedactor();
    const result = redactor.mark(`API_KEY=${FAKE_KEY} and password = "${FAKE_PASSWORD}"`);
    expect(result.value).not.toContain(FAKE_KEY);
    expect(result.value).not.toContain(FAKE_PASSWORD);
    expect(result.metadata.secretFindings).toEqual({ total: (result.metadata.secretFindings as { total: number }).total });
    expect((result.metadata.secretFindings as { total: number }).total).toBeGreaterThanOrEqual(2);
  });
});

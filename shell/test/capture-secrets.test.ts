import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionShell } from '../src/app.ts';
import { SecretRedactor } from '../src/kernel-host.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const FAKE_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const FAKE_KEY_2 = 'sk-ZZZZYYYYXXXXWWWWVVVVUUUU';
const FAKE_PASSWORD = 'hunter2hunter2';
const FAKE_BEARER = 'Bearer abcdef1234567890token';

// The stage-1.5 shapes: a credential URL, an AWS literal inside a multi-line dump, a bearer header
// and a whole private-key block. Each has a unique marker so an assertion can tell which one leaked.
const FAKE_CONNECTION = 'postgres://companion:s3cretPass9911@db.internal:5432/memory';
const FAKE_AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const FAKE_BEARER_2 = 'Bearer zzQ9token9911abcdefghijkl';
const FAKE_PRIVATE_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAx7Zq8mQvN3sTpLdW1yVk9bRf4hJ2mC5nQ8wX1zA6oP',
  '-----END RSA PRIVATE KEY-----',
].join('\n');
const SECRETS_ENV = [
  '# companion secrets fixture',
  `DATABASE_URL=${FAKE_CONNECTION}`,
  `AWS_SECRET_ACCESS_KEY=${FAKE_AWS_SECRET}`,
  `Authorization: ${FAKE_BEARER_2}`,
  FAKE_PRIVATE_KEY,
  '',
].join('\n');

function payloadTexts(shell: CompanionShell, threadId: string): string[] {
  return shell.kernel
    .getThreadEvents(threadId, { projectId: shell.config.projectId, limit: 500 })
    .map((event) => JSON.stringify(event.payload ?? {}));
}

describe('secret discipline: everything captured goes through the kernel redacted and marked', () => {
  test('a bash tool output holding a key reaches the ledger only as its redacted form', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([
      { text: 'reading the file', toolCalls: [{ toolCallId: 'c1', toolName: 'bash', input: { command: 'cat secret.txt' } }] },
      { text: 'I read it', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider);
    writeFileSync(join(dir, 'ws', 'secret.txt'), `API_KEY=${FAKE_KEY}\npassword = "${FAKE_PASSWORD}"\n`, 'utf8');
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

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialService } from '../src/credentials.ts';
import { TraceLog } from '../src/trace.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const NO_DREAM = { windowStartHour: 0, windowEndHour: 1, runKernelNight: false, maxEpisodes: 5 };
const PASSWORD = 'demo-password-9f3a';
const ACCOUNT = 'owner-account-77c1';

function traceKinds(shell: ReturnType<typeof makeShell>, kind: string): Array<Record<string, unknown>> {
  return shell.trace.read().filter((record) => record.kind === kind);
}

describe('the credential input surface', () => {
  test('a work run asks, the terminal answers, bash uses it, and no raw value reaches ledger, log or model', async () => {
    const dir = makeTempDir('credential-e2e-');
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [{
          toolCallId: 'c1',
          toolName: 'request_credential',
          input: {
            service: 'demo-api',
            purpose: '完成一次演示任务',
            fields: [{ name: 'account', label: '账号' }, { name: 'password', label: '密码', secret: true }],
          },
        }],
      },
      {
        text: '',
        toolCalls: [{
          toolCallId: 'c2',
          toolName: 'bash',
          input: {
            credential: 'demo-api',
            command: 'test -n "$COGMEM_CRED_DEMO_API_PASSWORD" && test -n "$COGMEM_CRED_DEMO_API_ACCOUNT" && echo authenticated',
          },
        }],
      },
      { text: '已用凭据完成任务。', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider, { dream: NO_DREAM });
    await shell.start();
    try {
      const run = shell.submit('请用 demo-api 完成一次任务');
      await waitUntil(() => shell.credentials.pending().length === 1);
      const request = shell.credentials.pending()[0]!;
      expect(request.service).toBe('demo-api');
      expect(request.fields.map((field) => field.name)).toEqual(['account', 'password']);
      const saved = shell.submitCredential(request.id, { account: ACCOUNT, password: PASSWORD }, 'terminal');
      expect(saved).toEqual({ ok: true, ref: 'demo-api' });
      await run;

      expect(traceKinds(shell, 'credential_saved')).toHaveLength(1);
      expect(traceKinds(shell, 'credential_used')).toEqual([
        expect.objectContaining({ ref: 'demo-api', service: 'demo-api', caller: 'bash' }),
      ]);
      const storage = join(shell.config.dataDir, 'credentials.json');
      expect(statSync(storage).mode & 0o777).toBe(0o600);
      expect(readFileSync(storage, 'utf8')).toContain(PASSWORD);

      const trace = readFileSync(shell.trace.path, 'utf8');
      const model = JSON.stringify(provider.calls);
      const db = new Database(shell.config.dbPath, { readonly: true });
      const ledger = (db.query('SELECT payload_json FROM memory_events').all() as Array<{ payload_json: string }>)
        .map((row) => row.payload_json)
        .join('\n');
      db.close();
      for (const surface of [trace, model, ledger, JSON.stringify(shell.credentials.pending())]) {
        expect(surface).not.toContain(PASSWORD);
        expect(surface).not.toContain(ACCOUNT);
      }
    } finally {
      await shell.stop();
    }
  });

  test('a channel submission is refused, keeps no value, and leaves no storage file', async () => {
    const dir = makeTempDir('credential-channel-');
    const trace = new TraceLog(dir);
    const service = new CredentialService(dir, trace, () => 1_000, () => true, () => {});
    const run = service.request({
      service: 'channel-demo',
      purpose: '负例',
      fields: [{ name: 'password', secret: true }],
    });
    const request = service.pending()[0]!;
    expect(service.submit(request.id, { password: 'channel-secret-4b2d' }, 'channel')).toEqual({
      ok: false,
      reason: 'channel_collection_refused',
    });
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
    expect(JSON.stringify(trace.read())).not.toContain('channel-secret-4b2d');
    expect(trace.read().some((record) => record.kind === 'credential_submit_refused')).toBe(true);
    service.cancel(request.id);
    expect(await run).toEqual({ outcome: 'cancelled' });
  });

  test('revocation makes the next use fail immediately and records the refusal', async () => {
    const dir = makeTempDir('credential-revoke-');
    const trace = new TraceLog(dir);
    const service = new CredentialService(dir, trace, () => 2_000, () => true, () => {});
    const run = service.request({
      service: 'revoke-demo',
      purpose: '撤销',
      fields: [{ name: 'token', secret: true }],
    });
    const request = service.pending()[0]!;
    expect(service.submit(request.id, { token: 'token-before-revoke' }, 'web')).toEqual({ ok: true, ref: 'revoke-demo' });
    expect(await run).toEqual({ outcome: 'saved', ref: 'revoke-demo' });
    expect(service.use('revoke-demo', 'bash')).toEqual({ token: 'token-before-revoke' });
    expect(service.revoke('revoke-demo')).toBe(true);
    expect(() => service.use('revoke-demo', 'bash')).toThrow('credential_not_found');
    const refusals = trace.read().filter((record) => record.kind === 'credential_use_refused');
    expect(refusals).toEqual([expect.objectContaining({ ref: 'revoke-demo', caller: 'bash', reason: 'not_found' })]);
    expect(JSON.stringify(trace.read())).not.toContain('token-before-revoke');
  });
});

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialService, maskCredentialValues } from '../src/credentials.ts';
import { bwrapUsable } from '../src/plugins/builtin-tools.ts';
import { TraceLog } from '../src/trace.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const NO_DREAM = { windowStartHour: 0, windowEndHour: 1, runKernelNight: false, maxEpisodes: 5 };
const PASSWORD = 'demo-password-9f3a!@#';
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

  test('echoed credential values are masked in the result, ledger, FTS, trace and the overflow file', async () => {
    const dir = makeTempDir('credential-echo-');
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [{
          toolCallId: 'c1',
          toolName: 'request_credential',
          input: {
            service: 'demo-api',
            purpose: '验证输出抹除',
            fields: [{ name: 'account' }, { name: 'password', secret: true }],
          },
        }],
      },
      {
        text: '',
        toolCalls: [
          {
            toolCallId: 'c2',
            toolName: 'bash',
            input: { credential: 'demo-api', command: 'printf "%s\\n" "$COGMEM_CRED_DEMO_API_PASSWORD" "$COGMEM_CRED_DEMO_API_ACCOUNT"' },
          },
          {
            toolCallId: 'c3',
            toolName: 'bash',
            input: {
              credential: 'demo-api',
              command: 'for i in $(seq 1 2000); do printf "%s-%s-padding-padding-padding\\n" "$COGMEM_CRED_DEMO_API_PASSWORD" "$i"; done',
            },
          },
        ],
      },
      { text: '已检查。', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider, { dream: NO_DREAM });
    await shell.start();
    try {
      const run = shell.submit('回显凭据做检查');
      await waitUntil(() => shell.credentials.pending().length === 1);
      const request = shell.credentials.pending()[0]!;
      expect(shell.submitCredential(request.id, { account: ACCOUNT, password: PASSWORD }, 'terminal')).toEqual({ ok: true, ref: 'demo-api' });
      await run;

      const model = JSON.stringify(provider.calls);
      expect(model).toContain('«credential:demo-api.password»');
      expect(model).toContain('«credential:demo-api.account»');

      const trace = readFileSync(shell.trace.path, 'utf8');
      expect(trace).toContain('credential_value_masked');

      const db = new Database(shell.config.dbPath, { readonly: true });
      const ledger = (db.query('SELECT payload_json FROM memory_events').all() as Array<{ payload_json: string }>)
        .map((row) => row.payload_json)
        .join('\n');
      const fts = (db.query('SELECT text FROM memory_events_fts').all() as Array<{ text: string }>)
        .map((row) => row.text)
        .join('\n');
      db.close();

      const overflowDir = join(shell.config.workspaceRoot, '.cogmem-shell', 'bash-output');
      const overflow = readdirSync(overflowDir).map((name) => readFileSync(join(overflowDir, name), 'utf8')).join('\n');
      expect(overflow).toContain('«credential:demo-api.password»');

      for (const surface of [model, trace, ledger, fts, overflow]) {
        expect(surface).not.toContain(PASSWORD);
        expect(surface).not.toContain(ACCOUNT);
      }
    } finally {
      await shell.stop();
    }
  }, 30_000);

  test('http_request sends a stored credential from the host while bash stays offline under bwrap', async () => {
    const dir = makeTempDir('credential-http-');
    const sandboxed = bwrapUsable();
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const authorization = request.headers.get('authorization') ?? '';
        seen.push(authorization);
        if (authorization !== `Bearer ${PASSWORD}`) return new Response('unauthorized', { status: 401 });
        return Response.json({
          account: ACCOUNT,
          echo: [PASSWORD, Buffer.from(PASSWORD).toString('base64'), encodeURIComponent(PASSWORD)],
        });
      },
    });
    const url = `http://127.0.0.1:${server.port}/check`;
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [{
          toolCallId: 'c1',
          toolName: 'request_credential',
          input: {
            service: 'demo-api',
            purpose: '完成一次带凭据的请求',
            fields: [{ name: 'account' }, { name: 'password', secret: true }],
          },
        }],
      },
      {
        text: '',
        toolCalls: [
          {
            toolCallId: 'c2',
            toolName: 'bash',
            input: { credential: 'demo-api', command: `curl -sS --max-time 5 ${url}` },
          },
          {
            toolCallId: 'c3',
            toolName: 'http_request',
            input: {
              credentialRef: 'demo-api',
              url,
              headers: { Authorization: 'Bearer {{password}}', 'X-Account': '{{account}}' },
            },
          },
        ],
      },
      { text: '已完成。', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider, { dream: NO_DREAM });
    await shell.start();
    try {
      const run = shell.submit('用 demo-api 完成一次请求');
      await waitUntil(() => shell.credentials.pending().length === 1);
      const request = shell.credentials.pending()[0]!;
      expect(shell.submitCredential(request.id, { account: ACCOUNT, password: PASSWORD }, 'terminal')).toEqual({ ok: true, ref: 'demo-api' });
      await run;

      const tools = provider.calls.flatMap((call) => call.messages).filter((message) => message.role === 'tool');
      const bash = tools.find((message) => message.toolName === 'bash')!;
      const http = tools.find((message) => message.toolName === 'http_request')!;
      expect(bash.isError).toBe(sandboxed);
      if (sandboxed) expect(bash.content).toMatch(/Could not connect|Failed to connect|Connection refused|exit code 7/u);
      expect(http.isError).toBe(false);
      expect(http.content).toContain('HTTP 200');
      expect(http.content).toContain('«credential:demo-api.password»');
      expect(http.content).toContain('«credential:demo-api.account»');
      expect(seen).toContain(`Bearer ${PASSWORD}`);
      if (sandboxed) expect(seen).toEqual([`Bearer ${PASSWORD}`]);
      expect(traceKinds(shell, 'credential_used')).toContainEqual(
        expect.objectContaining({ ref: 'demo-api', service: 'demo-api', caller: 'http_request' }),
      );

      const model = JSON.stringify(provider.calls);
      const trace = readFileSync(shell.trace.path, 'utf8');
      const db = new Database(shell.config.dbPath, { readonly: true });
      const ledger = (db.query('SELECT payload_json FROM memory_events').all() as Array<{ payload_json: string }>)
        .map((row) => row.payload_json)
        .join('\n');
      const fts = (db.query('SELECT text FROM memory_events_fts').all() as Array<{ text: string }>)
        .map((row) => row.text)
        .join('\n');
      db.close();
      const overflowDir = join(shell.config.workspaceRoot, '.cogmem-shell', 'bash-output');
      const overflow = existsSync(overflowDir)
        ? readdirSync(overflowDir).map((name) => readFileSync(join(overflowDir, name), 'utf8')).join('\n')
        : '';
      const logFiles = readdirSync(shell.config.dataDir)
        .filter((name) => name.endsWith('.jsonl') || name.endsWith('.log'))
        .map((name) => readFileSync(join(shell.config.dataDir, name), 'utf8'))
        .join('\n');

      for (const surface of [model, trace, ledger, fts, overflow, logFiles]) {
        expect(surface).not.toContain(PASSWORD);
        expect(surface).not.toContain(ACCOUNT);
        expect(surface).not.toContain(Buffer.from(PASSWORD).toString('base64'));
        expect(surface).not.toContain(encodeURIComponent(PASSWORD));
        expect(surface).not.toContain(Buffer.from(ACCOUNT).toString('base64'));
        expect(surface).not.toContain(encodeURIComponent(ACCOUNT));
      }
    } finally {
      server.stop(true);
      await shell.stop();
    }
  }, 30_000);

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

  test('masking covers base64 and URL encodings and leaves short values alone', () => {
    const value = 'p@ss word!';
    const masked = maskCredentialValues(`a=${value} b=${Buffer.from(value).toString('base64')} c=${encodeURIComponent(value)}`, [
      { ref: 'demo', field: 'password', value },
    ]);
    expect(masked.hits).toBe(3);
    expect(masked.text).toBe('a=«credential:demo.password» b=«credential:demo.password» c=«credential:demo.password»');
    expect(maskCredentialValues('pin 1234', [{ ref: 'demo', field: 'pin', value: '123' }]).text).toBe('pin 1234');
  });
});

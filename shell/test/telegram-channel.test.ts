import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pluginWorkspaceDir } from '../src/plugins/self-install.ts';
import { readPluginRegistry, writePluginRegistry } from '../src/plugins/registry.ts';
import type { ChannelRegistry } from '../src/channels/registry.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };
const TOKEN = '123456:fake-token';
const OBSERVATORY_TOKEN = 'telegram-observatory-token';
const OWNER = 9001;
const STRANGER = 9002;

interface Sent {
  method: string;
  body: any;
}

function startFakeTelegram() {
  const sent: Sent[] = [];
  const updates: any[] = [];
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const method = url.pathname.split('/').pop() ?? '';
      const body = request.method === 'POST' ? await request.json() as Record<string, unknown> : {};
      calls += 1;
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        if (!updates.some((update) => update.update_id >= offset)) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return Response.json({ ok: true, result: updates.filter((update) => update.update_id >= offset) });
      }
      sent.push({ method, body });
      return Response.json({ ok: true, result: true });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    sent,
    push(update: Record<string, unknown>): void {
      updates.push(update);
    },
    clear(): void {
      updates.length = 0;
    },
    calls: () => calls,
    stop: () => server.stop(true),
  };
}

function writeConfig(dataDir: string, apiBase: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'telegram-channel.json'),
    JSON.stringify({ apiBase }),
    { mode: 0o600 },
  );
  writeFileSync(join(dataDir, 'observatory-token'), `${OBSERVATORY_TOKEN}\n`, { mode: 0o600 });
}

function makeTelegramShell(dir: string, provider: ScriptedProvider, dataDir: string, extra: Record<string, unknown> = {}, options: any = {}) {
  return makeShell(dir, provider, {
    dataDir,
    dbPath: join(dataDir, 'memory.sqlite'),
    plugins: ['builtin:telegram-channel'],
    dream: NO_DREAM,
    http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    ...extra,
  }, options);
}

function post(base: string, path: string, body: unknown, token = OBSERVATORY_TOKEN): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-observatory-token': token },
    body: JSON.stringify(body),
  });
}

async function channelCards(base: string): Promise<Array<{ id: string; state: string; pairingCode?: string; config: unknown[] }>> {
  const response = await fetch(`${base}/observatory/channels`, { headers: { 'x-observatory-token': OBSERVATORY_TOKEN } });
  const body = await response.json() as { channels: Array<{ id: string; state: string; pairingCode?: string; config: unknown[] }> };
  return body.channels;
}

async function channelState(base: string): Promise<{ state: string; pairingCode?: string }> {
  return (await channelCards(base)).find((entry) => entry.id === 'telegram')!;
}

async function uiContributions(base: string): Promise<Array<{ id: string; slot: string; channelId?: string; nodes: any[] }>> {
  const response = await fetch(`${base}/observatory/ui`, { headers: { 'x-observatory-token': OBSERVATORY_TOKEN } });
  return (await response.json() as { contributions: Array<{ id: string; slot: string; channelId?: string; nodes: any[] }> }).contributions;
}

async function waitChannelState(base: string, wanted: string): Promise<{ state: string; pairingCode?: string }> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const card = await channelState(base);
    if (card.state === wanted) return card;
    if (Date.now() > deadline) throw new Error(`timeout waiting for channel state ${wanted}; saw ${card.state}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function connectTelegram(base: string, fake: ReturnType<typeof startFakeTelegram>, updateId = 1): Promise<void> {
  const begun = await post(base, '/observatory/channels/telegram/begin', {});
  expect(begun.status).toBe(200);
  const { requestId } = await begun.json() as { requestId: string };
  const form = (await uiContributions(base)).find((entry) => entry.id === 'telegram-channel-settings')?.nodes.find((node) => node.type === 'credential-form');
  expect(form).toMatchObject({ requestId, fields: [{ name: 'token', label: 'Bot Token', secret: true }] });
  const submitted = await post(base, '/observatory/credentials/submit', { id: requestId, values: { token: TOKEN } });
  expect(submitted.status).toBe(200);
  const saved = await submitted.json() as { ok: boolean; ref: string };
  expect(saved.ok).toBe(true);
  const started = await post(base, '/observatory/channels/telegram/start', { ref: saved.ref });
  expect(started.status).toBe(200);
  const startedBody = await started.json() as { ok: boolean };
  expect(startedBody.ok).toBe(true);
  const pairing = await waitChannelState(base, 'pairing');
  const code = pairing.pairingCode!;
  expect((await uiContributions(base)).find((entry) => entry.id === 'telegram-channel-settings')?.nodes.some((node) => node.type === 'code' && node.text === code)).toBe(true);
  fake.push({ update_id: updateId, message: { text: code, chat: { id: OWNER }, from: { id: OWNER } } });
  await waitChannelState(base, 'connected');
}

describe('telegram channel plugin (F12)', () => {
  test('connect through the Web channel page, pair the owner, talk, disconnect, and reconnect', async () => {
    const fake = startFakeTelegram();
    const dir = makeTempDir('telegram-channel-');
    const dataDir = join(dir, 'data');
    writeConfig(dataDir, fake.base);
    writePluginRegistry(dataDir, ['builtin:telegram-channel']);
    const provider = new ScriptedProvider([{ text: '你好', toolCalls: [] }, { text: '又见面了', toolCalls: [] }]);
    const shell = makeTelegramShell(dir, provider, dataDir);
    await shell.start();
    const base = shell.httpUrl!;
    try {
      expect((await channelState(base)).state).toBe('disconnected');
      expect((await fetch(`${base}/observatory/channels`)).status).toBe(403);
      expect(await (await fetch(`${base}/observatory/`)).text()).toContain('id="tab-channels"');
      expect((await post(base, '/observatory/channels/telegram/begin', {}, '')).status).toBe(403);

      await connectTelegram(base, fake);
      fake.push({ update_id: 2, message: { text: '你好', chat: { id: OWNER }, from: { id: OWNER } } });
      await waitUntil(() => fake.sent.some((entry) => entry.method === 'sendMessage' && entry.body.text === '你好'));
      expect(shell.trace.read().some((record) => record.kind === 'telegram_ingress_failed')).toBe(false);

      const storage = join(dataDir, 'credentials.json');
      expect(readFileSync(storage, 'utf8')).toContain(TOKEN);
      expect(statSync(storage).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dataDir, 'telegram-channel.json'), 'utf8')).not.toContain(TOKEN);
      expect(JSON.stringify(shell.trace.read())).not.toContain(TOKEN);
      expect(JSON.stringify(provider.calls)).not.toContain(TOKEN);
      const ledgerText = (shell.kernel as any).eventStore.queryEvents(1, 1000, { projectId: [shell.config.projectId] })
        .records.map((record: any) => JSON.stringify(record.payload ?? {})).join('\n');
      expect(ledgerText).not.toContain(TOKEN);
      expect(await (await fetch(`${base}/observatory/channels`)).text()).not.toContain(TOKEN);
      expect(await (await fetch(`${base}/observatory/app.js`)).text()).not.toContain(TOKEN);

      const ledgerBefore = (shell.kernel as any).eventStore.queryEvents(1, 1, { projectId: [shell.config.projectId] }).total;
      expect((await post(base, '/observatory/channels/telegram/disconnect', {})).status).toBe(200);
      expect((await channelState(base)).state).toBe('disconnected');
      expect(readFileSync(storage, 'utf8')).not.toContain(TOKEN);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const callsAfterStop = fake.calls();
      const sentAfterStop = fake.sent.length;
      fake.push({ update_id: 3, message: { text: '还在吗', chat: { id: OWNER }, from: { id: OWNER } } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.calls()).toBe(callsAfterStop);
      expect(fake.sent.length).toBe(sentAfterStop);
      const ledgerAfter = (shell.kernel as any).eventStore.queryEvents(1, 1, { projectId: [shell.config.projectId] }).total;
      expect(ledgerAfter).toBe(ledgerBefore);

      await connectTelegram(base, fake, 100);
      fake.push({ update_id: 101, message: { text: '重连了吗', chat: { id: OWNER }, from: { id: OWNER } } });
      await waitUntil(() => fake.sent.some((entry) => entry.method === 'sendMessage' && entry.body.text === '又见面了'));
      expect(readPluginRegistry(dataDir)).toContain('builtin:telegram-channel');

      expect((await (await fetch(`${base}/observatory/app.js`)).text()).toLowerCase()).not.toContain('telegram');
      expect((await (await fetch(`${base}/observatory/`)).text()).toLowerCase()).not.toContain('telegram');
      const registry = shell.host.getService<ChannelRegistry>('channelRegistry');
      const unregister = registry.register({
        id: 'fake-channel',
        name: 'Fake',
        config: [{ name: 'apiKey', label: 'API Key', secret: true }],
        status: () => ({ state: 'connected', detail: 'fake' }),
        begin: () => ({ ok: true, requestId: 'request-1' }),
        start: () => ({ ok: true }),
        disconnect: () => ({ ok: true }),
      });
      expect((await channelCards(base)).find((card) => card.id === 'fake-channel')?.config).toEqual([{ name: 'apiKey', label: 'API Key', secret: true }]);
      unregister();
      expect((await channelCards(base)).some((card) => card.id === 'fake-channel')).toBe(false);

      await shell.pluginsAdmin.removePlugin('builtin:telegram-channel');
      await waitUntil(() => shell.trace.read().some((record) => record.kind === 'plugin_removed'));
      expect((await channelCards(base)).some((card) => card.id === 'telegram')).toBe(false);
      expect((await uiContributions(base)).some((entry) => entry.id === 'telegram-channel-settings')).toBe(false);
    } finally {
      await shell.stop();
    }

    fake.clear();
    writePluginRegistry(dataDir, ['builtin:telegram-channel']);
    const reinstalled = makeTelegramShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), dataDir);
    await reinstalled.start();
    try {
      expect((await channelCards(reinstalled.httpUrl!)).some((card) => card.id === 'telegram')).toBe(true);
      expect((await channelState(reinstalled.httpUrl!)).state).toBe('connected');
      expect((await uiContributions(reinstalled.httpUrl!)).some((entry) => entry.id === 'telegram-channel-settings')).toBe(true);
    } finally {
      await reinstalled.stop();
      fake.stop();
    }
  }, 60_000);

  test('only the configured owner callback approves; a stranger callback is refused and recorded', async () => {
    const fake = startFakeTelegram();
    const dir = makeTempDir('telegram-approval-');
    const dataDir = join(dir, 'data');
    writeConfig(dataDir, fake.base);
    writePluginRegistry(dataDir, ['builtin:telegram-channel']);
    const shell = makeTelegramShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), dataDir);
    await shell.start();
    const base = shell.httpUrl!;
    try {
      await connectTelegram(base, fake);
      const sourcePath = join(pluginWorkspaceDir(dataDir), 'echo', 'index.ts');
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, "export default { name: 'echo-plugin', apply() {} };\n");
      const proposal = shell.pluginProposals.propose({
        name: 'echo-plugin',
        purpose: '测试提案卡',
        permissions: { provide: [], inject: [], data: [] },
        sourcePath,
      });
      expect(proposal.accepted).toBe(true);
      const id = proposal.proposal!.id;
      await waitUntil(() => fake.sent.some((entry) => entry.method === 'sendMessage' && Array.isArray(entry.body.reply_markup?.inline_keyboard)));

      fake.push({ update_id: 2, callback_query: { id: 'cb-stranger', data: `confirm:${id}`, from: { id: STRANGER } } });
      await waitUntil(() => fake.sent.some((entry) => entry.method === 'answerCallbackQuery' && entry.body.callback_query_id === 'cb-stranger'));
      expect(readPluginRegistry(dataDir)).toEqual(['builtin:telegram-channel']);
      expect(shell.trace.read()).toContainEqual(expect.objectContaining({ kind: 'telegram_approval_refused', accountId: String(STRANGER), data: `confirm:${id}` }));

      fake.push({ update_id: 3, callback_query: { id: 'cb-owner', data: `confirm:${id}`, from: { id: OWNER } } });
      await waitUntil(() => readPluginRegistry(dataDir).includes(sourcePath));
      expect(shell.trace.read()).toContainEqual(expect.objectContaining({ kind: 'telegram_approval', accountId: String(OWNER), id, action: 'confirm', ok: true }));
      await waitUntil(() => fake.sent.some((entry) => entry.method === 'answerCallbackQuery' && entry.body.callback_query_id === 'cb-owner'));
    } finally {
      await shell.stop();
      fake.stop();
    }
  }, 60_000);

  test('surfacing is delivered through the channel and stays silent inside the quiet window', async () => {
    const fake = startFakeTelegram();
    const dir = makeTempDir('telegram-surfacing-');
    const dataDir = join(dir, 'data');
    writeConfig(dataDir, fake.base);
    writePluginRegistry(dataDir, ['builtin:telegram-channel']);
    let now = Date.UTC(2026, 0, 1, 12, 0);
    const shell = makeTelegramShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), dataDir, {
      quiet: { startHour: 23, endHour: 7 },
    }, { now: () => now });
    await shell.start();
    const base = shell.httpUrl!;
    try {
      await connectTelegram(base, fake);
      await shell.host.bus.emit('companion_emergence', { id: 'surfacing:commitment:day', text: '该交周报了', reason: '承诺到期' });
      await waitUntil(() => fake.sent.some((entry) => entry.method === 'sendMessage' && entry.body.text === '该交周报了'));

      now = Date.UTC(2026, 0, 1, 23, 30);
      await shell.host.bus.emit('companion_emergence', { id: 'surfacing:commitment:night', text: '夜里不说', reason: '承诺到期' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fake.sent.some((entry) => entry.method === 'sendMessage' && entry.body.text === '夜里不说')).toBe(false);
      expect(shell.trace.read()).toContainEqual(expect.objectContaining({ kind: 'telegram_surfacing_quiet', candidateId: 'surfacing:commitment:night' }));
    } finally {
      await shell.stop();
      fake.stop();
    }
  }, 60_000);
});

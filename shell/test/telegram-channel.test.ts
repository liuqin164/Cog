import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CredentialVault } from '../src/credentials.ts';
import { pluginWorkspaceDir } from '../src/plugins/self-install.ts';
import { readPluginRegistry, writePluginRegistry } from '../src/plugins/registry.ts';
import { TraceLog } from '../src/trace.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };
const TOKEN = '123456:fake-token';
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
    calls: () => calls,
    stop: () => server.stop(true),
  };
}

function writeConfig(dataDir: string, apiBase: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'telegram-channel.json'),
    JSON.stringify({ credential: 'telegram-bot', ownerId: OWNER, apiBase }),
    { mode: 0o600 },
  );
  const vault = new CredentialVault(dataDir, new TraceLog(dataDir), () => Date.now());
  vault.save('telegram-bot', [{ name: 'token', label: 'Bot token', secret: true }], { token: TOKEN });
}

function makeTelegramShell(dir: string, provider: ScriptedProvider, dataDir: string, extra: Record<string, unknown> = {}, options: any = {}) {
  return makeShell(dir, provider, {
    dataDir,
    dbPath: join(dataDir, 'memory.sqlite'),
    plugins: ['builtin:telegram-channel'],
    dream: NO_DREAM,
    ...extra,
  }, options);
}

describe('telegram channel plugin (F12)', () => {
  test('owner message goes through ingest and submit to a Telegram reply, and removal stops polling and sending', async () => {
    const fake = startFakeTelegram();
    const dir = makeTempDir('telegram-channel-');
    const dataDir = join(dir, 'data');
    writeConfig(dataDir, fake.base);
    writePluginRegistry(dataDir, ['builtin:telegram-channel']);
    const provider = new ScriptedProvider([{ text: '你好', toolCalls: [] }]);
    const shell = makeTelegramShell(dir, provider, dataDir);
    await shell.start();
    try {
      fake.push({ update_id: 1, message: { text: '你好', chat: { id: OWNER }, from: { id: OWNER } } });
      await waitUntil(() => fake.sent.some((entry) => entry.method === 'sendMessage' && entry.body.text === '你好'));
      expect(shell.trace.read().some((record) => record.kind === 'telegram_ingress_failed')).toBe(false);

      const ledgerBefore = (shell.kernel as any).eventStore.queryEvents(1, 1, { projectId: [shell.config.projectId] }).total;
      await shell.pluginsAdmin.removePlugin('builtin:telegram-channel');
      await waitUntil(() => shell.trace.read().some((record) => record.kind === 'plugin_removed'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const callsAfterStop = fake.calls();
      const sentAfterStop = fake.sent.length;
      fake.push({ update_id: 2, message: { text: '还在吗', chat: { id: OWNER }, from: { id: OWNER } } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.calls()).toBe(callsAfterStop);
      expect(fake.sent.length).toBe(sentAfterStop);
      const ledgerAfter = (shell.kernel as any).eventStore.queryEvents(1, 1, { projectId: [shell.config.projectId] }).total;
      expect(ledgerAfter).toBe(ledgerBefore);
    } finally {
      await shell.stop();
      fake.stop();
    }

    const reinstallFake = startFakeTelegram();
    writeConfig(dataDir, reinstallFake.base);
    writePluginRegistry(dataDir, ['builtin:telegram-channel']);
    const reinstalled = makeTelegramShell(dir, new ScriptedProvider([{ text: '又见面了', toolCalls: [] }]), dataDir);
    await reinstalled.start();
    try {
      reinstallFake.push({ update_id: 1, message: { text: '重装了吗', chat: { id: OWNER }, from: { id: OWNER } } });
      await waitUntil(() => reinstallFake.sent.some((entry) => entry.method === 'sendMessage' && entry.body.text === '又见面了'));
      expect(readPluginRegistry(dataDir)).toContain('builtin:telegram-channel');
    } finally {
      await reinstalled.stop();
      reinstallFake.stop();
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
    try {
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
    try {
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

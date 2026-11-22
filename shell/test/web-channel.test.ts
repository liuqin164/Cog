import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AttachClient } from '../src/attach/client.ts';
import { pluginWorkspaceDir } from '../src/plugins/self-install.ts';
import { readPluginRegistry, writePluginRegistry } from '../src/plugins/registry.ts';
import type { ModelCompletionInput, ModelProvider, ModelTurn } from '../src/state/agent-loop.ts';
import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 0, windowEndHour: 1 };
const TOKEN = 'web-channel-test-token';

class StreamingProvider implements ModelProvider {
  readonly name = 'streaming';
  readonly model = 'streaming/test';
  calls = 0;

  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    this.calls += 1;
    await input.onDelta?.('你');
    await input.onDelta?.('好');
    return { text: '你好', toolCalls: [] };
  }
}

class Sse {
  private buffer = '';
  private readonly queue: Array<{ event: string; data: any }> = [];

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) return;
      this.buffer += decoder.decode(value);
      let cut = this.buffer.indexOf('\n\n');
      while (cut >= 0) {
        const block = this.buffer.slice(0, cut);
        this.buffer = this.buffer.slice(cut + 2);
        this.parse(block);
        cut = this.buffer.indexOf('\n\n');
      }
    }
  }

  private parse(block: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length > 0) this.queue.push({ event, data: JSON.parse(data.join('\n')) });
  }

  async wait(name: string, timeoutMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.queue.findIndex((entry) => entry.event === name);
      if (index >= 0) return this.queue.splice(index, 1)[0]!.data;
      if (Date.now() > deadline) throw new Error(`timeout waiting for SSE ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function post(base: string, path: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-observatory-token': token },
    body: JSON.stringify(body),
  });
}

describe('web channel plugin (F12)', () => {
  test('streams, shows provenance, approves a plugin, routes credentials to the secret face, and stops on removal', async () => {
    const dir = makeTempDir('web-channel-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'observatory-token'), `${TOKEN}\n`, { mode: 0o600 });
    writePluginRegistry(dataDir, ['builtin:web-channel']);

    const provider = new StreamingProvider();
    const shell = makeShell(dir, provider, {
      dataDir,
      dbPath: join(dataDir, 'memory.sqlite'),
      plugins: ['builtin:web-channel'],
      dream: NO_DREAM,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await shell.start();
    const base = shell.httpUrl!;
    const sse = new Sse((await fetch(`${base}/channel/web/events`)).body!.getReader());
    try {
      const page = await fetch(`${base}/channel/web/`, { redirect: 'manual' });
      expect(page.status).toBe(302);
      expect(page.headers.get('location')).toBe('/observatory/#chat');
      const script = await (await fetch(`${base}/channel/web/app.js`)).text();
      expect(script).toContain('/observatory/#credentials');
      expect(script).toContain("document.getElementById('view-chat')");
      expect(script).toContain('__COGMEM_COMPANION__');
      const style = await fetch(`${base}/channel/web/view.css`);
      expect(style.status).toBe(200);
      expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');
      const shellPage = await (await fetch(`${base}/observatory/`)).text();
      expect(shellPage).toContain('id="tab-chat"');
      expect(shellPage).toContain('window.__COGMEM_COMPANION__=');

      expect((await post(base, '/channel/web/send', { text: '你好' }, '')).status).toBe(403);

      expect((await post(base, '/channel/web/send', { text: '你好' })).status).toBe(202);
      expect((await sse.wait('user')).text).toBe('你好');
      expect((await sse.wait('reply_delta')).delta).toBe('你');
      expect((await sse.wait('reply_delta')).delta).toBe('好');
      expect((await sse.wait('reply_end')).text).toBe('你好');

      (shell.backend as any).recentRecallDecision = () => ({ state: 'found', decision: { timestamp: Date.now(), payload: { selectedIds: ['mem-1'] } }, chain: [] });
      (shell.kernel as any).memoryAtlasService.node = () => ({ label: '记忆一' });
      expect((await post(base, '/channel/web/send', { text: '再问一句' })).status).toBe(202);
      const replied = await sse.wait('reply_end');
      expect(replied.provenance).toEqual([{ id: 'mem-1', label: '记忆一' }]);

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
      const card = await sse.wait('proposal');
      expect(card.proposal.kind).toBe('plugin');
      expect(card.proposal.removal).toContain('/plugins remove');
      const approved = await post(base, '/channel/web/proposal', { id: proposal.proposal!.id, action: 'confirm' });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({ ok: true });
      expect(readPluginRegistry(dataDir)).toContain(sourcePath);
      expect(shell.trace.read().some((record) => record.kind === 'plugin_registered' && record.spec === sourcePath)).toBe(true);
      expect((await post(base, '/channel/web/credential', {})).status).toBe(404);

      const before = (shell.kernel as any).eventStore.queryEvents(1, 1, { projectId: [shell.config.projectId] }).total;
      await shell.pluginsAdmin.removePlugin('builtin:web-channel');
      expect((await fetch(`${base}/channel/web/`)).status).toBe(404);
      const afterRemoval = await (await fetch(`${base}/observatory/`)).text();
      expect(afterRemoval).not.toContain('id="tab-chat"');
      expect(afterRemoval).toContain('id="tab-starmap"');
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const after = (shell.kernel as any).eventStore.queryEvents(1, 1, { projectId: [shell.config.projectId] }).total;
      expect(after).toBe(before);
    } finally {
      await shell.stop();
    }

    writePluginRegistry(dataDir, ['builtin:web-channel']);
    const reinstalled = makeShell(dir, provider, {
      dataDir,
      dbPath: join(dataDir, 'memory.sqlite'),
      plugins: readPluginRegistry(dataDir),
      dream: NO_DREAM,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await reinstalled.start();
    try {
      expect((await fetch(`${reinstalled.httpUrl}/channel/web/`)).status).toBe(200);
      const history = await (await fetch(`${reinstalled.httpUrl}/channel/web/history`)).json() as { messages: Array<{ role: string; text: string }> };
      expect(history.messages.some((message) => message.role === 'user' && message.text === '你好')).toBe(true);
      expect(history.messages.some((message) => message.role === 'assistant' && message.text === '你好')).toBe(true);
    } finally {
      await reinstalled.stop();
    }
  }, 60_000);

  test('confirming a commitment card marks only that surfacing engaged', async () => {
    const dir = makeTempDir('web-channel-commitment-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'observatory-token'), `${TOKEN}\n`, { mode: 0o600 });
    writePluginRegistry(dataDir, ['builtin:web-channel']);

    const provider = new StreamingProvider();
    const shell = makeShell(dir, provider, {
      dataDir,
      dbPath: join(dataDir, 'memory.sqlite'),
      plugins: ['builtin:web-channel'],
      dream: NO_DREAM,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    });
    await shell.start();
    try {
      const base = shell.httpUrl!;
      const projectId = shell.config.projectId;
      shell.backend.deliverSurfacing({ projectId, candidateId: 'surfacing:commitment:web-one', content: '测试承诺一', now: Date.now() });
      shell.backend.deliverSurfacing({ projectId, candidateId: 'surfacing:commitment:web-two', content: '测试承诺二', now: Date.now() });
      expect(shell.backend.surfacingPending({ projectId })).toHaveLength(2);

      const confirmed = await post(base, '/channel/web/commitment', { id: 'surfacing:commitment:web-one', action: 'confirm' });
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toMatchObject({ ok: true });
      const audit = shell.kernel.surfacingFeedback.audit({ projectId });
      expect(audit.at(-1)).toMatchObject({ candidateId: 'surfacing:commitment:web-one', outcome: 'engaged' });
      const pending = shell.backend.surfacingPending({ projectId });
      expect(pending).toHaveLength(1);
      expect(pending[0]!.candidateId).toBe('surfacing:commitment:web-two');
    } finally {
      await shell.stop();
    }
  }, 60_000);

  test('terminal and web share one ledger conversation, page back to its first turn, and keep the tail', async () => {
    const dir = makeTempDir('web-channel-sync-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'observatory-token'), `${TOKEN}\n`, { mode: 0o600 });
    writePluginRegistry(dataDir, ['builtin:web-channel']);

    const input = new PassThrough();
    const provider = new ScriptedProvider([
      { text: 'reply-1', toolCalls: [] },
      { text: 'reply-2', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider, {
      dataDir,
      dbPath: join(dataDir, 'memory.sqlite'),
      plugins: ['builtin:web-channel'],
      terminalEnabled: true,
      attach: { enabled: true },
      dream: NO_DREAM,
      http: { enabled: true, port: 0, hostname: '127.0.0.1' },
    }, { terminalInput: input, terminalOutput: { write: () => true } as unknown as NodeJS.WritableStream });
    await shell.start();
    try {
      const base = shell.httpUrl!;
      const { projectId, agentId, sessionId } = shell.config;
      const seededAt = Date.now() - 3 * 86_400_000;
      for (let i = 0; i < 120; i += 1) {
        await shell.backend.captureConversationTurn({
          projectId,
          agentId,
          sessionId,
          channel: 'telegram',
          speaker: i % 2 === 0 ? 'owner' : 'agent',
          text: `seed-${String(i).padStart(3, '0')}`,
          occurredAt: seededAt + i,
        });
      }

      const history = async (query = '') => await (await fetch(`${base}/channel/web/history${query}`)).json() as {
        messages: Array<{ role: string; text: string }>;
        cursor: number;
        hasMore: boolean;
      };

      input.write('terminal-A\n');
      await waitUntil(() => provider.calls.length === 1);
      let newest: Awaited<ReturnType<typeof history>> | undefined;
      for (let i = 0; i < 100; i += 1) {
        newest = await history();
        if (newest.messages.some((message) => message.text === 'reply-1')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(newest!.messages.filter((message) => message.text === 'terminal-A')).toHaveLength(1);
      expect(newest!.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'reply-1' });
      expect(newest!.hasMore).toBe(true);

      const seen = new Set(newest!.messages.map((message) => `${message.role}:${message.text}`));
      let cursor = newest!.cursor;
      let hasMore = newest!.hasMore;
      while (hasMore) {
        const page = await history(`?before=${cursor}&limit=50`);
        for (const message of page.messages) {
          const key = `${message.role}:${message.text}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
        cursor = page.cursor;
        hasMore = page.hasMore && page.messages.length > 0;
      }
      expect(seen.has('user:seed-000')).toBe(true);
      expect([...seen].filter((key) => key === 'user:terminal-A')).toHaveLength(1);

      const busUser = new Promise<string>((resolve) => {
        shell.host.bus.on('message_end', (event: any) => {
          if (event.message?.role === 'user') resolve(event.message.content);
        });
      });
      expect((await post(base, '/channel/web/send', { text: 'web-B' })).status).toBe(202);
      expect(await busUser).toBe('web-B');
      await waitUntil(() => provider.calls.length === 2);
      const carried = provider.calls[1]!.messages.map((message) => message.content).join('\n');
      expect(carried).toContain('terminal-A');

      const after = await history();
      expect(after.messages.filter((message) => message.text === 'web-B')).toHaveLength(1);
      expect(after.messages.filter((message) => message.text === 'terminal-A')).toHaveLength(1);
      const attached = await new AttachClient().connect(join(dataDir, 'attach.sock'));
      expect(attached.entries.some((entry) => entry.kind === 'user' && entry.text === 'web-B')).toBe(true);
    } finally {
      await shell.stop();
    }
  }, 60_000);
});

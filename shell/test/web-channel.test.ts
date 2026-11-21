import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pluginWorkspaceDir } from '../src/plugins/self-install.ts';
import { readPluginRegistry, writePluginRegistry } from '../src/plugins/registry.ts';
import type { ModelCompletionInput, ModelProvider, ModelTurn } from '../src/state/agent-loop.ts';
import { makeShell, makeTempDir } from './helpers.ts';

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
      expect((await fetch(`${base}/channel/web/`)).status).toBe(200);
      const html = await (await fetch(`${base}/channel/web/`)).text();
      expect(html).toContain('Cog 对话');
      const script = await (await fetch(`${base}/channel/web/app.js`)).text();
      expect(script).toContain('/observatory/#credentials');

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
});

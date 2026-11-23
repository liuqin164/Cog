import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelContract, ChannelSession, SessionTurnRead, SessionTurnReadInput } from 'cogmem';
import { isLocalAuthority, isLoopbackAddress, jsonResponse, readJsonBody, readObservatoryToken, refuseWrite } from 'cogmem';
import type { NativePlugin } from '../plugins/host.ts';
import type { ChannelRegistry } from './registry.ts';

const SOURCE_LAYOUT = import.meta.url.endsWith('.ts');

const PREFIX = '/channel/web';
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  [`${PREFIX}/app.js`]: { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  [`${PREFIX}/view.css`]: { file: 'view.css', type: 'text/css; charset=utf-8' },
};

export interface WebChannelShell {
  submit(text: string, channel?: string): Promise<unknown>;
  runCommand(name: string, args?: string): Promise<{ text: string }>;
  resendFailedInbound?(id?: string): { ok: boolean; text: string };
  confirmProposal(id: string): Promise<{ ok: boolean; reason?: string; proposal?: { resultText?: string } }>;
  discardProposal(id: string): unknown;
  acknowledgeSurfacing(candidateId: string): void;
  snooze(minutes: number, commitmentId?: string): { text: string };
  reviewCommitmentReceipt(input: {
    projectId: string;
    sourceEventId: string;
    action: 'confirm' | 'intention' | 'forget';
    content?: string;
    dueAt?: number;
    surface?: string;
  }): { text: string };
}

export interface WebChannelBackend {
  recentRecallDecision(input: { projectId: string; agentId: string }): {
    decision?: { timestamp: number; payload: Record<string, unknown> };
  };
  sessionTurns(input: SessionTurnReadInput): SessionTurnRead;
}

interface WebChannelOptions {
  shell: WebChannelShell;
  backend: WebChannelBackend;
  kernel: any;
  clock: { now(): number; localDate(at?: number): string };
  contract: ChannelContract;
  projectId: string;
  agentId: string;
  sessionId: string;
  webRoot: string;
  routes: {
    isLoopbackAddress(address: string | undefined): boolean;
    isLocalAuthority(authority: string | null | undefined): boolean;
    jsonResponse(body: unknown, status?: number, acceptEncoding?: string | null): Response;
    readJsonBody(request: Request): Promise<Record<string, unknown> | null>;
    refuseWrite(request: Request, token: string | undefined, acceptEncoding?: string | null): Response | null;
  };
  token?: string;
}

interface Stream {
  push(event: string, data: unknown): void;
  close(reason: string): void;
  signal: AbortSignal;
}

function defaultWebRoot(): string {
  return fileURLToPath(new URL(SOURCE_LAYOUT ? '../../web-channel/' : '../web-channel/', import.meta.url));
}

export class WebChannel {
  private readonly session: ChannelSession;
  private readonly streams = new Set<Stream>();
  private stopped = false;
  private runStartedAt = 0;
  private failedInbound = 0;

  constructor(private readonly options: WebChannelOptions) {
    this.session = options.contract.register({
      channelId: 'web',
      occasion: 'private',
      accounts: [{ accountId: 'web-owner', role: 'owner' }],
      reachability: 'online',
      interruptibility: 'normal',
    });
  }

  handle = async (request: Request, remoteAddress?: string): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
    if (this.stopped) return new Response('not_found', { status: 404 });
    if (!this.options.routes.isLoopbackAddress(remoteAddress)) {
      return new Response('forbidden: the web channel answers on loopback only', { status: 403 });
    }
    if (!this.options.routes.isLocalAuthority(request.headers.get('host') ?? url.host)) {
      return new Response('forbidden: unexpected Host (loopback only)', { status: 403 });
    }
    if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) {
      return new Response(null, { status: 302, headers: { location: '/observatory/#chat' } });
    }

    const staticFile = STATIC_FILES[url.pathname];
    if (staticFile && (request.method === 'GET' || request.method === 'HEAD')) {
      const file = Bun.file(join(this.options.webRoot, staticFile.file));
      if (!(await file.exists())) return new Response(`missing_asset: ${staticFile.file}`, { status: 500 });
      return new Response(request.method === 'HEAD' ? null : file, {
        headers: { 'content-type': staticFile.type, 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === `${PREFIX}/events`) {
      if (request.method !== 'GET') return this.methodNotAllowed('GET');
      return this.openStream(request.signal);
    }

    if (url.pathname === `${PREFIX}/history`) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return this.methodNotAllowed('GET, HEAD');
      return this.options.routes.jsonResponse(this.history(url));
    }

    if (url.pathname === `${PREFIX}/send`) {
      if (request.method !== 'POST') return this.methodNotAllowed('POST');
      return this.onSend(request);
    }

    if (url.pathname === `${PREFIX}/proposal`) {
      if (request.method !== 'POST') return this.methodNotAllowed('POST');
      return this.onProposal(request);
    }

    if (url.pathname === `${PREFIX}/commitment`) {
      if (request.method !== 'POST') return this.methodNotAllowed('POST');
      return this.onCommitment(request);
    }

    if (url.pathname === `${PREFIX}/receipt`) {
      if (request.method !== 'POST') return this.methodNotAllowed('POST');
      return this.onReceipt(request);
    }

    if (url.pathname === `${PREFIX}/resend`) {
      if (request.method !== 'POST') return this.methodNotAllowed('POST');
      return this.onResend(request);
    }

    return new Response('not_found', { status: 404 });
  };

  onBusEvent(name: string, payload: any): void {
    if (name === 'message_update') {
      if (typeof payload?.delta === 'string' && payload.delta !== '') this.broadcast('reply_delta', { delta: payload.delta });
      return;
    }
    if (name === 'message_end') {
      if (payload?.message?.role === 'user' && typeof payload.message.content === 'string' && payload.message.content !== '') {
        this.broadcast('user', { text: payload.message.content, at: this.options.clock.now() });
      }
      if (payload?.message?.role === 'assistant' && typeof payload.message.content === 'string' && payload.message.content !== '') {
        this.broadcast('reply_end', { text: payload.message.content, provenance: this.provenance() });
      }
      return;
    }
    if (name === 'commitment_receipt') {
      this.broadcast('receipt', payload);
      return;
    }
    if (name === 'companion_command_proposal') {
      const proposal = payload?.proposal;
      if (proposal?.kind === 'plugin' || proposal?.kind === 'credential') this.broadcast('proposal', { proposal });
      return;
    }
    if (name === 'companion_emergence') {
      if (payload?.channelId !== undefined && payload.channelId !== this.session.channelId) return;
      this.broadcast('emergence', { id: payload?.id, text: payload?.text, reason: payload?.reason });
      return;
    }
    if (name === 'companion_transition') {
      if (payload?.state === 'RUNNING') this.runStartedAt = this.options.clock.now();
      this.broadcast('state', { state: payload?.state, failed: this.failedInbound });
      return;
    }
    if (name === 'companion_status') {
      this.failedInbound = typeof payload?.status?.failedInbound === 'number' ? payload.status.failedInbound : 0;
      this.broadcast('state', { state: payload?.status?.lifecycle, failed: this.failedInbound });
      return;
    }
    if (name === 'companion_inbound_failed') {
      if (payload?.channel !== 'web' || typeof payload?.id !== 'string') return;
      this.broadcast('resend', { id: payload.id, error: payload.error });
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const stream of [...this.streams]) stream.close('plugin_removed');
    this.streams.clear();
    try {
      this.options.contract.presence(this.session, { reachability: 'offline', ownerActivity: 'away' });
    } catch {}
  }

  uiContribution(): { id: string; label: string; script: string; style: string } {
    return { id: 'chat', label: '对话', script: `${PREFIX}/app.js`, style: `${PREFIX}/view.css` };
  }

  private methodNotAllowed(allow: string): Response {
    return new Response('method_not_allowed', { status: 405, headers: { allow } });
  }

  private async onSend(request: Request): Promise<Response> {
    const refused = this.options.routes.refuseWrite(request, this.options.token, request.headers.get('accept-encoding'));
    if (refused) return refused;
    const body = await this.options.routes.readJsonBody(request);
    if (!body) return this.options.routes.jsonResponse({ error: 'invalid_json' }, 400);
    let text: string;
    try {
      text = this.options.contract.ingest(this.session, {
        accountId: 'web-owner',
        text: typeof body.text === 'string' ? body.text : '',
        at: this.options.clock.now(),
      }).text;
    } catch (error) {
      return this.options.routes.jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    this.options.contract.presence(this.session, { reachability: 'online', ownerActivity: 'active', at: this.options.clock.now() });
    if (text.startsWith('/')) {
      const [name = '', ...rest] = text.slice(1).split(/\s+/u);
      const reply = await this.options.shell.runCommand(name, rest.join(' '));
      this.broadcast('notice', { text: reply.text });
      return this.options.routes.jsonResponse({ ok: true, command: name });
    }
    void this.options.shell.submit(text, 'web').catch((error) => {
      this.broadcast('notice', { text: `回复失败：${error instanceof Error ? error.message : String(error)}` });
    });
    return this.options.routes.jsonResponse({ ok: true }, 202);
  }

  private async onProposal(request: Request): Promise<Response> {
    const refused = this.options.routes.refuseWrite(request, this.options.token, request.headers.get('accept-encoding'));
    if (refused) return refused;
    const body = await this.options.routes.readJsonBody(request);
    if (!body) return this.options.routes.jsonResponse({ error: 'invalid_json' }, 400);
    const id = typeof body.id === 'string' ? body.id : '';
    if (body.action === 'discard') {
      this.options.shell.discardProposal(id);
      return this.options.routes.jsonResponse({ ok: true, text: '已作废。' });
    }
    if (body.action !== 'confirm') return this.options.routes.jsonResponse({ error: 'invalid_action' }, 400);
    const result = await this.options.shell.confirmProposal(id);
    return this.options.routes.jsonResponse({
      ok: result.ok,
      text: result.ok ? (result.proposal?.resultText ?? '已执行。') : (result.reason ?? '未执行。'),
    });
  }

  private async onResend(request: Request): Promise<Response> {
    const refused = this.options.routes.refuseWrite(request, this.options.token, request.headers.get('accept-encoding'));
    if (refused) return refused;
    const body = await this.options.routes.readJsonBody(request);
    if (!body) return this.options.routes.jsonResponse({ error: 'invalid_json' }, 400);
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : undefined;
    const result = this.options.shell.resendFailedInbound?.(id) ?? { ok: false, text: '没有可重发的未送达消息。' };
    return this.options.routes.jsonResponse(result);
  }

  private async onCommitment(request: Request): Promise<Response> {
    const refused = this.options.routes.refuseWrite(request, this.options.token, request.headers.get('accept-encoding'));
    if (refused) return refused;
    const body = await this.options.routes.readJsonBody(request);
    if (!body) return this.options.routes.jsonResponse({ error: 'invalid_json' }, 400);
    const id = typeof body.id === 'string' ? body.id : '';
    const commitmentId = id.startsWith('surfacing:commitment:') ? id.slice('surfacing:commitment:'.length) : undefined;
    if (body.action === 'confirm') {
      this.options.shell.acknowledgeSurfacing(id);
      return this.options.routes.jsonResponse({ ok: true, text: '已确认。' });
    }
    if (body.action !== 'snooze') return this.options.routes.jsonResponse({ error: 'invalid_action' }, 400);
    const minutes = typeof body.minutes === 'number' && Number.isFinite(body.minutes) ? Math.max(1, Math.round(body.minutes)) : 60;
    const result = this.options.shell.snooze(minutes, commitmentId);
    return this.options.routes.jsonResponse({ ok: true, text: result.text });
  }

  private async onReceipt(request: Request): Promise<Response> {
    const refused = this.options.routes.refuseWrite(request, this.options.token, request.headers.get('accept-encoding'));
    if (refused) return refused;
    const body = await this.options.routes.readJsonBody(request);
    if (!body) return this.options.routes.jsonResponse({ error: 'invalid_json' }, 400);
    const sourceEventId = typeof body.sourceEventId === 'string' ? body.sourceEventId : '';
    const action = body.action;
    if (!sourceEventId || (action !== 'confirm' && action !== 'intention' && action !== 'forget')) {
      return this.options.routes.jsonResponse({ error: 'invalid_receipt_action' }, 400);
    }
    const result = this.options.shell.reviewCommitmentReceipt({
      projectId: this.options.projectId,
      sourceEventId,
      action,
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(typeof body.dueAt === 'number' ? { dueAt: body.dueAt } : {}),
      surface: 'web',
    });
    return this.options.routes.jsonResponse({ ok: true, text: result.text });
  }

  private history(url: URL): { messages: Array<{ role: string; text: string; at: number }>; cursor: number; hasMore: boolean } {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const rawBefore = url.searchParams.get('before');
    const before = rawBefore === null ? undefined : Number(rawBefore);
    const read = this.options.backend.sessionTurns({
      projectId: this.options.projectId,
      agentId: this.options.agentId,
      sessionId: this.options.sessionId,
      limit,
      ...(before !== undefined && Number.isFinite(before) ? { beforeGlobalSeq: before } : {}),
    });
    const messages = read.turns
      .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
      .map((turn) => ({ role: turn.role, text: turn.text, at: turn.occurredAt }))
      .filter((message) => message.text !== '');
    return { messages, cursor: read.turns[0]?.globalSeq ?? 0, hasMore: read.truncated };
  }

  private provenance(): Array<{ id: string; label: string }> {
    let selected: string[] = [];
    try {
      const decision = this.options.backend.recentRecallDecision({ projectId: this.options.projectId, agentId: this.options.agentId }).decision;
      if (!decision || decision.timestamp < this.runStartedAt) return [];
      selected = Array.isArray(decision.payload.selectedIds) ? decision.payload.selectedIds.map(String) : [];
    } catch {
      return [];
    }
    const nodes: Array<{ id: string; label: string }> = [];
    for (const id of selected) {
      try {
        const node = this.options.kernel.memoryAtlasService?.node(id, {
          projectId: this.options.projectId,
          includeEvidence: false,
          refresh: false,
          staleOk: true,
        });
        if (node) nodes.push({ id, label: String(node.label ?? node.title ?? id) });
      } catch {}
    }
    return nodes;
  }

  private broadcast(event: string, data: unknown): void {
    for (const stream of [...this.streams]) stream.push(event, data);
  }

  private openStream(signal: AbortSignal): Response {
    this.options.contract.presence(this.session, { reachability: 'online', ownerActivity: 'active', at: this.options.clock.now() });
    const encoder = new TextEncoder();
    const queue: Array<{ event: string; data: unknown }> = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stream: Stream = {
      signal,
      push: (event, data) => {
        if (finished) return;
        queue.push({ event, data });
        wake?.();
        wake = null;
      },
      close: (reason) => {
        if (finished) return;
        finished = true;
        queue.push({ event: 'bye', data: { reason } });
        if (heartbeat !== undefined) clearInterval(heartbeat);
        wake?.();
        wake = null;
        this.streams.delete(stream);
        if (this.streams.size === 0 && !this.stopped) this.options.contract.presence(this.session, { reachability: 'offline', ownerActivity: 'away' });
      },
    };

    const stop = (): void => stream.close('client_closed');
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'));
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            stream.close('client_closed');
          }
        }, 15_000);
      },
      async pull(controller) {
        while (!finished && queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
        for (const entry of queue.splice(0)) {
          controller.enqueue(encoder.encode(`event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`));
        }
        if (finished) {
          controller.close();
          return;
        }
        if (signal.aborted) {
          stream.close('client_closed');
          controller.close();
        }
      },
      cancel() {
        stream.close('client_closed');
      },
    });
    this.streams.add(stream);
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    });
  }
}

export interface WebChannelPluginOptions {
  contract: ChannelContract;
  projectId: string;
  agentId: string;
  sessionId: string;
  dataDir: string;
}

export function webChannelPlugin(options: WebChannelPluginOptions): NativePlugin {
  return {
    name: 'web-channel',
    inject: ['shell', 'memory', 'kernel', 'clock', 'channelRegistry'],
    provide: ['webChannel'],
    async apply(ctx) {
      const channel = new WebChannel({
        shell: ctx.getService<WebChannelShell>('shell'),
        backend: ctx.getService<WebChannelBackend>('memory'),
        kernel: ctx.getService('kernel'),
        clock: ctx.getService<{ now(): number; localDate(at?: number): string }>('clock'),
        contract: options.contract,
        projectId: options.projectId,
        agentId: options.agentId,
        get sessionId() {
          return options.sessionId;
        },
        webRoot: defaultWebRoot(),
        routes: { isLoopbackAddress, isLocalAuthority, jsonResponse, readJsonBody, refuseWrite },
        token: readObservatoryToken(options.dataDir),
      });
      ctx.provide('webChannel', channel);
      const unregister = ctx.getService<ChannelRegistry>('channelRegistry').register({
        id: 'web',
        name: 'Web',
        config: [],
        status: () => ({ state: 'connected', detail: '本页由 Web 渠道提供' }),
      });
      for (const name of ['message_update', 'message_end', 'companion_command_proposal', 'companion_emergence', 'companion_transition', 'commitment_receipt', 'companion_status', 'companion_inbound_failed']) {
        ctx.on(name, (payload: any) => channel.onBusEvent(name, payload));
      }
      ctx.dispose(() => {
        unregister();
        channel.stop();
      });
    },
  };
}

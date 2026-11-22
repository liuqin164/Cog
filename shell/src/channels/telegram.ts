import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChannelContract, ChannelSession } from 'cogmem';
import type { CredentialService } from '../credentials.ts';
import type { NativePlugin } from '../plugins/host.ts';
import type { TraceLog } from '../trace.ts';
import type { ChannelRegistry } from './registry.ts';

export interface TelegramShell {
  submit(text: string, channel?: string): Promise<unknown>;
  currentChannel: string;
  confirmProposal(id: string): Promise<{ ok: boolean; reason?: string; proposal?: { resultText?: string } }>;
  discardProposal(id: string): unknown;
}

interface TelegramClock {
  now(): number;
  quietWindowOpen(at?: number): boolean;
}

export interface TelegramChannelOptions {
  shell: TelegramShell;
  contract: ChannelContract;
  credentials: Pick<CredentialService, 'use' | 'revoke' | 'requestForOwner' | 'pending' | 'refs'>;
  clock: TelegramClock;
  trace: TraceLog;
  dataDir: string;
}

export interface TelegramChannelPluginOptions {
  contract: ChannelContract;
  dataDir: string;
}

export type TelegramChannelState = 'disconnected' | 'pairing' | 'connected' | 'error';

export interface TelegramChannelStatus {
  state: TelegramChannelState;
  detail?: string;
  pairingCode?: string;
}

interface TelegramConfig {
  credential?: string;
  ownerId?: string;
  apiBase: string;
}

interface TelegramMessage {
  text?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string };
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id?: number | string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

const DEFAULT_API_BASE = 'https://api.telegram.org';
const PAIRING_TTL_MS = 10 * 60 * 1000;
const POLL_FAILURE_LIMIT = 3;

function field(value: unknown): string | undefined {
  const result = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  return result === '' ? undefined : result;
}

function readTelegramConfig(dataDir: string): TelegramConfig | undefined {
  const path = join(dataDir, 'telegram-channel.json');
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const credential = field(parsed.credential);
  const ownerId = field(parsed.ownerId);
  if (ownerId && !credential) throw new Error('invalid_telegram_config: ownerId requires credential');
  return {
    ...(credential ? { credential } : {}),
    ...(ownerId ? { ownerId } : {}),
    apiBase: (field(parsed.apiBase) ?? DEFAULT_API_BASE).replace(/\/+$/u, ''),
  };
}

class TelegramApi {
  constructor(
    private readonly config: TelegramConfig,
    private readonly token: () => string,
  ) {}

  private async call(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBase}/bot${this.token()}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch {
      throw new Error(`telegram_${method}_failed: network`);
    }
    const body = await response.json() as { ok?: boolean; result?: unknown; description?: string };
    if (!response.ok || body.ok !== true) throw new Error(`telegram_${method}_failed: ${body.description ?? response.status}`);
    return body.result;
  }

  async getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return await this.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, signal) as TelegramUpdate[];
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text, ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }) });
  }

  async answerCallbackQuery(id: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }
}

export class TelegramChannel {
  private readonly configPath: string;
  private readonly api: TelegramApi;
  private config: TelegramConfig;
  private session?: ChannelSession;
  private state: TelegramChannelState;
  private pairingCode?: string;
  private pairingExpiresAt = 0;
  private poll?: AbortController;
  private disposed = false;
  private offset = 0;
  private replyRuns = new Set<string>();
  private failures = 0;
  private lastError?: string;

  constructor(
    private readonly options: TelegramChannelOptions,
    config?: TelegramConfig,
    initialError?: string,
  ) {
    this.configPath = join(options.dataDir, 'telegram-channel.json');
    this.config = config ?? { apiBase: DEFAULT_API_BASE };
    this.api = new TelegramApi(this.config, () => this.token());
    if (initialError) {
      this.state = 'error';
      this.lastError = initialError;
    } else if (!this.config.credential) {
      this.state = 'disconnected';
    } else if (this.config.ownerId) {
      this.state = 'connected';
      this.registerSession();
    } else {
      this.state = 'pairing';
      this.newPairingCode();
    }
  }

  start(): void {
    if (this.state === 'connected' || this.state === 'pairing') this.startPolling();
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    this.setOffline();
  }

  card(): TelegramChannelStatus {
    const detail = this.state === 'connected'
      ? `owner ${this.config.ownerId}`
      : this.state === 'pairing'
        ? '把配对码发给 bot'
        : this.state === 'error'
          ? (this.lastError ?? '连接异常')
          : '未填写 Bot Token';
    return {
      state: this.state,
      detail,
      ...(this.state === 'pairing' && this.pairingCode ? { pairingCode: this.pairingCode } : {}),
    };
  }

  beginConnect(credential: string): TelegramChannelStatus {
    this.stopPolling();
    this.setOffline();
    const previous = this.config.credential;
    if (previous && previous !== credential) this.options.credentials.revoke(previous);
    this.session = undefined;
    this.replyRuns.clear();
    this.config = { apiBase: this.config.apiBase, credential };
    this.persist();
    this.state = 'pairing';
    this.lastError = undefined;
    this.failures = 0;
    this.newPairingCode();
    this.startPolling();
    this.options.trace.append('telegram_connect_started', { credential });
    return this.card();
  }

  disconnect(): TelegramChannelStatus {
    this.stopPolling();
    this.setOffline();
    if (this.config.credential) this.options.credentials.revoke(this.config.credential);
    this.session = undefined;
    this.replyRuns.clear();
    this.pairingCode = undefined;
    this.pairingExpiresAt = 0;
    this.state = 'disconnected';
    this.lastError = undefined;
    this.failures = 0;
    this.config = { apiBase: this.config.apiBase };
    this.persist();
    this.options.trace.append('telegram_disconnected', {});
    return this.card();
  }

  onBusEvent(name: string, payload: any, ctx?: { runId?: string }): void {
    if (name === 'agent_start') {
      if (this.state === 'connected' && this.session && this.options.shell.currentChannel === this.session.channelId && typeof ctx?.runId === 'string') {
        this.replyRuns.add(ctx.runId);
      }
      return;
    }
    if (name === 'agent_end') {
      const runId = ctx?.runId;
      if (typeof runId !== 'string' || !this.replyRuns.delete(runId)) return;
      const text = payload?.summary?.lastAssistantText;
      if (typeof text === 'string' && text !== '') void this.send(text);
      return;
    }
    if (name === 'companion_command_proposal') {
      this.onProposal(payload?.proposal);
      return;
    }
    if (name === 'companion_emergence') {
      void this.onEmergence(payload);
    }
  }

  private token(): string {
    if (!this.config.credential) throw new Error('telegram_credential_missing');
    const token = this.options.credentials.use(this.config.credential, 'telegram-channel').token;
    if (!token) throw new Error(`credential_field_missing: ${this.config.credential} has no token`);
    return token;
  }

  private newPairingCode(): void {
    this.pairingCode = randomBytes(3).toString('hex').toUpperCase();
    this.pairingExpiresAt = this.options.clock.now() + PAIRING_TTL_MS;
  }

  private persist(): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const data: Record<string, string> = { apiBase: this.config.apiBase };
    if (this.config.credential) data.credential = this.config.credential;
    if (this.config.ownerId) data.ownerId = this.config.ownerId;
    writeFileSync(this.configPath, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    chmodSync(this.configPath, 0o600);
  }

  private registerSession(): void {
    const ownerId = this.config.ownerId;
    if (!ownerId) return;
    this.session = this.options.contract.register({
      channelId: `telegram:${ownerId}`,
      occasion: 'private',
      accounts: [{ accountId: ownerId, role: 'owner' }],
      reachability: 'online',
      interruptibility: 'normal',
    });
    this.options.contract.presence(this.session, { reachability: 'online', ownerActivity: 'idle' });
  }

  private setOnline(): void {
    if (this.session) this.options.contract.presence(this.session, { reachability: 'online', ownerActivity: 'idle' });
  }

  private setOffline(): void {
    if (!this.session) return;
    try {
      this.options.contract.presence(this.session, { reachability: 'offline', ownerActivity: 'away' });
    } catch {}
  }

  private startPolling(): void {
    if (this.disposed || this.poll || !this.config.credential) return;
    this.poll = new AbortController();
    void this.pollLoop(this.poll.signal);
  }

  private stopPolling(): void {
    this.poll?.abort();
    this.poll = undefined;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!this.disposed && !signal.aborted) {
      try {
        const updates = await this.api.getUpdates(this.offset, signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
        this.failures = 0;
        this.lastError = undefined;
        if (this.state === 'error') {
          this.state = this.config.ownerId ? 'connected' : 'pairing';
          this.setOnline();
        }
      } catch (error) {
        if (this.disposed || signal.aborted) return;
        this.failures += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.options.trace.append('telegram_poll_failed', { message: this.lastError });
        if (this.failures >= POLL_FAILURE_LIMIT) {
          this.state = 'error';
          this.setOffline();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      if (this.state === 'connected') await this.onCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.text || message.chat?.id === undefined || message.from?.id === undefined) return;
    const chatId = String(message.chat.id);
    if (message.chat.type !== 'private' || (this.state === 'connected' && chatId !== this.config.ownerId)) {
      this.options.trace.append('telegram_chat_refused', { chatId, reason: message.chat.type !== 'private' ? 'not_private' : 'not_owner' });
      return;
    }
    if (this.state === 'pairing') {
      this.tryPair(message);
      return;
    }
    if (this.state !== 'connected' || !this.session) return;
    const accountId = String(message.from.id);
    let ingress: { role?: string; text?: string };
    try {
      ingress = this.options.contract.ingest(this.session, {
        accountId,
        text: message.text,
        at: this.options.clock.now(),
      });
    } catch (error) {
      this.options.trace.append('telegram_ingress_failed', { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (ingress.role !== 'owner' || !ingress.text) {
      this.options.trace.append('telegram_message_refused', { accountId, chatId });
      return;
    }
    this.options.contract.presence(this.session, { reachability: 'online', ownerActivity: 'active' });
    void this.options.shell.submit(ingress.text, this.session.channelId).catch((error) => {
      this.options.trace.append('telegram_submit_failed', { message: error instanceof Error ? error.message : String(error) });
    });
  }

  private tryPair(message: TelegramMessage): void {
    const text = message.text?.trim().toUpperCase() ?? '';
    const ownerId = String(message.from?.id ?? '');
    const chatId = String(message.chat?.id ?? '');
    if (!this.pairingCode || !ownerId || !chatId) {
      this.options.trace.append('telegram_pairing_refused', { reason: 'unavailable' });
      return;
    }
    if (this.options.clock.now() > this.pairingExpiresAt) {
      this.newPairingCode();
      this.options.trace.append('telegram_pairing_expired', {});
      return;
    }
    if (text !== this.pairingCode) {
      this.options.trace.append('telegram_pairing_refused', { reason: 'code_mismatch', accountId: ownerId });
      return;
    }
    this.config = { ...this.config, ownerId };
    this.persist();
    this.pairingCode = undefined;
    this.pairingExpiresAt = 0;
    this.state = 'connected';
    this.lastError = undefined;
    this.registerSession();
    this.options.trace.append('telegram_paired', { ownerId, chatId });
    void this.send('已绑定。现在可以直接和同伴对话。');
  }

  private onProposal(proposal: any): void {
    if (this.state !== 'connected' || !proposal || proposal.status !== 'pending' || typeof proposal.id !== 'string') return;
    if (proposal.kind === 'credential') {
      void this.send(`凭据请求：${proposal.reason ?? proposal.id}\n请在终端或星海的保密输入面填写。`);
      return;
    }
    if (proposal.kind === 'plugin') {
      void this.send(`插件提案：${proposal.name ?? proposal.id}\n${proposal.purpose ?? proposal.reason ?? ''}\n请到终端或星海批准。`);
      return;
    }
    const title = `提案：/${proposal.command ?? ''} ${proposal.args ?? ''}`.trim();
    void this.send(
      `${title}\n${proposal.purpose ?? proposal.reason ?? ''}`,
      { inline_keyboard: [[
        { text: '批准', callback_data: `confirm:${proposal.id}` },
        { text: '作废', callback_data: `discard:${proposal.id}` },
      ]] },
    );
  }

  private async onCallback(query: TelegramCallbackQuery): Promise<void> {
    const accountId = String(query.from?.id ?? '');
    const [action, id] = (query.data ?? '').split(':');
    if (accountId !== this.config.ownerId || !id || (action !== 'confirm' && action !== 'discard')) {
      this.options.trace.append('telegram_approval_refused', { accountId, data: query.data ?? '' });
      await this.answer(query.id, '拒绝：仅登记的 owner 可批准。');
      return;
    }
    let text: string;
    let ok = true;
    if (action === 'discard') {
      this.options.shell.discardProposal(id);
      text = '已作废。';
    } else {
      const result = await this.options.shell.confirmProposal(id);
      ok = result.ok;
      text = result.ok ? (result.proposal?.resultText ?? '已执行。') : (result.reason ?? '未执行。');
    }
    this.options.trace.append('telegram_approval', { accountId, id, action, ok });
    await this.answer(query.id, text);
    await this.send(text);
  }

  private async onEmergence(payload: any): Promise<void> {
    if (this.state !== 'connected' || typeof payload?.id !== 'string' || typeof payload?.text !== 'string' || payload.text === '') return;
    if (payload.channelId !== undefined && payload.channelId !== this.session?.channelId) return;
    if (this.options.clock.quietWindowOpen(this.options.clock.now())) {
      this.options.trace.append('telegram_surfacing_quiet', { candidateId: payload.id });
      return;
    }
    if (!this.session) return;
    if (payload.strength === 'incidental') {
      this.options.trace.append('telegram_surfacing_incidental', { candidateId: payload.id });
      return;
    }
    const delivery = this.options.contract.deliver(this.session, {
      candidateId: payload.id,
      strength: payload.strength === 'incidental' ? 'incidental' : 'proactive',
      text: payload.text,
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    });
    this.options.trace.append('telegram_surfacing', { candidateId: payload.id, outcome: delivery.outcome });
    if (delivery.outcome === 'delivered') await this.send(payload.text);
  }

  private async answer(callbackId: string, text: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(callbackId, text);
    } catch (error) {
      this.options.trace.append('telegram_callback_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async send(text: string, replyMarkup?: unknown): Promise<void> {
    if (this.disposed || this.state !== 'connected' || !this.config.ownerId) return;
    try {
      await this.api.sendMessage(this.config.ownerId, text, replyMarkup);
    } catch (error) {
      this.options.trace.append('telegram_send_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function telegramChannelPlugin(options: TelegramChannelPluginOptions): NativePlugin {
  return {
    name: 'telegram-channel',
    inject: ['shell', 'credentials', 'clock', 'trace', 'channelRegistry'],
    apply(ctx) {
      let config: TelegramConfig | undefined;
      let error: string | undefined;
      try {
        config = readTelegramConfig(options.dataDir);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        ctx.getService<TraceLog>('trace').append('telegram_config_invalid', { message: error });
      }
      const credentials = ctx.getService<Pick<CredentialService, 'use' | 'revoke' | 'requestForOwner' | 'pending' | 'refs'>>('credentials');
      const channel = new TelegramChannel({
        shell: ctx.getService<TelegramShell>('shell'),
        contract: options.contract,
        credentials,
        clock: ctx.getService<TelegramClock>('clock'),
        trace: ctx.getService<TraceLog>('trace'),
        dataDir: options.dataDir,
      }, config, error);
      ctx.provide('telegramChannel', channel);
      const configFields = [{ name: 'token', label: 'Bot Token', secret: true }];
      const unregister = ctx.getService<ChannelRegistry>('channelRegistry').register({
        id: 'telegram',
        name: 'Telegram',
        config: configFields,
        status: () => channel.card(),
        begin: () => {
          const before = new Set(credentials.pending().map((entry) => entry.id));
          void credentials.requestForOwner({
            service: 'telegram-bot',
            purpose: '连接 Telegram 渠道',
            requestedBy: 'web:channels',
            fields: configFields,
          });
          const request = credentials.pending().find((entry) => !before.has(entry.id));
          return request ? { ok: true, requestId: request.id } : { ok: false, error: 'credential_request_failed' };
        },
        start: (ref) => {
          const value = ref.trim();
          if (!value || !credentials.refs().some((entry) => entry.ref === value && entry.service === 'telegram-bot')) {
            return { ok: false, error: 'credential_not_found' };
          }
          channel.beginConnect(value);
          return { ok: true };
        },
        disconnect: () => {
          channel.disconnect();
          return { ok: true };
        },
      });
      for (const name of ['agent_start', 'agent_end', 'companion_command_proposal', 'companion_emergence']) {
        ctx.on(name, (payload: any, busCtx?: { runId?: string }) => channel.onBusEvent(name, payload, busCtx));
      }
      channel.start();
      ctx.dispose(() => {
        unregister();
        channel.stop();
      });
    },
  };
}

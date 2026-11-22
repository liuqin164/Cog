import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelContract, ChannelSession } from 'cogmem';
import type { CredentialService } from '../credentials.ts';
import type { NativePlugin } from '../plugins/host.ts';
import type { TraceLog } from '../trace.ts';

export interface TelegramShell {
  submit(text: string): Promise<unknown>;
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
  credentials: Pick<CredentialService, 'use'>;
  clock: TelegramClock;
  trace: TraceLog;
}

export interface TelegramChannelPluginOptions {
  contract: ChannelContract;
  dataDir: string;
}

interface TelegramConfig {
  credential: string;
  ownerId: string;
  chatId: string;
  apiBase: string;
}

interface TelegramMessage {
  text?: string;
  chat?: { id?: number | string };
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
  if (!credential || !ownerId) throw new Error('invalid_telegram_config: credential and ownerId are required');
  return {
    credential,
    ownerId,
    chatId: field(parsed.chatId) ?? ownerId,
    apiBase: (field(parsed.apiBase) ?? 'https://api.telegram.org').replace(/\/+$/u, ''),
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
  private readonly session: ChannelSession;
  private readonly api: TelegramApi;
  private readonly config: TelegramConfig;
  private stopped = false;
  private offset = 0;
  private chatId: string;
  private pendingReplies = 0;
  private poll?: AbortController;

  constructor(private readonly options: TelegramChannelOptions, config: TelegramConfig) {
    this.config = config;
    this.chatId = config.chatId;
    this.session = options.contract.register({
      channelId: `telegram:${config.chatId}`,
      occasion: config.chatId.startsWith('-') ? 'group' : 'private',
      accounts: [{ accountId: config.ownerId, role: 'owner' }],
      reachability: 'online',
      interruptibility: 'normal',
    });
    this.api = new TelegramApi(config, () => this.token());
  }

  start(): void {
    if (this.poll) return;
    this.options.contract.presence(this.session, { reachability: 'online', ownerActivity: 'idle' });
    this.poll = new AbortController();
    void this.pollLoop(this.poll.signal);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.poll?.abort();
    this.poll = undefined;
    try {
      this.options.contract.presence(this.session, { reachability: 'offline', ownerActivity: 'away' });
    } catch {}
  }

  onBusEvent(name: string, payload: any): void {
    if (name === 'message_end') {
      if (this.pendingReplies > 0 && payload?.message?.role === 'assistant' && typeof payload.message.content === 'string' && payload.message.content !== '') {
        this.pendingReplies -= 1;
        void this.send(payload.message.content);
      }
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
    const token = this.options.credentials.use(this.config.credential, 'telegram-channel').token;
    if (!token) throw new Error(`credential_field_missing: ${this.config.credential} has no token`);
    return token;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates(this.offset, signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopped || signal.aborted) return;
        this.options.trace.append('telegram_poll_failed', { message: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.onCallback(update.callback_query);
    const message = update.message;
    if (!message?.text || message.chat?.id === undefined) return;
    const accountId = String(message.from?.id ?? '');
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
      this.options.trace.append('telegram_message_refused', { accountId, chatId: String(message.chat.id) });
      return;
    }
    this.chatId = String(message.chat.id);
    this.options.contract.presence(this.session, { reachability: 'online', ownerActivity: 'active' });
    this.pendingReplies += 1;
    void this.options.shell.submit(ingress.text).catch((error) => {
      this.pendingReplies = Math.max(0, this.pendingReplies - 1);
      this.options.trace.append('telegram_submit_failed', { message: error instanceof Error ? error.message : String(error) });
    });
  }

  private onProposal(proposal: any): void {
    if (this.stopped || !proposal || proposal.status !== 'pending' || typeof proposal.id !== 'string') return;
    if (proposal.kind === 'credential') {
      void this.send(`凭据请求：${proposal.reason ?? proposal.id}\n请在终端或星海的保密输入面填写。`);
      return;
    }
    const title = proposal.kind === 'plugin'
      ? `插件提案：${proposal.name ?? proposal.id}`
      : `提案：/${proposal.command ?? ''} ${proposal.args ?? ''}`.trim();
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
    if (this.stopped || typeof payload?.id !== 'string' || typeof payload?.text !== 'string' || payload.text === '') return;
    if (this.options.clock.quietWindowOpen(this.options.clock.now())) {
      this.options.trace.append('telegram_surfacing_quiet', { candidateId: payload.id });
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
    if (this.stopped) return;
    try {
      await this.api.sendMessage(this.chatId, text, replyMarkup);
    } catch (error) {
      this.options.trace.append('telegram_send_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function telegramChannelPlugin(options: TelegramChannelPluginOptions): NativePlugin {
  return {
    name: 'telegram-channel',
    inject: ['shell', 'credentials', 'clock', 'trace'],
    apply(ctx) {
      let config: TelegramConfig | undefined;
      try {
        config = readTelegramConfig(options.dataDir);
      } catch (error) {
        ctx.getService<TraceLog>('trace').append('telegram_config_invalid', { message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!config) return;
      const channel = new TelegramChannel({
        shell: ctx.getService<TelegramShell>('shell'),
        contract: options.contract,
        credentials: ctx.getService<Pick<CredentialService, 'use'>>('credentials'),
        clock: ctx.getService<TelegramClock>('clock'),
        trace: ctx.getService<TraceLog>('trace'),
      }, config);
      ctx.provide('telegramChannel', channel);
      for (const name of ['message_end', 'companion_command_proposal', 'companion_emergence']) {
        ctx.on(name, (payload: any) => channel.onBusEvent(name, payload));
      }
      channel.start();
      ctx.dispose(() => channel.stop());
    },
  };
}

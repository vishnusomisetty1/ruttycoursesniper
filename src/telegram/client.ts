/**
 * Minimal Telegram Bot API client — sendMessage plus getUpdates.
 *
 * Reading is narrowly scoped: `TelegramUpdateReader` polls this bot's own inbox
 * so the worker can accept a yes/no answer to "did you get in?" and a fixed set
 * of slash commands. It never reads any other conversation, and the reply
 * listener acts on nothing beyond those two things — see reply-listener.ts.
 *
 * Only one process may long-poll a given bot token at a time; Telegram returns
 * HTTP 409 to the loser, which the listener logs rather than crashing on.
 *
 * The bot token is read from the environment and never logged or persisted.
 */
import { truncateForTelegram } from './format.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export interface TelegramNotifier {
  sendMessage(chatId: string, text: string): Promise<TelegramSendResult>;
  readonly enabled: boolean;
}

export interface TelegramClientOptions {
  botToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export class TelegramClient implements TelegramNotifier {
  private readonly botToken: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TelegramClientOptions = {}) {
    this.botToken = options.botToken;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.log = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get enabled(): boolean {
    return typeof this.botToken === 'string' && this.botToken.length > 0;
  }

  async sendMessage(chatId: string, text: string): Promise<TelegramSendResult> {
    if (!this.enabled) {
      // Not an error: the CLI is usable without Telegram configured.
      this.log.warn('telegram disabled; message not sent', { chatId });
      return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' };
    }

    const url = `${this.baseUrl}/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text: truncateForTelegram(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    let lastError = 'unknown error';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });

        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: { message_id?: number };
          description?: string;
        };

        if (res.ok && json.ok) {
          this.log.debug('telegram message sent', { chatId });
          return { ok: true, messageId: json.result?.message_id };
        }

        lastError = json.description ?? `HTTP ${res.status}`;
        // 4xx other than 429 means the message itself is wrong; retrying won't help.
        if (res.status < 500 && res.status !== 429) {
          this.log.error('telegram rejected message', { chatId, error: lastError });
          return { ok: false, error: lastError };
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }

      this.log.warn('telegram send failed', { chatId, attempt, error: lastError });
    }

    return { ok: false, error: lastError };
  }
}

/** One inbound text message, reduced to the only fields we act on. */
export interface TelegramInboundMessage {
  updateId: number;
  chatId: string;
  text: string;
}

export interface TelegramUpdatesResult {
  ok: boolean;
  messages: TelegramInboundMessage[];
  error?: string;
}

export interface TelegramUpdateSource {
  fetchUpdates(offset: number | null, signal?: AbortSignal): Promise<TelegramUpdatesResult>;
  readonly enabled: boolean;
}

/**
 * Long-polls getUpdates for text messages.
 *
 * `allowed_updates: ['message']` means Telegram never sends us edits, channel
 * posts, callbacks or anything else — we cannot act on what we do not receive.
 */
export class TelegramUpdateReader implements TelegramUpdateSource {
  private readonly botToken: string | undefined;
  private readonly baseUrl: string;
  private readonly longPollSeconds: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramClientOptions & { longPollSeconds?: number } = {}) {
    this.botToken = options.botToken;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.longPollSeconds = options.longPollSeconds ?? 25;
    this.log = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get enabled(): boolean {
    return typeof this.botToken === 'string' && this.botToken.length > 0;
  }

  async fetchUpdates(offset: number | null, signal?: AbortSignal): Promise<TelegramUpdatesResult> {
    if (!this.enabled) return { ok: false, messages: [], error: 'TELEGRAM_BOT_TOKEN is not set' };

    const url = `${this.baseUrl}/bot${this.botToken}/getUpdates`;
    const body = JSON.stringify({
      // Passing an offset also acknowledges everything before it, so a message
      // is never handled twice even across a restart.
      ...(offset === null ? {} : { offset }),
      timeout: this.longPollSeconds,
      allowed_updates: ['message'],
    });

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });

      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: Array<{
          update_id: number;
          message?: { text?: string; chat?: { id?: number } };
        }>;
      };

      if (!res.ok || !json.ok) {
        return { ok: false, messages: [], error: json.description ?? `HTTP ${res.status}` };
      }

      const messages: TelegramInboundMessage[] = [];
      for (const update of json.result ?? []) {
        const text = update.message?.text;
        const chatId = update.message?.chat?.id;
        if (typeof text === 'string' && typeof chatId === 'number') {
          messages.push({ updateId: update.update_id, chatId: String(chatId), text });
        } else if (typeof update.update_id === 'number') {
          // Not a text message (a photo, a sticker). Still counts for the offset
          // so we do not re-fetch it forever.
          messages.push({ updateId: update.update_id, chatId: '', text: '' });
        }
      }
      return { ok: true, messages };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log.debug('getUpdates failed', { error });
      return { ok: false, messages: [], error };
    }
  }
}

/** Used by `--dry-run` and by tests: records instead of sending. */
export class NullNotifier implements TelegramNotifier {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  readonly enabled = true;

  async sendMessage(chatId: string, text: string): Promise<TelegramSendResult> {
    this.sent.push({ chatId, text });
    return { ok: true, messageId: this.sent.length };
  }
}

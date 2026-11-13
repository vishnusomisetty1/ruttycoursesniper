/**
 * Handles inbound Telegram messages: yes/no answers, and slash commands.
 *
 * SCOPE — still tightly bounded, and worth stating precisely because it is what
 * makes the bot safe to hand to someone:
 *
 *   - Only chats in the allowlist are served at all. Everyone else is ignored.
 *   - A yes/no answer can only resolve a question WE asked THAT chat.
 *   - Commands (see CommandHandler) act only on the sender's own watches.
 *   - There is no LLM here, and nothing ever reaches a shell.
 *
 * So the worst a stranger who finds the bot can do is be ignored, and the worst
 * an allowed user can do is manage their own watch list. Neither can touch the
 * machine this runs on — which is why the sniper keeps its own bot rather than
 * sharing one with a general-purpose agent.
 */
import {
  isAwaitingReply,
  WatchRepository,
  type Watch,
  type WatchOutcome,
} from '../db/watch-repo.js';
import type { TelegramNotifier, TelegramUpdateSource } from '../telegram/client.js';
import { extractIndexNumber, parseReply } from '../telegram/parse-reply.js';
import { parseCommand } from '../telegram/parse-command.js';
import type { CommandHandler } from './command-handler.js';
import { formatOutcomeRecorded, prettyTitle } from '../telegram/format.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export interface ReplyListenerOptions {
  repo: WatchRepository;
  notifier: TelegramNotifier;
  updates: TelegramUpdateSource;
  logger?: Logger;
  /**
   * Chat ids allowed to answer. Empty means "any chat that already has an
   * active watch", which is inherently self-limiting: a chat with no watches
   * has nothing to resolve.
   */
  allowedChatIds?: string[];
  readOffset?: () => number | null;
  writeOffset?: (offset: number) => void;
  /** Optional: when absent, slash commands are politely declined. */
  commands?: CommandHandler;
}

export type HandledOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'clarify'; reason: string }
  | { action: 'command'; command: string }
  | { action: 'recorded'; outcome: WatchOutcome; watch: Watch };

function describe(w: Watch): string {
  return `${w.indexNumber} — ${prettyTitle(w.courseTitle)}${w.sectionNumber ? ` sec ${w.sectionNumber}` : ''}`;
}

export class ReplyListener {
  private readonly repo: WatchRepository;
  private readonly notifier: TelegramNotifier;
  private readonly updates: TelegramUpdateSource;
  private readonly log: Logger;
  private readonly allowedChatIds: Set<string>;
  private readonly readOffset: () => number | null;
  private readonly writeOffset: (offset: number) => void;
  private readonly commands?: CommandHandler;

  constructor(options: ReplyListenerOptions) {
    this.repo = options.repo;
    this.notifier = options.notifier;
    this.updates = options.updates;
    this.log = options.logger ?? silentLogger;
    this.allowedChatIds = new Set(options.allowedChatIds ?? []);
    this.readOffset = options.readOffset ?? (() => null);
    this.writeOffset = options.writeOffset ?? (() => undefined);
    this.commands = options.commands;
  }

  private isAllowed(chatId: string): boolean {
    if (this.allowedChatIds.size > 0) return this.allowedChatIds.has(chatId);
    // No explicit allowlist: only chats that already have a watch here.
    return this.repo.listByChat(chatId).length > 0;
  }

  /** One long-poll round. Never throws. Returns how many replies were recorded. */
  async runOnce(signal?: AbortSignal): Promise<number> {
    const offset = this.readOffset();
    const result = await this.updates.fetchUpdates(offset, signal);

    if (!result.ok) {
      // 409 means another process is polling the same bot token. Worth saying
      // out loud, because the symptom (nothing happens) is otherwise baffling.
      if (result.error?.includes('409') || /terminated by other/i.test(result.error ?? '')) {
        this.log.error('another process is polling this bot token; replies will be missed', {
          error: result.error,
        });
      } else {
        this.log.debug('no updates', { error: result.error });
      }
      return 0;
    }

    let recorded = 0;
    let highest = offset === null ? -1 : offset - 1;

    for (const message of result.messages) {
      highest = Math.max(highest, message.updateId);
      if (!message.text) {
        // Say so. Skipping silently makes "did the bot even see my message?"
        // impossible to answer from the logs, which is the first thing anyone
        // asks when a sticker or photo appears to vanish.
        this.log.info('ignoring a non-text update', { updateId: message.updateId });
        continue;
      }
      try {
        const handled = await this.handleMessage(message.chatId, message.text);
        if (handled.action === 'recorded') recorded++;
      } catch (err) {
        this.log.error('failed to handle reply', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Acknowledge the batch so a restart does not replay it. Only when it
    // actually moved: an empty long-poll returns every ~25s forever, and
    // rewriting the same number each time is pointless disk churn that also
    // makes the file's timestamp look like "we just received something".
    const next = highest + 1;
    if (highest >= 0 && next !== offset) this.writeOffset(next);
    return recorded;
  }

  /** Decide what a single inbound message means. Exposed for tests. */
  async handleMessage(chatId: string, text: string): Promise<HandledOutcome> {
    if (!this.isAllowed(chatId)) {
      // Say WHICH rule turned them away: this log line is how you onboard
      // someone new, by reading their chat id out of it.
      this.log.warn('ignoring message from a chat that is not allowed', {
        chatId,
        reason:
          this.allowedChatIds.size > 0
            ? 'not in REPLY_ALLOWED_CHAT_IDS — add this chatId there to grant access'
            : 'no allowlist set, and this chat has no watches',
      });
      return { action: 'ignored', reason: 'chat not allowed' };
    }

    // A slash command is unambiguous, so it takes precedence over yes/no.
    const command = parseCommand(text);
    if (command) {
      if (!this.commands) {
        await this.notifier.sendMessage(
          chatId,
          'Commands are not enabled here — I only understand <b>yes</b> and <b>no</b>.',
        );
        return { action: 'ignored', reason: 'commands not enabled' };
      }
      this.log.info('running telegram command', { chatId, command: command.name });
      await this.commands.handle(chatId, command);
      return { action: 'command', command: command.name };
    }

    const intent = parseReply(text);
    const pending = this.repo.listAwaitingReply(chatId);

    // Say nothing to unrelated chatter — this is not a conversational bot. We
    // still log it, because "the bot received my message and did nothing" is
    // indistinguishable from "the bot never got it" without a line here.
    if (intent === 'unknown') {
      this.log.info('received a message that is not a yes/no answer; ignoring', {
        chatId,
        pending: pending.length,
      });
      return { action: 'ignored', reason: 'not a yes/no answer' };
    }

    if (pending.length === 0) {
      this.log.info('got a yes/no answer but nothing is awaiting one', { chatId, intent });
      await this.notifier.sendMessage(
        chatId,
        "I'm not waiting on an answer right now. Use /watch or /check to add or look up a section, or /help for everything I understand.",
      );
      return { action: 'ignored', reason: 'nothing pending' };
    }

    if (intent === 'ambiguous') {
      await this.notifier.sendMessage(
        chatId,
        'I could not tell if that was a yes or a no — reply with just <b>yes</b> or <b>no</b>.',
      );
      return { action: 'clarify', reason: 'ambiguous answer' };
    }

    // Work out WHICH section they mean before recording anything.
    const requested = extractIndexNumber(text);
    let target: Watch | undefined;

    if (requested) {
      target = pending.find((w) => w.indexNumber === requested);
      if (!target) {
        await this.notifier.sendMessage(
          chatId,
          `I am not waiting on an answer about index <code>${requested}</code>. ` +
            `Waiting on: ${pending.map((w) => w.indexNumber).join(', ')}.`,
        );
        return { action: 'clarify', reason: 'index not pending' };
      }
    } else if (pending.length === 1) {
      target = pending[0];
    } else {
      await this.notifier.sendMessage(
        chatId,
        [
          'Which one do you mean? Reply with the index number, e.g. ' +
            `"${intent} ${pending[0].indexNumber}".`,
          '',
          ...pending.map((w) => `• ${describe(w)}`),
        ].join('\n'),
      );
      return { action: 'clarify', reason: 'multiple pending' };
    }

    const outcome: WatchOutcome = intent === 'yes' ? 'registered' : 'missed';
    const updated = this.repo.recordOutcome(target.id, outcome)!;
    await this.notifier.sendMessage(chatId, formatOutcomeRecorded(updated));

    this.log.info('recorded outcome from telegram reply', {
      watchId: updated.id,
      indexNumber: updated.indexNumber,
      outcome,
      stillWatching: updated.active,
    });

    // Sanity check that the question really is closed out now.
    if (isAwaitingReply(updated)) {
      this.log.error('watch is still awaiting a reply after recording an outcome', {
        watchId: updated.id,
      });
    }

    return { action: 'recorded', outcome, watch: updated };
  }
}

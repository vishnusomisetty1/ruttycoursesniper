/**
 * Slash commands over Telegram.
 *
 * This is the same set of actions the CLI exposes, reachable from the chat the
 * alerts arrive in — so the person being notified can manage their own watches
 * without a terminal.
 *
 * The boundary still holds: every command acts ONLY on the sender's own
 * watches, arguments are validated the same way the CLI validates them, and
 * nothing here runs a shell or a model. `/stop all` is the widest verb, and it
 * cannot reach another chat's watches.
 */
import { DuplicateWatchError, WatchRepository, type Watch } from '../db/watch-repo.js';
import type { RutgersSocClient } from '../rutgers/soc-client.js';
import { formatTerm, termKey, type Term } from '../rutgers/terms.js';
import { formatMeeting, summarizeSection } from '../rutgers/normalize.js';
import type { TelegramNotifier } from '../telegram/client.js';
import {
  escapeHtml,
  formatSectionChoices,
  formatStatus,
  formatWatchCreated,
  formatWatchList,
  prettyInstructors,
  prettyTitle,
  truncateForTelegram,
} from '../telegram/format.js';
import {
  HELP_MESSAGE,
  parseTarget,
  splitTargetAndTerm,
  type BotCommand,
} from '../telegram/parse-command.js';
import { isWorkerAlive, readHeartbeat } from './heartbeat.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export interface CommandHandlerOptions {
  repo: WatchRepository;
  client: RutgersSocClient;
  notifier: TelegramNotifier;
  defaultTerm: Term;
  databasePath: string;
  pollIntervalSeconds: number;
  logger?: Logger;
}

export class CommandHandler {
  private readonly repo: WatchRepository;
  private readonly client: RutgersSocClient;
  private readonly notifier: TelegramNotifier;
  private readonly defaultTerm: Term;
  private readonly databasePath: string;
  private readonly pollIntervalSeconds: number;
  private readonly log: Logger;

  constructor(options: CommandHandlerOptions) {
    this.repo = options.repo;
    this.client = options.client;
    this.notifier = options.notifier;
    this.defaultTerm = options.defaultTerm;
    this.databasePath = options.databasePath;
    this.pollIntervalSeconds = options.pollIntervalSeconds;
    this.log = options.logger ?? silentLogger;
  }

  /** Run a command and reply. Never throws: a failure becomes a message. */
  async handle(chatId: string, command: BotCommand): Promise<string> {
    let reply: string;
    try {
      reply = await this.run(chatId, command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('command failed', { command: command.name, error: message });
      reply =
        `⚠️ Something went wrong running /${escapeHtml(command.name)}.\n\n` +
        `<code>${escapeHtml(message)}</code>`;
    }
    await this.notifier.sendMessage(chatId, reply);
    return reply;
  }

  private async run(chatId: string, command: BotCommand): Promise<string> {
    switch (command.name) {
      case 'help':
        return HELP_MESSAGE;
      case 'list':
        return formatWatchList(this.repo.listByChat(chatId));
      case 'pending':
        return this.pending(chatId);
      case 'status':
        return this.status(chatId);
      case 'check':
        return this.check(command.arg);
      case 'watch':
        return this.watch(chatId, command.arg);
      case 'stop':
        return this.stop(chatId, command.arg);
    }
  }

  private pending(chatId: string): string {
    const waiting = this.repo.listAwaitingReply(chatId);
    if (waiting.length === 0) return '✅ Nothing is waiting on an answer.';
    return truncateForTelegram(
      [
        `<b>Waiting on your answer (${waiting.length})</b>`,
        '',
        ...waiting.map(
          (w) =>
            `❓ <code>${escapeHtml(w.indexNumber)}</code> — ${escapeHtml(prettyTitle(w.courseTitle))}`,
        ),
        '',
        'Reply <b>yes</b> or <b>no</b> (add the index if more than one).',
      ].join('\n'),
    );
  }

  /** Worker health plus a live check of this chat's watches. */
  private async status(chatId: string): Promise<string> {
    const watches = this.repo.listByChat(chatId);
    const beat = readHeartbeat(this.databasePath);
    const alive = isWorkerAlive(beat);

    const live = new Map<string, boolean>();
    let liveFailed = false;
    const terms = new Map<string, Term>();
    for (const w of watches) {
      terms.set(termKey({ year: w.year, term: w.term, campus: w.campus }), {
        year: w.year,
        term: w.term,
        campus: w.campus,
      });
    }
    for (const [key, t] of terms) {
      try {
        const open = await this.client.fetchOpenIndexes(t);
        for (const w of watches) {
          if (termKey({ year: w.year, term: w.term, campus: w.campus }) === key) {
            live.set(w.indexNumber, open.has(w.indexNumber));
          }
        }
      } catch {
        liveFailed = true;
      }
    }

    const openNow = watches.filter((w) => live.get(w.indexNumber) ?? w.lastStatus === 'open').length;

    const lines = [
      formatStatus({
        workerRunning: alive,
        workerDetail: alive
          ? `pid ${beat!.pid}`
          : 'not running — alerts are NOT being delivered',
        activeWatches: watches.length,
        openNow,
        lastPollAt: beat?.lastPollAt ?? null,
        consecutiveFailures: beat?.consecutiveFailures ?? 0,
        pollIntervalSeconds: beat?.currentPollIntervalSeconds ?? this.pollIntervalSeconds,
      }),
    ];

    if (watches.length > 0) {
      lines.push('');
      for (const w of watches) {
        const isOpen = live.get(w.indexNumber);
        const dot = isOpen === undefined ? '⚪️' : isOpen ? '🟢' : '🔴';
        lines.push(
          `${dot} <code>${escapeHtml(w.indexNumber)}</code> ${escapeHtml(prettyTitle(w.courseTitle))}` +
            (w.openCount > 0 ? ` · opened ${w.openCount}×` : ''),
        );
      }
    }
    if (liveFailed) lines.push('', '⚠️ Could not reach Rutgers just now; showing the last poll.');

    return truncateForTelegram(lines.join('\n'));
  }

  /** Read-only lookup. Creates nothing. */
  private async check(arg: string): Promise<string> {
    const { target: rest, term } = splitTargetAndTerm(arg, this.defaultTerm);
    const target = parseTarget(rest);
    if (target.kind === 'missing') return 'Usage: /check <code>12845</code> or /check <code>01:640:135</code>';
    if (target.kind === 'invalid') return `⚠️ ${escapeHtml(target.reason)}`;

    if (target.kind === 'index') {
      const section = await this.client.getSectionByIndex(target.indexNumber, term);
      if (!section) {
        return `No section with index <code>${escapeHtml(target.indexNumber)}</code> in ${escapeHtml(formatTerm(term))}.`;
      }
      return truncateForTelegram(
        [
          `${section.isOpen ? '🟢 <b>OPEN</b>' : '🔴 <b>Closed</b>'} — ${escapeHtml(prettyTitle(section.courseTitle))}`,
          `Section ${escapeHtml(section.sectionNumber)} · index <code>${escapeHtml(section.indexNumber)}</code>`,
          `Instructor: ${escapeHtml(prettyInstructors(section.instructors))}`,
          section.meetings.length > 0
            ? `Meets: ${escapeHtml(section.meetings.map(formatMeeting).join('; '))}`
            : 'Meets: TBA',
          '',
          'Read-only — nothing is being watched.',
        ].join('\n'),
      );
    }

    const sections = await this.client.getSectionsByCourseCode(
      target.courseString,
      term,
    );
    if (sections.length === 0) {
      return `No sections found for <code>${escapeHtml(target.courseString)}</code>.`;
    }
    return truncateForTelegram(
      [
        `<b>${escapeHtml(target.courseString)}</b> — ${escapeHtml(prettyTitle(sections[0].courseTitle))}`,
        '',
        ...sections.map((s) => `${s.isOpen ? '🟢' : '🔴'} ${escapeHtml(summarizeSection(s))}`),
        '',
        'Read-only — nothing is being watched.',
      ].join('\n'),
    );
  }

  private async watch(chatId: string, arg: string): Promise<string> {
    const { target: rest, term } = splitTargetAndTerm(arg, this.defaultTerm);
    const target = parseTarget(rest);
    if (target.kind === 'missing') {
      return 'Usage: /watch <code>12845</code>, or /watch <code>01:640:135</code> to see a course\'s sections.';
    }
    if (target.kind === 'invalid') return `⚠️ ${escapeHtml(target.reason)}`;

    // A course code never creates a watch on its own — the human picks.
    if (target.kind === 'course') {
      const sections = await this.client.getSectionsByCourseCode(
        target.courseString,
        term,
      );
      if (sections.length === 0) {
        return `No sections found for <code>${escapeHtml(target.courseString)}</code> in ${escapeHtml(formatTerm(term))}.`;
      }
      return formatSectionChoices(target.courseString, sections, term);
    }

    const section = await this.client.getSectionByIndex(target.indexNumber, term);
    if (!section) {
      return `No section with index <code>${escapeHtml(target.indexNumber)}</code> in ${escapeHtml(formatTerm(term))}. Double-check the number and the term.`;
    }

    try {
      this.repo.create({
        indexNumber: target.indexNumber,
        courseCode: section.courseString,
        courseTitle: section.courseTitle,
        sectionNumber: section.sectionNumber,
        instructors: prettyInstructors(section.instructors),
        year: term.year,
        term: term.term,
        campus: term.campus,
        chatId,
        initialStatus: section.isOpen ? 'open' : 'closed',
      });
    } catch (err) {
      if (err instanceof DuplicateWatchError) {
        return `You are already watching index <code>${escapeHtml(target.indexNumber)}</code>.`;
      }
      throw err;
    }

    this.log.info('watch created from telegram', { chatId, indexNumber: target.indexNumber });
    return formatWatchCreated(section, term);
  }

  private stop(chatId: string, arg: string): string {
    const { target: rest, term } = splitTargetAndTerm(arg, this.defaultTerm);
    const target = parseTarget(rest, { allowAll: true });
    if (target.kind === 'missing') {
      return 'Usage: /stop <code>12845</code>, or /stop <code>all</code> to stop everything.';
    }
    if (target.kind === 'invalid') return `⚠️ ${escapeHtml(target.reason)}`;

    if (target.kind === 'all') {
      const stopped = this.repo.deactivateAllForChat(chatId);
      return stopped === 0
        ? 'You had no active watches to stop.'
        : `🛑 Stopped all ${stopped} watch(es).`;
    }
    if (target.kind === 'course') {
      return 'Give me the index number of the section to stop, e.g. /stop <code>12845</code>. Use /list to see them.';
    }

    // Prefer the configured term, then any term — people just say "stop 12845".
    let stopped = this.repo.deactivate(chatId, target.indexNumber, term);
    if (stopped === 0) stopped = this.repo.deactivate(chatId, target.indexNumber);

    return stopped > 0
      ? `🛑 Stopped watching index <code>${escapeHtml(target.indexNumber)}</code>.`
      : `You are not watching index <code>${escapeHtml(target.indexNumber)}</code>.`;
  }
}

export type { Watch };

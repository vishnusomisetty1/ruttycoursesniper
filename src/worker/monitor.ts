/**
 * The monitoring service.
 *
 * This is plain, deterministic TypeScript — no LLM is involved in a poll. Each
 * cycle is cheap and predictable:
 *
 *   1. Read active watches from SQLite.
 *   2. Group them by term (year + term + campus).
 *   3. For each group make ONE request to openSections.json, which returns every
 *      open index number for that term. Watching 100 sections therefore costs
 *      one request, not 100.
 *   4. Compare each watch's stored status to what we just saw.
 *   5. Alert only on a closed -> open TRANSITION, so a section that stays open
 *      does not spam you every 30 seconds.
 *
 * `runOnce()` contains all the logic and takes no timers, which makes the whole
 * behaviour testable without waiting in real time.
 */
import { RutgersSocClient, SocRequestError } from '../rutgers/soc-client.js';
import { termKey, type Term } from '../rutgers/terms.js';
import type { SectionInfo } from '../rutgers/types.js';
import { WatchRepository, type Watch, type WatchStatus } from '../db/watch-repo.js';
import type { TelegramNotifier } from '../telegram/client.js';
import {
  formatFailureAlert,
  formatFollowupQuestion,
  formatOpenAlert,
  formatRecovered,
  prettyInstructors,
} from '../telegram/format.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export interface MonitorOptions {
  repo: WatchRepository;
  client: RutgersSocClient;
  notifier: TelegramNotifier;
  logger?: Logger;
  /** Re-alert every this many minutes while still open. 0 disables repeats. */
  repeatAlertMinutes?: number;
  failureAlertAfterMinutes?: number;
  followupAfterMinutes?: number;
  now?: () => Date;
}

export interface CycleResult {
  checked: number;
  opened: number;
  reminders: number;
  followups: number;
  groups: number;
  errors: number;
}

export interface MonitorState {
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  failureAlertSent: boolean;
  lastError: string | null;
}

/** Placeholder used when we know the index but not yet the course details. */
function watchToSectionInfo(watch: Watch, isOpen: boolean): SectionInfo {
  return {
    indexNumber: watch.indexNumber,
    sectionNumber: watch.sectionNumber ?? '??',
    courseTitle: watch.courseTitle ?? 'Unknown course',
    courseString: watch.courseCode ?? '',
    subject: '',
    subjectDescription: null,
    courseNumber: '',
    credits: null,
    instructors: watch.instructors
      ? watch.instructors.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    meetings: [],
    isOpen,
    statusText: isOpen ? 'OPEN' : 'CLOSED',
    campus: watch.campus,
    year: watch.year,
    term: watch.term,
  };
}

export class MonitorService {
  private readonly repo: WatchRepository;
  private readonly client: RutgersSocClient;
  private readonly notifier: TelegramNotifier;
  private readonly log: Logger;
  private readonly repeatAlertMs: number;
  private readonly failureAlertAfterMs: number;
  private readonly followupAfterMs: number;
  private readonly now: () => Date;

  readonly state: MonitorState = {
    lastPollAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    firstFailureAt: null,
    failureAlertSent: false,
    lastError: null,
  };

  constructor(options: MonitorOptions) {
    this.repo = options.repo;
    this.client = options.client;
    this.notifier = options.notifier;
    this.log = options.logger ?? silentLogger;
    this.repeatAlertMs = (options.repeatAlertMinutes ?? 0) * 60_000;
    this.failureAlertAfterMs = (options.failureAlertAfterMinutes ?? 15) * 60_000;
    this.followupAfterMs = (options.followupAfterMinutes ?? 0) * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  /** One full polling cycle. Never throws: failures are logged and counted. */
  async runOnce(): Promise<CycleResult> {
    const result: CycleResult = {
      checked: 0,
      opened: 0,
      reminders: 0,
      followups: 0,
      groups: 0,
      errors: 0,
    };
    this.state.lastPollAt = this.now().toISOString();

    const watches = this.repo.listActive();
    if (watches.length === 0) {
      this.log.debug('no active watches');
      this.noteSuccess();
      return result;
    }

    // Group watches that can share a single HTTP request.
    const groups = new Map<string, { term: Term; watches: Watch[] }>();
    for (const w of watches) {
      const term: Term = { year: w.year, term: w.term, campus: w.campus };
      const key = termKey(term);
      const bucket = groups.get(key);
      if (bucket) bucket.watches.push(w);
      else groups.set(key, { term, watches: [w] });
    }
    result.groups = groups.size;

    let anySuccess = false;

    for (const { term, watches: groupWatches } of groups.values()) {
      let openIndexes: Set<string>;
      try {
        openIndexes = await this.client.fetchOpenIndexes(term);
        anySuccess = true;
      } catch (err) {
        // One bad term must not stop the others, and must not crash the worker.
        result.errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.state.lastError = message;
        this.log.error('failed to fetch open sections', { term: termKey(term), error: message });
        continue;
      }

      for (const watch of groupWatches) {
        try {
          const outcome = await this.evaluateWatch(watch, openIndexes, term);
          result.checked++;
          if (outcome === 'opened') result.opened++;
          if (outcome === 'reminded') result.reminders++;
        } catch (err) {
          result.errors++;
          this.log.error('failed to evaluate watch', {
            watchId: watch.id,
            indexNumber: watch.indexNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Follow-ups are driven by the clock, not by this cycle's HTTP result, so
    // they still go out on a cycle where Rutgers was unreachable.
    result.followups = await this.sendDueFollowups();

    if (anySuccess) await this.noteSuccess();
    else await this.noteFailure();

    this.log.info('poll cycle complete', { ...result });
    return result;
  }

  /**
   * Ask "did you get in?" for every watch whose question has come due.
   *
   * The question is only scheduled when an open alert was actually delivered,
   * so we never ask about an alert the user never received.
   */
  private async sendDueFollowups(): Promise<number> {
    if (this.followupAfterMs <= 0) return 0;

    let sent = 0;
    for (const watch of this.repo.listFollowupDue(this.now())) {
      try {
        const delivered = await this.notifier.sendMessage(
          watch.chatId,
          formatFollowupQuestion(watch),
        );
        if (delivered.ok) {
          // Only mark it asked if it actually arrived, otherwise we would wait
          // forever for an answer to a question nobody saw.
          this.repo.markFollowupSent(watch.id);
          sent++;
          this.log.info('asked follow-up question', {
            watchId: watch.id,
            indexNumber: watch.indexNumber,
          });
        } else {
          this.log.error('failed to deliver follow-up question', {
            watchId: watch.id,
            indexNumber: watch.indexNumber,
            error: delivered.error,
          });
        }
      } catch (err) {
        this.log.error('failed to send follow-up question', {
          watchId: watch.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return sent;
  }

  /** Decide what (if anything) to do about a single watch. */
  private async evaluateWatch(
    watch: Watch,
    openIndexes: ReadonlySet<string>,
    term: Term,
  ): Promise<'opened' | 'reminded' | 'unchanged'> {
    const isOpen = openIndexes.has(watch.indexNumber);
    const status: WatchStatus = isOpen ? 'open' : 'closed';

    // A transition is "was not open, is open now". `unknown` counts as not-open
    // so the very first observation of an open section still alerts.
    const justOpened = isOpen && watch.lastStatus !== 'open';

    this.repo.recordCheck(watch.id, status, { justOpened });

    if (justOpened) {
      const section = await this.describeSection(watch, term, isOpen);
      const sent = await this.notifier.sendMessage(watch.chatId, formatOpenAlert(section));
      // Scheduling the follow-up here (not on the check) means we only ever ask
      // about an alert that actually reached them.
      if (sent.ok) this.repo.markNotified(watch.id, this.followupAfterMs);
      else {
        this.log.error('failed to deliver open alert', {
          watchId: watch.id,
          indexNumber: watch.indexNumber,
          error: sent.error,
        });
      }
      this.log.info('section opened', {
        watchId: watch.id,
        indexNumber: watch.indexNumber,
        notified: sent.ok,
      });
      return 'opened';
    }

    // Keep nagging while it is STILL open and they have not confirmed a seat.
    //
    // Two deliberate limits on this:
    //
    //   - Only while `isOpen`. Repeating "it's open!" about a section that has
    //     closed again would simply be false, and it is the follow-up question
    //     ("did you get in?") that covers that case.
    //   - Answering "yes" sets outcome='registered', which deactivates the
    //     watch, so it drops out of listActive() and the nagging stops. "No"
    //     keeps the watch active, so we keep trying — which is the point.
    if (isOpen && this.repeatAlertMs > 0 && watch.lastStatus === 'open' && watch.openedAt) {
      // Time since the last thing we sent about this opening: the most recent
      // repeat if there has been one, otherwise the original alert.
      const lastPing = new Date(watch.reminderSentAt ?? watch.openedAt).getTime();
      if (this.now().getTime() - lastPing >= this.repeatAlertMs) {
        const section = await this.describeSection(watch, term, true);
        const sent = await this.notifier.sendMessage(
          watch.chatId,
          formatOpenAlert(section, { reminder: true, repeatNumber: watch.repeatCount + 1 }),
        );
        if (sent.ok) {
          this.repo.markReminderSent(watch.id);
          this.log.info('re-alerted about a still-open section', {
            watchId: watch.id,
            indexNumber: watch.indexNumber,
            repeatNumber: watch.repeatCount + 1,
          });
        } else {
          // Do NOT stamp on failure, or a delivery outage would silently eat
          // this opening's entire chain of reminders.
          this.log.error('failed to deliver repeat alert', {
            watchId: watch.id,
            indexNumber: watch.indexNumber,
            error: sent.error,
          });
        }
        return 'reminded';
      }
    }

    return 'unchanged';
  }

  /**
   * Get full details for the alert. If the watch already has cached metadata we
   * use it, so an alert is never delayed by a 21 MB catalog download.
   */
  private async describeSection(watch: Watch, term: Term, isOpen: boolean): Promise<SectionInfo> {
    if (watch.courseTitle && watch.sectionNumber) {
      return watchToSectionInfo(watch, isOpen);
    }
    try {
      const section = await this.client.getSectionByIndex(watch.indexNumber, term);
      if (section) {
        this.repo.updateMetadata(watch.id, {
          courseTitle: section.courseTitle,
          courseCode: section.courseString,
          sectionNumber: section.sectionNumber,
          instructors: prettyInstructors(section.instructors),
        });
        return { ...section, isOpen };
      }
    } catch (err) {
      this.log.warn('could not enrich section metadata; alerting with what we have', {
        indexNumber: watch.indexNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return watchToSectionInfo(watch, isOpen);
  }

  private async noteSuccess(): Promise<void> {
    const wasFailing = this.state.failureAlertSent;
    this.state.consecutiveFailures = 0;
    this.state.firstFailureAt = null;
    this.state.lastSuccessAt = this.now().toISOString();
    this.state.lastError = null;

    if (wasFailing) {
      this.state.failureAlertSent = false;
      await this.broadcast(formatRecovered());
      this.log.info('monitor recovered from sustained failure');
    }
  }

  private async noteFailure(): Promise<void> {
    this.state.consecutiveFailures++;
    if (!this.state.firstFailureAt) this.state.firstFailureAt = this.now().toISOString();

    const failingForMs = this.now().getTime() - new Date(this.state.firstFailureAt).getTime();

    // Alert once per outage, not once per failed poll.
    if (!this.state.failureAlertSent && failingForMs >= this.failureAlertAfterMs) {
      this.state.failureAlertSent = true;
      const minutes = Math.max(1, Math.round(failingForMs / 60_000));
      await this.broadcast(
        formatFailureAlert(minutes, this.state.consecutiveFailures, this.state.lastError ?? 'unknown'),
      );
      this.log.error('monitor failing continuously', {
        minutes,
        failures: this.state.consecutiveFailures,
      });
    }
  }

  /** Send an operational message to every chat that has active watches. */
  private async broadcast(text: string): Promise<void> {
    for (const chatId of this.repo.activeChatIds()) {
      await this.notifier.sendMessage(chatId, text).catch(() => undefined);
    }
  }
}

export { SocRequestError };

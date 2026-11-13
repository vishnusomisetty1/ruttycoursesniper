#!/usr/bin/env node
/**
 * Command-line interface.
 *
 * The local admin surface, for setup, scripting and debugging on the machine
 * itself. Day-to-day use goes through the Telegram slash commands instead (see
 * src/worker/command-handler.ts), which reach the same repository.
 *
 * Every command is short-lived: it opens the SQLite file, does one thing,
 * prints a result, and exits. The long-running worker is a separate process
 * (src/worker/main.ts).
 *
 * `--json` prints a machine-readable object so a caller can consume the result
 * without re-parsing prose.
 */
import { loadConfig, loadDotEnvFile } from './config.js';
import { createLogger } from './logger.js';
import { RutgersSocClient } from './rutgers/soc-client.js';
import { formatTerm, termKey, type Term } from './rutgers/terms.js';
import { summarizeSection } from './rutgers/normalize.js';
import { formatMeeting } from './rutgers/normalize.js';
import type { SectionInfo } from './rutgers/types.js';
import {
  DuplicateWatchError,
  isAwaitingReply,
  WatchRepository,
  type Watch,
} from './db/watch-repo.js';
import { TelegramClient } from './telegram/client.js';
import {
  formatOutcomeRecorded,
  formatRelative,
  formatSectionChoices,
  formatWatchCreated,
  prettyInstructors,
  prettyTitle,
} from './telegram/format.js';
import { isWorkerAlive, readHeartbeat } from './worker/heartbeat.js';
import {
  CliUsageError,
  HELP_TEXT,
  parseCheckTarget,
  parseRawArgs,
  requireCourseCode,
  requireIndexNumber,
  requireOutcome,
  resolveChatId,
  resolveTermOptions,
} from './cli/parse-args.js';

interface Output {
  ok: boolean;
  command: string;
  message: string;
  data?: unknown;
}

function emit(out: Output, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.stdout.write(out.message + '\n');
  }
}

function sectionToJson(s: SectionInfo) {
  return {
    indexNumber: s.indexNumber,
    sectionNumber: s.sectionNumber,
    courseTitle: prettyTitle(s.courseTitle),
    courseCode: s.courseString,
    instructors: s.instructors,
    meetings: s.meetings.map(formatMeeting),
    isOpen: s.isOpen,
    status: s.statusText,
  };
}

function watchToJson(w: Watch) {
  return {
    id: w.id,
    indexNumber: w.indexNumber,
    courseCode: w.courseCode,
    courseTitle: w.courseTitle ? prettyTitle(w.courseTitle) : null,
    sectionNumber: w.sectionNumber,
    instructors: w.instructors,
    year: w.year,
    term: w.term,
    campus: w.campus,
    status: w.lastStatus,
    active: w.active,
    chatId: w.chatId,
    createdAt: w.createdAt,
    lastCheckedAt: w.lastCheckedAt,
    lastNotifiedAt: w.lastNotifiedAt,
    openCount: w.openCount,
    outcome: w.outcome,
    resolvedAt: w.resolvedAt,
    awaitingReply: isAwaitingReply(w),
    followupSentAt: w.followupSentAt,
  };
}

/** One line per watch for the human-readable status report. */
function watchStatusLine(w: Watch, liveOpen: boolean | null): string {
  const dot = liveOpen === null ? (w.lastStatus === 'open' ? '🟢' : w.lastStatus === 'closed' ? '🔴' : '⚪️') : liveOpen ? '🟢' : '🔴';
  const state = liveOpen === null ? `${w.lastStatus} (last poll)` : liveOpen ? 'OPEN' : 'closed';
  const opened = w.openCount > 0 ? ` · opened ${w.openCount}× so far` : '';
  const waiting = isAwaitingReply(w) ? ' · ❓ waiting on your answer' : '';
  return (
    `  ${dot} ${w.indexNumber} — ${prettyTitle(w.courseTitle)} sec ${w.sectionNumber ?? '??'} · ${state}` +
    `\n      watching since ${formatRelative(w.createdAt)}${opened}${waiting}`
  );
}

async function main(argv: string[]): Promise<number> {
  loadDotEnvFile();

  const parsed = parseRawArgs(argv);
  const json = parsed.flags.json === true;

  if (parsed.command === 'help' || parsed.flags.help === true) {
    if (json) emit({ ok: true, command: 'help', message: HELP_TEXT }, true);
    else process.stdout.write(HELP_TEXT);
    return 0;
  }

  const config = loadConfig();
  // Logs go to stderr so they never contaminate --json output on stdout.
  const log = createLogger({ level: config.LOG_LEVEL, bindings: { component: 'cli' } });

  const defaults = {
    year: config.RUTGERS_YEAR,
    term: config.RUTGERS_TERM,
    campus: config.RUTGERS_CAMPUS,
    chatId: config.DEFAULT_TELEGRAM_CHAT_ID,
  };

  const term: Term = resolveTermOptions(parsed.flags, defaults);

  const client = new RutgersSocClient({
    baseUrl: config.SOC_BASE_URL,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    catalogCacheMs: config.CATALOG_CACHE_MINUTES * 60_000,
    logger: log.child({ component: 'soc-client' }),
  });

  // `check` is read-only by design: no database, no Telegram.
  if (parsed.command === 'check') {
    const target = parseCheckTarget(parsed.positionals);

    if (target.kind === 'index') {
      const section = await client.getSectionByIndex(target.indexNumber, term);
      if (!section) {
        emit(
          {
            ok: false,
            command: 'check',
            message: `No section with index ${target.indexNumber} found in ${formatTerm(term)}.`,
          },
          json,
        );
        return 1;
      }
      emit(
        {
          ok: true,
          command: 'check',
          message: [
            `${prettyTitle(section.courseTitle)} (${section.courseString})`,
            `Section ${section.sectionNumber} · index ${section.indexNumber}`,
            `Status: ${section.isOpen ? '🟢 OPEN' : '🔴 CLOSED'}`,
            `Instructor: ${prettyInstructors(section.instructors)}`,
            section.meetings.length > 0
              ? `Meets: ${section.meetings.map(formatMeeting).join('; ')}`
              : 'Meets: TBA',
            `Term: ${formatTerm(term)}`,
            '',
            'Read-only check — no watch was created and no Telegram message was sent.',
          ].join('\n'),
          data: { term, section: sectionToJson(section) },
        },
        json,
      );
      return 0;
    }

    const sections = await client.getSectionsByCourseCode(target.courseString, term);
    emit(
      {
        ok: sections.length > 0,
        command: 'check',
        message:
          sections.length === 0
            ? `No sections found for ${target.courseString} in ${formatTerm(term)}.`
            : [
                `${target.courseString} — ${prettyTitle(sections[0].courseTitle)} · ${formatTerm(term)}`,
                ...sections.map((s) => `  ${s.isOpen ? '🟢' : '🔴'} ${summarizeSection(s)}`),
                '',
                'Read-only check — no watch was created and no Telegram message was sent.',
              ].join('\n'),
        data: { term, sections: sections.map(sectionToJson) },
      },
      json,
    );
    return sections.length > 0 ? 0 : 1;
  }

  // Everything below touches the database.
  const repo = new WatchRepository(config.DATABASE_PATH);
  const notifier = new TelegramClient({
    botToken: config.TELEGRAM_BOT_TOKEN,
    baseUrl: config.TELEGRAM_API_BASE_URL,
    logger: log.child({ component: 'telegram' }),
  });

  try {
    switch (parsed.command) {
      case 'watch-index': {
        const indexNumber = requireIndexNumber(parsed.positionals, 'watch-index');
        const chatId = resolveChatId(parsed.flags, defaults)!;

        const section = await client.getSectionByIndex(indexNumber, term);
        if (!section) {
          emit(
            {
              ok: false,
              command: 'watch-index',
              message: `No section with index ${indexNumber} exists in ${formatTerm(term)}. Double-check the index number and the term.`,
              data: { indexNumber, term },
            },
            json,
          );
          return 1;
        }

        try {
          const watch = repo.create({
            indexNumber,
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

          if (parsed.flags.notify === true && notifier.enabled) {
            await notifier.sendMessage(chatId, formatWatchCreated(section, term));
          }

          emit(
            {
              ok: true,
              command: 'watch-index',
              message: [
                `✅ Watching index ${indexNumber} — ${prettyTitle(section.courseTitle)} (${section.courseString}) section ${section.sectionNumber}`,
                `Term: ${formatTerm(term)}`,
                `Current status: ${section.isOpen ? '🟢 OPEN — register in WebReg now' : '🔴 closed — I will alert you when it opens'}`,
              ].join('\n'),
              data: { watch: watchToJson(watch), section: sectionToJson(section) },
            },
            json,
          );
          return 0;
        } catch (err) {
          if (err instanceof DuplicateWatchError) {
            emit(
              {
                ok: false,
                command: 'watch-index',
                message: `You are already watching index ${indexNumber} for ${formatTerm(term)}.`,
                data: { watch: watchToJson(err.existing), duplicate: true },
              },
              json,
            );
            return 2;
          }
          throw err;
        }
      }

      case 'watch-course': {
        const code = requireCourseCode(parsed.positionals);
        const chatId = resolveChatId(parsed.flags, defaults, {
          required: parsed.flags.all === true,
        });

        const sections = await client.getSectionsByCourseCode(code.courseString, term);
        if (sections.length === 0) {
          emit(
            {
              ok: false,
              command: 'watch-course',
              message: `No sections found for ${code.courseString} in ${formatTerm(term)}.`,
              data: { courseCode: code.courseString, term, sections: [] },
            },
            json,
          );
          return 1;
        }

        // Without --all we never silently watch every section: we list them and
        // let the human choose. The /watch command handler does the same, so
        // "watch Calculus I" can never quietly become 57 watches.
        if (parsed.flags.all !== true) {
          emit(
            {
              ok: true,
              command: 'watch-course',
              message: [
                `${code.courseString} — ${prettyTitle(sections[0].courseTitle)} · ${formatTerm(term)}`,
                `${sections.length} section(s) found. No watch was created yet.`,
                ...sections.map((s) => `  ${s.isOpen ? '🟢' : '🔴'} ${summarizeSection(s)}`),
                '',
                'Pick the index number(s) you want, then run:',
                `  npm run cli -- watch-index <index> --year ${term.year} --term ${term.term} --campus ${term.campus}`,
              ].join('\n'),
              data: {
                courseCode: code.courseString,
                term,
                requiresSelection: true,
                sections: sections.map(sectionToJson),
                telegramMessage: formatSectionChoices(code.courseString, sections, term),
              },
            },
            json,
          );
          return 0;
        }

        const created: Watch[] = [];
        const duplicates: string[] = [];
        for (const s of sections) {
          try {
            created.push(
              repo.create({
                indexNumber: s.indexNumber,
                courseCode: s.courseString,
                courseTitle: s.courseTitle,
                sectionNumber: s.sectionNumber,
                instructors: prettyInstructors(s.instructors),
                year: term.year,
                term: term.term,
                campus: term.campus,
                chatId: chatId!,
                initialStatus: s.isOpen ? 'open' : 'closed',
              }),
            );
          } catch (err) {
            if (err instanceof DuplicateWatchError) duplicates.push(s.indexNumber);
            else throw err;
          }
        }

        emit(
          {
            ok: true,
            command: 'watch-course',
            message: [
              `✅ Watching ${created.length} section(s) of ${code.courseString} for ${formatTerm(term)}.`,
              duplicates.length > 0 ? `Already watched: ${duplicates.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            data: {
              courseCode: code.courseString,
              created: created.map(watchToJson),
              duplicates,
            },
          },
          json,
        );
        return 0;
      }

      case 'list': {
        const allChats = parsed.flags['all-chats'] === true;
        const includeInactive = parsed.flags['include-inactive'] === true;
        const chatId = resolveChatId(parsed.flags, defaults, { required: !allChats });

        const watches = allChats
          ? repo.listAll({ includeInactive })
          : repo.listByChat(chatId!, { includeInactive });

        emit(
          {
            ok: true,
            command: 'list',
            message:
              watches.length === 0
                ? 'No Rutgers watches found.'
                : [
                    `${watches.length} watch(es):`,
                    ...watches.map((w) => {
                      const dot =
                        w.lastStatus === 'open' ? '🟢' : w.lastStatus === 'closed' ? '🔴' : '⚪️';
                      const inactive = w.active ? '' : ' [stopped]';
                      return `  ${dot} ${w.indexNumber} — ${prettyTitle(w.courseTitle)} (${w.courseCode ?? 'n/a'}) sec ${w.sectionNumber ?? '??'} · ${formatTerm({ year: w.year, term: w.term, campus: w.campus })}${inactive}`;
                    }),
                  ].join('\n'),
            data: { watches: watches.map(watchToJson) },
          },
          json,
        );
        return 0;
      }

      case 'stop': {
        const chatId = resolveChatId(parsed.flags, defaults)!;

        if (parsed.flags.all === true) {
          const stopped = repo.deactivateAllForChat(chatId);
          emit(
            {
              ok: true,
              command: 'stop',
              message:
                stopped === 0
                  ? 'You had no active watches to stop.'
                  : `🛑 Stopped all ${stopped} watch(es).`,
              data: { stopped },
            },
            json,
          );
          return 0;
        }

        const indexNumber = requireIndexNumber(parsed.positionals, 'stop');
        // Try the specific term first, then fall back to any term, because
        // people usually just say "stop watching 12845".
        let stopped = repo.deactivate(chatId, indexNumber, term);
        if (stopped === 0) stopped = repo.deactivate(chatId, indexNumber);

        emit(
          {
            ok: stopped > 0,
            command: 'stop',
            message:
              stopped > 0
                ? `🛑 Stopped watching index ${indexNumber}.`
                : `You are not currently watching index ${indexNumber}.`,
            data: { indexNumber, stopped },
          },
          json,
        );
        return stopped > 0 ? 0 : 1;
      }

      case 'status': {
        const allChats = parsed.flags['all-chats'] === true;
        const chatId = resolveChatId(parsed.flags, defaults, { required: false });

        const beat = readHeartbeat(config.DATABASE_PATH);
        const alive = isWorkerAlive(beat);
        const watches =
          chatId && !allChats ? repo.listByChat(chatId) : repo.listAll();

        // Ask Rutgers directly so the report reflects right now rather than
        // whatever the worker happened to see on its last poll. One request per
        // distinct term, exactly like the worker does.
        const live = new Map<string, boolean>();
        let liveError: string | null = null;
        if (parsed.flags.cached !== true && watches.length > 0) {
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
              const openIndexes = await client.fetchOpenIndexes(t);
              for (const w of watches) {
                if (termKey({ year: w.year, term: w.term, campus: w.campus }) === key) {
                  live.set(w.indexNumber + key, openIndexes.has(w.indexNumber));
                }
              }
            } catch (err) {
              // A live lookup failure must not break the whole report: fall back
              // to the worker's cached view and say so.
              liveError = err instanceof Error ? err.message : String(err);
              log.warn('live status lookup failed; falling back to last poll', { error: liveError });
            }
          }
        }

        const liveFor = (w: Watch): boolean | null => {
          const key = w.indexNumber + termKey({ year: w.year, term: w.term, campus: w.campus });
          return live.has(key) ? live.get(key)! : null;
        };

        const openNow = watches.filter((w) => {
          const l = liveFor(w);
          return l === null ? w.lastStatus === 'open' : l;
        }).length;
        const awaiting = watches.filter(isAwaitingReply);

        const backingOff =
          beat?.currentPollIntervalSeconds !== undefined &&
          beat.currentPollIntervalSeconds > config.POLL_INTERVAL_SECONDS;

        const detail = alive
          ? `pid ${beat!.pid}, last poll ${beat!.lastPollAt ? formatRelative(beat!.lastPollAt) : 'pending'}`
          : beat
            ? `heartbeat is stale (last update ${beat.updatedAt}) — start it with: pm2 start ecosystem.config.cjs`
            : 'no heartbeat found — start it with: npm run worker (or pm2 start ecosystem.config.cjs)';

        emit(
          {
            ok: true,
            command: 'status',
            message: [
              `Worker: ${alive ? '🟢 running' : '🔴 not running'} — ${detail}`,
              `Active watches: ${watches.length}`,
              `Currently open: ${openNow}`,
              ...watches.map((w) => watchStatusLine(w, liveFor(w))),
              backingOff
                ? `Poll interval: every ${beat!.currentPollIntervalSeconds}s ⚠️ (backing off from ${config.POLL_INTERVAL_SECONDS}s after ${beat!.consecutiveFailures} failed cycle(s))`
                : `Poll interval: every ${config.POLL_INTERVAL_SECONDS}s`,
              `Telegram configured: ${notifier.enabled ? 'yes' : 'no (TELEGRAM_BOT_TOKEN is unset)'}`,
              awaiting.length > 0
                ? `❓ Waiting on your answer for: ${awaiting.map((w) => w.indexNumber).join(', ')}`
                : '',
              liveError
                ? `⚠️ Could not reach Rutgers for a live check (${liveError}) — showing last polled status.`
                : '',
              beat?.consecutiveFailures
                ? `⚠️ Consecutive failures: ${beat.consecutiveFailures} (last error: ${beat.lastError ?? 'unknown'})`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
            data: {
              workerRunning: alive,
              heartbeat: beat,
              activeWatches: watches.length,
              openNow,
              live: parsed.flags.cached !== true && liveError === null,
              liveError,
              pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
              currentPollIntervalSeconds:
                beat?.currentPollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS,
              backingOff,
              telegramConfigured: notifier.enabled,
              awaitingReply: awaiting.map(watchToJson),
              watches: watches.map((w) => ({
                ...watchToJson(w),
                liveStatus: liveFor(w) === null ? null : liveFor(w) ? 'open' : 'closed',
              })),
            },
          },
          json,
        );
        return 0;
      }

      case 'resolve': {
        const chatId = resolveChatId(parsed.flags, defaults)!;
        const indexNumber = requireIndexNumber(parsed.positionals, 'resolve');
        const outcome = requireOutcome(parsed.flags);

        const watch = repo.findActiveByIndex(chatId, indexNumber, term);
        if (!watch) {
          emit(
            {
              ok: false,
              command: 'resolve',
              message: `You are not currently watching index ${indexNumber}, so there is nothing to answer.`,
              data: { indexNumber, outcome },
            },
            json,
          );
          return 1;
        }

        const updated = repo.recordOutcome(watch.id, outcome)!;

        if (parsed.flags.notify === true && notifier.enabled) {
          await notifier.sendMessage(chatId, formatOutcomeRecorded(updated));
        }

        emit(
          {
            ok: true,
            command: 'resolve',
            message:
              outcome === 'registered'
                ? `🎉 Recorded — you got into ${prettyTitle(updated.courseTitle)} (index ${indexNumber}). Stopped watching it.`
                : `👍 Recorded — you did not get index ${indexNumber}. Still watching for the next opening.`,
            data: { watch: watchToJson(updated), outcome, stillWatching: updated.active },
          },
          json,
        );
        return 0;
      }

      case 'pending': {
        const allChats = parsed.flags['all-chats'] === true;
        const chatId = resolveChatId(parsed.flags, defaults, { required: !allChats });

        const waiting = repo.listAwaitingReply(allChats ? undefined : chatId);

        emit(
          {
            ok: true,
            command: 'pending',
            message:
              waiting.length === 0
                ? 'Nothing is waiting on an answer.'
                : [
                    `${waiting.length} section(s) waiting on a "did you get in?" answer:`,
                    ...waiting.map(
                      (w) =>
                        `  ❓ ${w.indexNumber} — ${prettyTitle(w.courseTitle)} sec ${w.sectionNumber ?? '??'} · asked ${w.followupSentAt ? formatRelative(w.followupSentAt) : 'just now'}`,
                    ),
                  ].join('\n'),
            data: { pending: waiting.map(watchToJson) },
          },
          json,
        );
        return 0;
      }

      default: {
        process.stdout.write(HELP_TEXT);
        return 0;
      }
    }
  } finally {
    repo.close();
  }
}

const argv = process.argv.slice(2);
main(argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    const isUsage = err instanceof CliUsageError;
    const message = err instanceof Error ? err.message : String(err);
    const wantsJson = argv.includes('--json');

    if (wantsJson) {
      process.stdout.write(
        JSON.stringify({ ok: false, command: argv[0] ?? 'help', message, error: message }, null, 2) +
          '\n',
      );
    } else {
      process.stderr.write(`Error: ${message}\n`);
      if (isUsage) process.stderr.write(`\nRun "npm run cli -- help" for usage.\n`);
    }
    process.exit(isUsage ? 64 : 1);
  });

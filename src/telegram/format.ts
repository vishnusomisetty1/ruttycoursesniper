/**
 * Telegram message formatting.
 *
 * All pure functions — no network — so they are easy to test.
 *
 * We send with parse_mode "HTML" and escape every value that came from Rutgers
 * or from the user. Escaping matters because a course title containing "&" or
 * "<" would otherwise make Telegram reject the whole message.
 */
import type { SectionInfo } from '../rutgers/types.js';
import { formatMeeting } from '../rutgers/normalize.js';
import { CAMPUS_LABELS, formatTerm, type Term } from '../rutgers/terms.js';
import type { Watch } from '../db/watch-repo.js';

/** Escape the five characters Telegram's HTML mode treats specially. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Telegram rejects messages over 4096 characters. */
export const TELEGRAM_MAX_LENGTH = 4096;

export function truncateForTelegram(text: string, max = TELEGRAM_MAX_LENGTH): string {
  if (text.length <= max) return text;
  const suffix = '\n… (truncated)';
  return text.slice(0, max - suffix.length) + suffix;
}

function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Rutgers returns SHOUTED titles like "CALC I LIFE&SOC SCI". */
export function prettyTitle(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return 'Unknown course';
  // Only de-shout if it is actually all-caps.
  return raw === raw.toUpperCase() ? titleCase(raw) : raw;
}

export function prettyInstructors(names: string[] | string | null | undefined): string {
  const list = Array.isArray(names)
    ? names
    : (names ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  if (list.length === 0) return 'TBA';
  // Rutgers gives "LAST, FIRST"; keep it but make it readable.
  return list.map((n) => titleCase(n)).join(', ');
}

/**
 * The main alert. Matches the format requested in the project brief.
 *
 * Deliberately contains NO login link automation and NO credentials — it tells
 * the human to go register themselves.
 */
export function formatOpenAlert(
  section: SectionInfo,
  opts: { reminder?: boolean; repeatNumber?: number } = {},
): string {
  const header = opts.reminder
    ? `🔔 Still open${opts.repeatNumber ? ` (reminder #${opts.repeatNumber})` : ''}`
    : '🚨 Rutgers section opened';

  const lines = [
    `<b>${header}</b>`,
    '',
    `Course: ${escapeHtml(prettyTitle(section.courseTitle))}`,
    `Course code: ${escapeHtml(section.courseString || 'n/a')}`,
    `Section: ${escapeHtml(section.sectionNumber)}`,
    `Index: <code>${escapeHtml(section.indexNumber)}</code>`,
    `Instructor: ${escapeHtml(prettyInstructors(section.instructors))}`,
  ];

  if (section.meetings.length > 0) {
    lines.push(`Meets: ${escapeHtml(section.meetings.map(formatMeeting).join('; '))}`);
  }

  lines.push(
    `Term: ${escapeHtml(formatTerm({ year: section.year, term: section.term, campus: section.campus }))}`,
    '',
    'Open WebReg and register manually now.',
  );

  // On a repeat we say plainly how to make it stop, otherwise a well-meaning
  // nag every few minutes just reads as a bot that will not shut up.
  if (opts.reminder) {
    lines.push(
      '',
      `Reply <b>yes</b> once you are in and I will stop — or <code>/cancel ${escapeHtml(section.indexNumber)}</code> to drop this watch.`,
    );
  }

  return truncateForTelegram(lines.join('\n'));
}

/**
 * The follow-up question, sent a while after an open alert.
 *
 * Phrased so a plain "yes" or "no" is a usable answer, because that is what
 * people actually type back into Telegram.
 */
export function formatFollowupQuestion(watch: Watch): string {
  const title = prettyTitle(watch.courseTitle);
  const sec = watch.sectionNumber ? ` sec ${watch.sectionNumber}` : '';
  const stillOpen = watch.lastStatus === 'open';

  return truncateForTelegram(
    [
      '❓ <b>Did you get in?</b>',
      '',
      `I alerted you that <b>${escapeHtml(title)}</b>${escapeHtml(sec)} ` +
        `(index <code>${escapeHtml(watch.indexNumber)}</code>) opened.`,
      '',
      stillOpen
        ? '🟢 It is still open right now.'
        : '🔴 It has closed again since then.',
      '',
      'Reply <b>yes</b> if you registered — I will stop watching it.',
      'Reply <b>no</b> and I will keep watching for the next opening.',
    ].join('\n'),
  );
}

/** Confirmation after the human answers the follow-up question. */
export function formatOutcomeRecorded(watch: Watch): string {
  const title = prettyTitle(watch.courseTitle);
  if (watch.outcome === 'registered') {
    return truncateForTelegram(
      [
        `🎉 <b>Nice — you're in ${escapeHtml(title)}</b>`,
        '',
        `I have stopped watching index <code>${escapeHtml(watch.indexNumber)}</code>.`,
        'Ask me to watch it again any time if your plans change.',
      ].join('\n'),
    );
  }
  return truncateForTelegram(
    [
      `👍 <b>Still watching ${escapeHtml(title)}</b>`,
      '',
      `Index <code>${escapeHtml(watch.indexNumber)}</code> stays on the list — ` +
        'I will alert you the next time it opens.',
    ].join('\n'),
  );
}

/** Shown when a course code matches several sections and we need a choice. */
export function formatSectionChoices(
  courseString: string,
  sections: SectionInfo[],
  term: Term,
): string {
  if (sections.length === 0) {
    return truncateForTelegram(
      `No sections found for <b>${escapeHtml(courseString)}</b> in ${escapeHtml(formatTerm(term))}.`,
    );
  }

  const title = prettyTitle(sections[0].courseTitle);
  const lines = [
    `<b>${escapeHtml(courseString)} — ${escapeHtml(title)}</b>`,
    `${escapeHtml(formatTerm(term))} · ${sections.length} section${sections.length === 1 ? '' : 's'}`,
    '',
  ];

  for (const s of sections) {
    const dot = s.isOpen ? '🟢' : '🔴';
    const meet = s.meetings.length > 0 ? ` · ${s.meetings.map(formatMeeting).join('; ')}` : '';
    lines.push(
      `${dot} sec ${escapeHtml(s.sectionNumber)} · index <code>${escapeHtml(s.indexNumber)}</code> · ` +
        `${escapeHtml(prettyInstructors(s.instructors))}${escapeHtml(meet)}`,
    );
  }

  lines.push('', 'Reply with the index number(s) you want me to watch.');
  return truncateForTelegram(lines.join('\n'));
}

export function formatWatchList(watches: Watch[]): string {
  if (watches.length === 0) {
    return 'You are not watching any Rutgers sections right now.';
  }

  const lines = [`<b>Your Rutgers watches (${watches.length})</b>`, ''];
  for (const w of watches) {
    const dot = w.lastStatus === 'open' ? '🟢' : w.lastStatus === 'closed' ? '🔴' : '⚪️';
    const title = w.courseTitle ? prettyTitle(w.courseTitle) : 'Unknown course';
    const code = w.courseCode ? ` (${w.courseCode})` : '';
    const sec = w.sectionNumber ? ` sec ${w.sectionNumber}` : '';
    lines.push(
      `${dot} <code>${escapeHtml(w.indexNumber)}</code> — ${escapeHtml(title)}${escapeHtml(code)}${escapeHtml(sec)}`,
    );
    lines.push(
      `    ${escapeHtml(formatTerm({ year: w.year, term: w.term, campus: w.campus }))} · status: ${escapeHtml(w.lastStatus)}` +
        (w.lastCheckedAt ? ` · checked ${escapeHtml(formatRelative(w.lastCheckedAt))}` : ' · not checked yet'),
    );
  }
  lines.push('', 'Stop one with: stop watching <index>');
  return truncateForTelegram(lines.join('\n'));
}

/** "3m ago" style timestamps read better than raw ISO strings in chat. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface StatusSummary {
  workerRunning: boolean;
  workerDetail: string;
  activeWatches: number;
  openNow: number;
  lastPollAt: string | null;
  consecutiveFailures: number;
  pollIntervalSeconds: number;
}

export function formatStatus(s: StatusSummary): string {
  const lines = [
    `<b>Rutgers monitor status</b>`,
    '',
    `Worker: ${s.workerRunning ? '🟢 running' : '🔴 not running'} — ${escapeHtml(s.workerDetail)}`,
    `Active watches: ${s.activeWatches}`,
    `Currently open: ${s.openNow}`,
    `Poll interval: every ${s.pollIntervalSeconds}s`,
    `Last poll: ${s.lastPollAt ? escapeHtml(formatRelative(s.lastPollAt)) : 'never'}`,
  ];
  if (s.consecutiveFailures > 0) {
    lines.push(`⚠️ Consecutive failures: ${s.consecutiveFailures}`);
  }
  return truncateForTelegram(lines.join('\n'));
}

export function formatWatchCreated(section: SectionInfo, term: Term): string {
  const state = section.isOpen
    ? '🟢 It is OPEN right now — go register in WebReg.'
    : '🔴 It is currently closed. I will message you the moment it opens.';
  return truncateForTelegram(
    [
      `✅ <b>Now watching index ${escapeHtml(section.indexNumber)}</b>`,
      '',
      `Course: ${escapeHtml(prettyTitle(section.courseTitle))}`,
      `Course code: ${escapeHtml(section.courseString || 'n/a')}`,
      `Section: ${escapeHtml(section.sectionNumber)}`,
      `Instructor: ${escapeHtml(prettyInstructors(section.instructors))}`,
      `Term: ${escapeHtml(formatTerm(term))}`,
      '',
      state,
    ].join('\n'),
  );
}

/** Sent when Rutgers has been unreachable for a long stretch. */
export function formatFailureAlert(minutes: number, failures: number, lastError: string): string {
  return truncateForTelegram(
    [
      '⚠️ <b>Rutgers monitor is having trouble</b>',
      '',
      `I have not been able to reach the Rutgers Schedule of Classes for about ${minutes} minute(s) (${failures} consecutive failures).`,
      `Last error: ${escapeHtml(lastError)}`,
      '',
      'Your watches are still saved. I will keep retrying and tell you when it recovers.',
    ].join('\n'),
  );
}

export function formatRecovered(): string {
  return '✅ <b>Rutgers monitor recovered</b>\n\nI can reach the Schedule of Classes again and your watches are being checked normally.';
}

export const CAMPUS_HELP = Object.entries(CAMPUS_LABELS)
  .map(([code, label]) => `${code} = ${label}`)
  .join(', ');

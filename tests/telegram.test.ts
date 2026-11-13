/** Telegram formatting, escaping, and the send client (fully mocked). */
import { describe, expect, it, vi } from 'vitest';
import {
  escapeHtml,
  formatFailureAlert,
  formatOpenAlert,
  formatRelative,
  formatSectionChoices,
  formatStatus,
  formatWatchCreated,
  formatWatchList,
  prettyInstructors,
  prettyTitle,
  truncateForTelegram,
  TELEGRAM_MAX_LENGTH,
} from '../src/telegram/format.js';
import { NullNotifier, TelegramClient } from '../src/telegram/client.js';
import type { SectionInfo } from '../src/rutgers/types.js';
import type { Watch } from '../src/db/watch-repo.js';

const section: SectionInfo = {
  indexNumber: '12845',
  sectionNumber: '04',
  courseTitle: 'CALCULUS I',
  courseString: '01:640:135',
  subject: '640',
  subjectDescription: 'Mathematics',
  courseNumber: '135',
  credits: 4,
  instructors: ['BANERJEE, A'],
  meetings: [
    {
      days: 'Mon',
      startTime: '10:20 AM',
      endTime: '11:40 AM',
      mode: 'LEC',
      campus: 'CAC',
      location: 'ABW 1170',
    },
  ],
  isOpen: true,
  statusText: 'OPEN',
  campus: 'NB',
  year: 2026,
  term: 'fall',
};

const term = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

describe('escaping and safety', () => {
  it('escapes Telegram HTML special characters', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
    expect(escapeHtml('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes real Rutgers titles that contain ampersands', () => {
    const msg = formatOpenAlert({ ...section, courseTitle: 'CALC I LIFE&SOC SCI' });
    expect(msg).toContain('&amp;');
    // The raw ampersand must not survive outside an entity.
    expect(/&(?!amp;|lt;|gt;|quot;)/.test(msg)).toBe(false);
  });

  it('never lets injected markup break out of the message', () => {
    const msg = formatOpenAlert({
      ...section,
      courseTitle: '<script>alert(1)</script>',
      instructors: ['<b>evil</b>'],
    });
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;');
  });

  it('truncates messages over the Telegram limit', () => {
    const long = 'x'.repeat(TELEGRAM_MAX_LENGTH + 500);
    const out = truncateForTelegram(long);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
    expect(out).toContain('truncated');
  });

  it('leaves short messages untouched', () => {
    expect(truncateForTelegram('hello')).toBe('hello');
  });
});

describe('formatOpenAlert', () => {
  it('contains every field from the requested alert format', () => {
    const msg = formatOpenAlert(section);
    expect(msg).toContain('Rutgers section opened');
    expect(msg).toContain('Course: Calculus I');
    expect(msg).toContain('Course code: 01:640:135');
    expect(msg).toContain('Section: 04');
    expect(msg).toContain('12845');
    expect(msg).toContain('Instructor: Banerjee, A');
    expect(msg).toContain('Open WebReg and register manually now.');
  });

  it('includes meeting information when known', () => {
    expect(formatOpenAlert(section)).toContain('Mon 10:20 AM-11:40 AM');
  });

  it('never mentions credentials', () => {
    const msg = formatOpenAlert(section).toLowerCase();
    for (const forbidden of ['password', 'netid', 'ruid', 'pac', 'duo', 'login']) {
      expect(msg).not.toContain(forbidden);
    }
  });

  it('has a distinct reminder variant', () => {
    const msg = formatOpenAlert(section, { reminder: true });
    expect(msg).toContain('Still open');
    // A repeat must always say how to stop it, or it is just spam.
    expect(msg).toContain('yes');
    expect(msg).toContain('/cancel 12845');
  });

  it('numbers the repeats so a burst of them is readable', () => {
    expect(formatOpenAlert(section, { reminder: true, repeatNumber: 3 })).toContain('reminder #3');
    // Without a number it should still read cleanly, not "reminder #undefined".
    expect(formatOpenAlert(section, { reminder: true })).not.toContain('#');
  });

  it('leaves the first alert free of repeat wording', () => {
    const msg = formatOpenAlert(section);
    expect(msg).toContain('section opened');
    expect(msg).not.toContain('Still open');
    expect(msg).not.toContain('/cancel');
  });

  it('copes with missing instructors and meetings', () => {
    const msg = formatOpenAlert({ ...section, instructors: [], meetings: [] });
    expect(msg).toContain('Instructor: TBA');
    expect(msg).not.toContain('Meets:');
  });
});

describe('prettifying Rutgers SHOUTING', () => {
  it('title-cases all-caps titles', () => {
    expect(prettyTitle('CALCULUS I')).toBe('Calculus I');
    expect(prettyTitle('SHORT FICTION')).toBe('Short Fiction');
  });

  it('leaves mixed-case titles alone', () => {
    expect(prettyTitle('Intro to Rust')).toBe('Intro to Rust');
  });

  it('handles empty input', () => {
    expect(prettyTitle('')).toBe('Unknown course');
    expect(prettyTitle(null)).toBe('Unknown course');
  });

  it('formats instructors from an array or a stored string', () => {
    expect(prettyInstructors(['BANERJEE, A'])).toBe('Banerjee, A');
    expect(prettyInstructors('SMITH, J, DOE, A')).toBe('Smith, J, Doe, A');
    expect(prettyInstructors([])).toBe('TBA');
    expect(prettyInstructors(null)).toBe('TBA');
  });
});

describe('formatSectionChoices', () => {
  it('lists sections with status markers and asks the user to choose', () => {
    const msg = formatSectionChoices(
      '01:640:135',
      [section, { ...section, indexNumber: '12846', sectionNumber: '05', isOpen: false }],
      term,
    );
    expect(msg).toContain('2 sections');
    expect(msg).toContain('🟢');
    expect(msg).toContain('🔴');
    expect(msg).toContain('12845');
    expect(msg).toContain('12846');
    expect(msg).toContain('Reply with the index number(s)');
  });

  it('handles a course with no sections', () => {
    expect(formatSectionChoices('01:640:999', [], term)).toContain('No sections found');
  });

  it('stays within the Telegram size limit for a course with many sections', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...section,
      indexNumber: String(12800 + i),
      sectionNumber: String(i).padStart(2, '0'),
    }));
    expect(formatSectionChoices('01:640:135', many, term).length).toBeLessThanOrEqual(
      TELEGRAM_MAX_LENGTH,
    );
  });
});

describe('other messages', () => {
  const watch: Watch = {
    id: 1,
    indexNumber: '12845',
    courseCode: '01:640:135',
    courseTitle: 'CALCULUS I',
    sectionNumber: '04',
    instructors: 'Banerjee',
    year: 2026,
    term: 'fall',
    campus: 'NB',
    lastStatus: 'closed',
    active: true,
    chatId: '123',
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    lastNotifiedAt: null,
    openedAt: null,
    reminderSentAt: null,
    repeatCount: 0,
    followupDueAt: null,
    followupSentAt: null,
    outcome: null,
    resolvedAt: null,
    openCount: 0,
  };

  it('formats an empty watch list', () => {
    expect(formatWatchList([])).toContain('not watching any');
  });

  it('formats a populated watch list', () => {
    const msg = formatWatchList([watch]);
    expect(msg).toContain('Your Rutgers watches (1)');
    expect(msg).toContain('12845');
    expect(msg).toContain('Calculus I');
    expect(msg).toContain('Fall 2026 (New Brunswick)');
  });

  it('formats the watch-created confirmation differently when open vs closed', () => {
    expect(formatWatchCreated(section, term)).toContain('OPEN right now');
    expect(formatWatchCreated({ ...section, isOpen: false }, term)).toContain('currently closed');
  });

  it('formats status', () => {
    const msg = formatStatus({
      workerRunning: true,
      workerDetail: 'pid 42',
      activeWatches: 3,
      openNow: 1,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: 0,
      pollIntervalSeconds: 30,
    });
    expect(msg).toContain('🟢 running');
    expect(msg).toContain('Active watches: 3');
  });

  it('formats a failure alert without leaking internals', () => {
    const msg = formatFailureAlert(20, 40, 'HTTP 503');
    expect(msg).toContain('20 minute');
    expect(msg).toContain('HTTP 503');
    expect(msg).toContain('still saved');
  });

  it('formats relative times', () => {
    const now = new Date('2026-08-01T12:00:00Z');
    expect(formatRelative('2026-08-01T11:59:30Z', now)).toBe('30s ago');
    expect(formatRelative('2026-08-01T11:55:00Z', now)).toBe('5m ago');
    expect(formatRelative('2026-08-01T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelative('2026-07-30T12:00:00Z', now)).toBe('2d ago');
    expect(formatRelative('not-a-date', now)).toBe('unknown');
  });
});

describe('TelegramClient', () => {
  it('is disabled without a token and reports why', async () => {
    const client = new TelegramClient({});
    expect(client.enabled).toBe(false);
    const result = await client.sendMessage('123', 'hi');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('posts to the Bot API with HTML parse mode', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    })) as unknown as typeof fetch;

    const client = new TelegramClient({ botToken: '123:ABC', fetchImpl });
    const result = await client.sendMessage('999', 'hello');

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(7);

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(String(mock.mock.calls[0][0])).toContain('/bot123:ABC/sendMessage');
    const body = JSON.parse(mock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ chat_id: '999', text: 'hello', parse_mode: 'HTML' });
  });

  it('does not retry a 4xx rejection', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({ ok: false, description: 'chat not found' }) };
    }) as unknown as typeof fetch;

    const client = new TelegramClient({ botToken: '123:ABC', fetchImpl, sleepImpl: async () => {} });
    const result = await client.sendMessage('999', 'hi');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('chat not found');
    expect(calls).toBe(1);
  });

  it('retries a 5xx then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({ ok: false }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }) as unknown as typeof fetch;

    const client = new TelegramClient({ botToken: '123:ABC', fetchImpl, sleepImpl: async () => {} });
    expect((await client.sendMessage('999', 'hi')).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('truncates an oversized message rather than being rejected', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    })) as unknown as typeof fetch;

    const client = new TelegramClient({ botToken: '123:ABC', fetchImpl });
    await client.sendMessage('1', 'y'.repeat(9000));

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse(mock.mock.calls[0][1].body as string);
    expect(body.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
  });
});

describe('NullNotifier', () => {
  it('records messages instead of sending them', async () => {
    const n = new NullNotifier();
    await n.sendMessage('1', 'test');
    expect(n.sent).toEqual([{ chatId: '1', text: 'test' }]);
  });
});

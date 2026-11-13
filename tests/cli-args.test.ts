/**
 * CLI validation — the trust boundary between Telegram text and this program.
 */
import { describe, expect, it } from 'vitest';
import {
  CliUsageError,
  COMMANDS,
  parseCheckTarget,
  parseRawArgs,
  requireCourseCode,
  requireIndexNumber,
  requireOutcome,
  resolveChatId,
  resolveTermOptions,
} from '../src/cli/parse-args.js';

const defaults = { year: 2026, term: 'fall', campus: 'NB', chatId: '123456789' };

describe('command allowlist', () => {
  it('accepts every documented command', () => {
    for (const cmd of COMMANDS) {
      expect(parseRawArgs([cmd]).command).toBe(cmd);
    }
  });

  it('defaults to help with no arguments', () => {
    expect(parseRawArgs([]).command).toBe('help');
  });

  it.each([
    'rm',
    'watch',
    'exec',
    'eval',
    '; rm -rf /',
    'watch-index; cat /etc/passwd',
    '$(whoami)',
    '../../etc/passwd',
  ])('rejects command %j', (bad) => {
    expect(() => parseRawArgs([bad])).toThrow(CliUsageError);
  });

  it('is case-insensitive about the command name', () => {
    expect(parseRawArgs(['WATCH-INDEX', '12845']).command).toBe('watch-index');
  });
});

describe('flag allowlist', () => {
  it('parses "--flag value" and "--flag=value" alike', () => {
    expect(parseRawArgs(['list', '--chat-id', '999']).flags['chat-id']).toBe('999');
    expect(parseRawArgs(['list', '--chat-id=999']).flags['chat-id']).toBe('999');
  });

  it('parses boolean flags', () => {
    expect(parseRawArgs(['list', '--json']).flags.json).toBe(true);
    expect(parseRawArgs(['stop', '12845', '--all']).flags.all).toBe(true);
  });

  it('rejects flags that are not declared for the command', () => {
    expect(() => parseRawArgs(['list', '--exec', 'rm'])).toThrow(/Unknown option/);
    expect(() => parseRawArgs(['status', '--all'])).toThrow(/Unknown option/);
    expect(() => parseRawArgs(['list', '--notify'])).toThrow(/Unknown option/);
  });

  it('rejects a value-taking flag with no value', () => {
    expect(() => parseRawArgs(['list', '--chat-id'])).toThrow(/requires a value/);
    expect(() => parseRawArgs(['list', '--chat-id', '--json'])).toThrow(/requires a value/);
  });

  it('rejects a value given to a boolean flag', () => {
    expect(() => parseRawArgs(['list', '--json=yes'])).toThrow(/does not take a value/);
  });

  it('collects positionals separately from flags', () => {
    const parsed = parseRawArgs(['watch-index', '12845', '--year', '2026']);
    expect(parsed.positionals).toEqual(['12845']);
    expect(parsed.flags.year).toBe('2026');
  });

  it('treats shell metacharacters as inert positional text', () => {
    // Nothing is ever passed to a shell, so this is just an invalid index later.
    const parsed = parseRawArgs(['watch-index', '$(rm -rf /)']);
    expect(parsed.positionals).toEqual(['$(rm -rf /)']);
    expect(() => requireIndexNumber(parsed.positionals, 'watch-index')).toThrow(CliUsageError);
  });
});

describe('index number validation', () => {
  it('accepts a valid five-digit index', () => {
    expect(requireIndexNumber(['12845'], 'watch-index')).toBe('12845');
    expect(requireIndexNumber(['00745'], 'watch-index')).toBe('00745');
  });

  it.each([[[]], [['1234']], [['123456']], [['abcde']], [['12 45']], [['-1234']]])(
    'rejects %j',
    (positionals) => {
      expect(() => requireIndexNumber(positionals as string[], 'watch-index')).toThrow(
        CliUsageError,
      );
    },
  );
});

describe('course code validation', () => {
  it('normalizes valid codes', () => {
    expect(requireCourseCode(['01:640:135']).courseString).toBe('01:640:135');
    expect(requireCourseCode(['640:135']).courseString).toBe('01:640:135');
  });

  it('rejects invalid codes and missing arguments', () => {
    expect(() => requireCourseCode([])).toThrow(/requires a course code/);
    expect(() => requireCourseCode(['garbage'])).toThrow(CliUsageError);
  });
});

describe('check target sniffing', () => {
  it('recognises a five-digit index', () => {
    expect(parseCheckTarget(['12845'])).toEqual({ kind: 'index', indexNumber: '12845' });
  });

  it('recognises a course code', () => {
    expect(parseCheckTarget(['01:640:135'])).toEqual({
      kind: 'course',
      courseString: '01:640:135',
    });
  });

  it('rejects anything else', () => {
    expect(() => parseCheckTarget([])).toThrow(CliUsageError);
    expect(() => parseCheckTarget(['hello'])).toThrow(/neither/);
  });
});

describe('term option resolution', () => {
  it('falls back to environment defaults', () => {
    expect(resolveTermOptions({}, defaults)).toEqual({ year: 2026, term: 'fall', campus: 'NB' });
  });

  it('honours explicit flags', () => {
    expect(resolveTermOptions({ year: '2027', term: 'spring', campus: 'NK' }, defaults)).toEqual({
      year: 2027,
      term: 'spring',
      campus: 'NK',
    });
  });

  it('normalizes term aliases and campus casing', () => {
    expect(resolveTermOptions({ term: 'Fall' }, defaults).term).toBe('fall');
    expect(resolveTermOptions({ term: 'AUTUMN' }, defaults).term).toBe('fall');
    expect(resolveTermOptions({ campus: 'nb' }, defaults).campus).toBe('NB');
  });

  it('rejects an invalid term', () => {
    expect(() => resolveTermOptions({ term: 'quarter' }, defaults)).toThrow(/Invalid --term/);
  });

  it('rejects an invalid campus', () => {
    expect(() => resolveTermOptions({ campus: 'XX' }, defaults)).toThrow(CliUsageError);
  });

  it('rejects an out-of-range or non-numeric year', () => {
    expect(() => resolveTermOptions({ year: '1899' }, defaults)).toThrow(CliUsageError);
    expect(() => resolveTermOptions({ year: 'abcd' }, defaults)).toThrow(CliUsageError);
  });
});

describe('chat id resolution', () => {
  it('uses the flag when given', () => {
    expect(resolveChatId({ 'chat-id': '555' }, defaults)).toBe('555');
  });

  it('accepts negative group chat ids', () => {
    expect(resolveChatId({ 'chat-id': '-1001234567890' }, defaults)).toBe('-1001234567890');
  });

  it('falls back to the environment default', () => {
    expect(resolveChatId({}, defaults)).toBe('123456789');
  });

  it('errors when required and unavailable', () => {
    expect(() => resolveChatId({}, { ...defaults, chatId: undefined })).toThrow(
      /chat id is required/,
    );
  });

  it('returns undefined when optional and unavailable', () => {
    expect(resolveChatId({}, { ...defaults, chatId: undefined }, { required: false })).toBeUndefined();
  });

  it.each(['abc', '12.5', '1e5', "123'; DROP TABLE watches;--", ''])(
    'rejects invalid chat id %j',
    (bad) => {
      expect(() => resolveChatId({ 'chat-id': bad }, defaults)).toThrow(CliUsageError);
    },
  );
});

describe('resolve answers', () => {
  it('accepts --got-in', () => {
    const parsed = parseRawArgs(['resolve', '12845', '--got-in']);
    expect(parsed.command).toBe('resolve');
    expect(parsed.positionals).toEqual(['12845']);
    expect(requireOutcome(parsed.flags)).toBe('registered');
  });

  it('accepts --missed', () => {
    expect(requireOutcome(parseRawArgs(['resolve', '12845', '--missed']).flags)).toBe('missed');
  });

  it('refuses to guess when no answer is given', () => {
    expect(() => requireOutcome(parseRawArgs(['resolve', '12845']).flags)).toThrow(
      /--got-in .* or --missed/,
    );
  });

  it('rejects a contradictory answer', () => {
    expect(() =>
      requireOutcome(parseRawArgs(['resolve', '12845', '--got-in', '--missed']).flags),
    ).toThrow(/not both/);
  });

  it('still validates the index number', () => {
    expect(() => requireIndexNumber(parseRawArgs(['resolve', 'yes', '--got-in']).positionals, 'resolve')).toThrow(
      CliUsageError,
    );
  });

  it('does not accept answer flags on unrelated commands', () => {
    expect(() => parseRawArgs(['stop', '12845', '--got-in'])).toThrow(/Unknown option/);
  });
});

describe('status flags', () => {
  it('accepts --cached to skip the live lookup', () => {
    expect(parseRawArgs(['status', '--cached']).flags.cached).toBe(true);
  });

  it('rejects --cached elsewhere', () => {
    expect(() => parseRawArgs(['list', '--cached'])).toThrow(/Unknown option/);
  });
});

/**
 * Slash-command parsing. Same posture as the CLI parser: allowlisted verbs,
 * validated arguments, no guessing.
 */
import { describe, expect, it } from 'vitest';
import {
  BOT_COMMANDS,
  parseCommand,
  parseTarget,
  splitTargetAndTerm,
} from '../src/telegram/parse-command.js';

describe('recognising commands', () => {
  it('accepts every documented command', () => {
    for (const name of BOT_COMMANDS) {
      expect(parseCommand(`/${name}`)?.name).toBe(name);
    }
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseCommand('  /HELP  ')?.name).toBe('help');
  });

  it('handles the @BotName suffix Telegram adds in groups', () => {
    expect(parseCommand('/status@Ruclasssniperbot')?.name).toBe('status');
  });

  it('captures the argument', () => {
    expect(parseCommand('/watch 12845')).toEqual({ name: 'watch', arg: '12845' });
    expect(parseCommand('/watch   01:640:135  ')).toEqual({ name: 'watch', arg: '01:640:135' });
  });

  it('is null for anything that is not a slash command', () => {
    for (const text of ['yes', 'no', 'hello', 'watch 12845', '']) {
      expect(parseCommand(text)).toBeNull();
    }
  });

  it('is null for an unknown verb, so it can never be mistaken for one', () => {
    for (const text of ['/delete', '/sudo', '/exec rm -rf /', '/start']) {
      expect(parseCommand(text)).toBeNull();
    }
  });

  it('resolves /cancel to /stop, so both cannot drift apart', () => {
    expect(parseCommand('/cancel 12845')).toEqual({ name: 'stop', arg: '12845' });
    expect(parseCommand('/cancel all')).toEqual({ name: 'stop', arg: 'all' });
    // The alias has to survive the same normalisation as a real verb.
    expect(parseCommand('  /CANCEL@Ruclasssniperbot  12845 ')).toEqual({
      name: 'stop',
      arg: '12845',
    });
  });

  it('keeps aliases out of the canonical command list', () => {
    // BOT_COMMANDS drives the help text and the Telegram menu; listing an alias
    // there would advertise two names for one action.
    expect(BOT_COMMANDS).not.toContain('cancel');
  });
});

describe('argument targets', () => {
  it('reads a 5-digit index', () => {
    expect(parseTarget('12845')).toEqual({ kind: 'index', indexNumber: '12845' });
  });

  it('reads a course code, including shorthand', () => {
    expect(parseTarget('01:640:135')).toEqual({ kind: 'course', courseString: '01:640:135' });
    expect(parseTarget('640:135').kind).toBe('course');
  });

  it('reports a missing argument', () => {
    expect(parseTarget('').kind).toBe('missing');
    expect(parseTarget('   ').kind).toBe('missing');
  });

  it('accepts "all" only when the command allows it', () => {
    expect(parseTarget('all', { allowAll: true })).toEqual({ kind: 'all' });
    expect(parseTarget('all').kind).toBe('invalid');
  });

  it('refuses anything else rather than guessing', () => {
    for (const bad of ['calculus', '1234', '123456', 'rm -rf /', "'; DROP TABLE watches;--"]) {
      expect(parseTarget(bad).kind).toBe('invalid');
    }
  });
});

describe('term and campus modifiers', () => {
  const defaults = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

  it('uses the defaults when none are given', () => {
    const r = splitTargetAndTerm('12845', defaults);
    expect(r.target).toBe('12845');
    expect(r.term).toEqual(defaults);
    expect(r.overridden).toBe(false);
  });

  it('reads a term name', () => {
    const r = splitTargetAndTerm('12845 spring', defaults);
    expect(r.target).toBe('12845');
    expect(r.term.term).toBe('spring');
    expect(r.overridden).toBe(true);
  });

  it('reads a campus, case-insensitively', () => {
    expect(splitTargetAndTerm('12845 nk', defaults).term.campus).toBe('NK');
    expect(splitTargetAndTerm('12845 CM', defaults).term.campus).toBe('CM');
  });

  it('reads a year, and never confuses it with a 5-digit index', () => {
    const r = splitTargetAndTerm('12845 2027', defaults);
    expect(r.target).toBe('12845');
    expect(r.term.year).toBe(2027);
  });

  it('accepts all three in any order', () => {
    const a = splitTargetAndTerm('12845 spring 2027 NK', defaults);
    const b = splitTargetAndTerm('NK 2027 spring 12845', defaults);
    expect(a.term).toEqual({ year: 2027, term: 'spring', campus: 'NK' });
    expect(b.term).toEqual(a.term);
    expect(b.target).toBe('12845');
  });

  it('works with course codes too', () => {
    const r = splitTargetAndTerm('01:640:135 spring', defaults);
    expect(r.target).toBe('01:640:135');
    expect(r.term.term).toBe('spring');
  });

  it('leaves anything it does not recognise for the target parser to reject', () => {
    const r = splitTargetAndTerm('calculus spring', defaults);
    expect(r.target).toBe('calculus');
    expect(r.term.term).toBe('spring');
    expect(parseTarget(r.target).kind).toBe('invalid');
  });

  it('ignores an out-of-range year rather than accepting it', () => {
    const r = splitTargetAndTerm('12845 1899', defaults);
    expect(r.term.year).toBe(2026);
    expect(r.target).toBe('12845 1899'); // falls through and gets rejected
  });
});

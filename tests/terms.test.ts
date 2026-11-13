/** Course-code parsing, index validation and term handling. */
import { describe, expect, it } from 'vitest';
import {
  courseCodeSchema,
  formatTerm,
  indexNumberSchema,
  parseCourseCode,
  parseTermName,
  termCode,
  termKey,
} from '../src/rutgers/terms.js';

describe('parseCourseCode', () => {
  it('parses the canonical form', () => {
    expect(parseCourseCode('01:640:135')).toEqual({
      unit: '01',
      subject: '640',
      courseNumber: '135',
      courseString: '01:640:135',
    });
  });

  it('accepts common shorthands people type in Telegram', () => {
    expect(parseCourseCode('01-640-135')?.courseString).toBe('01:640:135');
    expect(parseCourseCode('01 640 135')?.courseString).toBe('01:640:135');
    expect(parseCourseCode('  01:640:135  ')?.courseString).toBe('01:640:135');
  });

  it('defaults the school unit to 01 when only subject:course is given', () => {
    expect(parseCourseCode('640:135')?.courseString).toBe('01:640:135');
  });

  it('zero-pads short components', () => {
    expect(parseCourseCode('1:640:35')?.courseString).toBe('01:640:035');
    expect(parseCourseCode('01:98:101')?.courseString).toBe('01:098:101');
  });

  it('keeps a trailing letter suffix and upper-cases it', () => {
    expect(parseCourseCode('01:640:13a')?.courseString).toBe('01:640:13A');
  });

  it('rejects nonsense', () => {
    expect(parseCourseCode('')).toBeNull();
    expect(parseCourseCode('hello')).toBeNull();
    expect(parseCourseCode('640')).toBeNull();
    expect(parseCourseCode('01:640:135:99')).toBeNull();
    expect(parseCourseCode('01:6400:135')).toBeNull();
    expect(parseCourseCode('abc:def:ghi')).toBeNull();
  });

  it('exposes the same rules through the Zod schema', () => {
    expect(courseCodeSchema.parse('640:135').courseString).toBe('01:640:135');
    expect(courseCodeSchema.safeParse('nope').success).toBe(false);
  });
});

describe('index number validation', () => {
  it('accepts exactly five digits, including leading zeros', () => {
    expect(indexNumberSchema.parse('12845')).toBe('12845');
    expect(indexNumberSchema.parse('00745')).toBe('00745');
    expect(indexNumberSchema.parse('  12845 ')).toBe('12845');
  });

  it.each(['1234', '123456', '', 'abcde', '12 45', '1234a', '-1234'])(
    'rejects invalid index %j',
    (bad) => {
      expect(indexNumberSchema.safeParse(bad).success).toBe(false);
    },
  );
});

describe('terms', () => {
  it('maps term names to the codes the Rutgers API expects', () => {
    // Verified against the live API.
    expect(termCode('fall')).toBe('9');
    expect(termCode('spring')).toBe('1');
    expect(termCode('summer')).toBe('7');
    expect(termCode('winter')).toBe('0');
  });

  it('understands term aliases from natural language', () => {
    expect(parseTermName('Fall')).toBe('fall');
    expect(parseTermName('FALL')).toBe('fall');
    expect(parseTermName('autumn')).toBe('fall');
    expect(parseTermName('sp')).toBe('spring');
    expect(parseTermName('nonsense')).toBeNull();
  });

  it('formats a human-readable term label', () => {
    expect(formatTerm({ year: 2026, term: 'fall', campus: 'NB' })).toBe(
      'Fall 2026 (New Brunswick)',
    );
  });

  it('builds a stable grouping key', () => {
    expect(termKey({ year: 2026, term: 'fall', campus: 'NB' })).toBe('2026:fall:NB');
    expect(termKey({ year: 2026, term: 'fall', campus: 'NK' })).not.toBe('2026:fall:NB');
  });
});

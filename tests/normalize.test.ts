/**
 * Rutgers response normalization + open/closed status detection.
 * The fixture is real data captured from classes.rutgers.edu.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  formatDay,
  formatMeeting,
  formatTime,
  normalizeCourseList,
  normalizeInstructors,
  normalizeMeeting,
  normalizeSection,
  summarizeSection,
} from '../src/rutgers/normalize.js';
import { rawCourseListSchema, type RawCourse } from '../src/rutgers/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = rawCourseListSchema.parse(
  JSON.parse(readFileSync(join(here, 'fixtures/course-640-135.json'), 'utf8')),
) as RawCourse[];

const ctx = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

describe('normalizeCourseList', () => {
  it('flattens real Rutgers data into normalized sections', () => {
    const sections = normalizeCourseList(fixture, ctx);
    expect(sections).toHaveLength(4);

    const first = sections[0];
    expect(first.indexNumber).toBe('12845');
    expect(first.sectionNumber).toBe('01');
    expect(first.courseString).toBe('01:640:135');
    expect(first.subject).toBe('640');
    expect(first.courseNumber).toBe('135');
    expect(first.courseTitle).toMatch(/CALCULUS I/i);
    expect(first.year).toBe(2026);
    expect(first.term).toBe('fall');
    expect(first.campus).toBe('NB');
  });

  it('extracts instructors and meeting information when available', () => {
    const [first] = normalizeCourseList(fixture, ctx);
    expect(first.instructors.length).toBeGreaterThan(0);
    expect(first.meetings.length).toBeGreaterThan(0);
    const meeting = first.meetings[0];
    expect(meeting.days).toMatch(/Mon|Tue|Wed|Thu|Fri/);
    expect(meeting.startTime).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it('preserves leading zeros by keeping index numbers as strings', () => {
    const section = normalizeSection(
      { courseString: '01:001:100', sections: [] },
      { index: '00745', number: '01' },
      ctx,
    );
    expect(section.indexNumber).toBe('00745');
    expect(typeof section.indexNumber).toBe('string');
  });
});

describe('open / closed status detection', () => {
  it('reads openStatus from the catalog when no live open-set is given', () => {
    const sections = normalizeCourseList(fixture, ctx);
    expect(sections.find((s) => s.indexNumber === '12845')!.isOpen).toBe(true);
    expect(sections.find((s) => s.indexNumber === '12848')!.isOpen).toBe(false);
    expect(sections.find((s) => s.indexNumber === '12848')!.statusText).toBe('CLOSED');
  });

  it('lets the live openSections feed override a stale catalog flag', () => {
    // 12848 is CLOSED in the catalog, but the fresher feed says it is open.
    const openIndexes = new Set(['12848']);
    const sections = normalizeCourseList(fixture, { ...ctx, openIndexes });

    expect(sections.find((s) => s.indexNumber === '12848')!.isOpen).toBe(true);
    expect(sections.find((s) => s.indexNumber === '12848')!.statusText).toBe('OPEN');
    // And a section the feed omits is treated as closed.
    expect(sections.find((s) => s.indexNumber === '12845')!.isOpen).toBe(false);
  });

  it('treats a missing openStatus as closed rather than crashing', () => {
    const section = normalizeSection({}, { index: '11111' }, ctx);
    expect(section.isOpen).toBe(false);
    expect(section.courseTitle).toBe('Unknown course');
    expect(section.sectionNumber).toBe('??');
  });
});

describe('field formatting helpers', () => {
  it('converts Rutgers day codes to readable labels', () => {
    expect(formatDay('M')).toBe('Mon');
    expect(formatDay('TH')).toBe('Thu');
    expect(formatDay('F')).toBe('Fri');
    expect(formatDay(null)).toBe('');
  });

  it('converts Rutgers 12-hour time plus pmCode', () => {
    expect(formatTime('0350', 'P')).toBe('3:50 PM');
    expect(formatTime('0830', 'A')).toBe('8:30 AM');
    expect(formatTime('1200', 'P')).toBe('12:00 PM');
  });

  it('falls back to the military time field', () => {
    expect(formatTime(null, null, '1550')).toBe('3:50 PM');
    expect(formatTime('', '', '0900')).toBe('9:00 AM');
  });

  it('returns null for unparseable times', () => {
    expect(formatTime('', '', '')).toBeNull();
    expect(formatTime('abc', 'P')).toBeNull();
  });

  it('formats a full meeting line', () => {
    const meeting = normalizeMeeting({
      meetingDay: 'M',
      startTime: '0350',
      endTime: '0510',
      pmCode: 'P',
      meetingModeDesc: 'LEC',
      campusAbbrev: 'CAC',
      buildingCode: 'FH',
      roomNumber: 'A2',
    });
    expect(formatMeeting(meeting)).toBe('Mon 3:50 PM-5:10 PM (LEC CAC FH A2)');
  });

  it('says TBA when a meeting has no information', () => {
    expect(formatMeeting(normalizeMeeting({}))).toBe('TBA');
  });

  it('de-duplicates repeated instructor names', () => {
    const names = normalizeInstructors({
      index: '1',
      instructors: [{ name: 'SMITH, J' }, { name: 'SMITH, J' }, { name: '' }, { name: 'DOE, A' }],
    });
    expect(names).toEqual(['SMITH, J', 'DOE, A']);
  });

  it('summarizes a section on one line', () => {
    const [first] = normalizeCourseList(fixture, ctx);
    expect(summarizeSection(first)).toContain('01:640:135 sec 01 (index 12845)');
    expect(summarizeSection(first)).toContain('OPEN');
  });
});

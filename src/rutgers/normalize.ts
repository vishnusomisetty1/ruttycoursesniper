/**
 * Pure functions that turn raw Rutgers JSON into our normalized shape.
 *
 * "Pure" means: no network, no database, no clock. Give them the same input and
 * they always return the same output, which makes them trivial to unit-test.
 */
import type { CampusCode, TermName } from './terms.js';
import type { MeetingInfo, RawCourse, RawMeeting, RawSection, SectionInfo } from './types.js';

const DAY_LABELS: Record<string, string> = {
  M: 'Mon',
  T: 'Tue',
  W: 'Wed',
  TH: 'Thu',
  H: 'Thu',
  F: 'Fri',
  S: 'Sat',
  U: 'Sun',
};

export function formatDay(day: string | null | undefined): string {
  if (!day) return '';
  return DAY_LABELS[day.trim().toUpperCase()] ?? day.trim();
}

/**
 * Rutgers gives times as "0350" plus a pmCode of "A" or "P".
 * We turn that into "3:50 PM". Falls back to the 24-hour field if needed.
 */
export function formatTime(
  time: string | null | undefined,
  pmCode: string | null | undefined,
  military?: string | null,
): string | null {
  const raw = (time ?? '').trim();
  if (/^\d{3,4}$/.test(raw)) {
    const padded = raw.padStart(4, '0');
    const hh = Number(padded.slice(0, 2));
    const mm = padded.slice(2);
    const suffix = (pmCode ?? '').trim().toUpperCase().startsWith('P') ? 'PM' : 'AM';
    const hour12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${hour12}:${mm} ${suffix}`;
  }

  const mil = (military ?? '').trim();
  if (/^\d{3,4}$/.test(mil)) {
    const padded = mil.padStart(4, '0');
    const hh = Number(padded.slice(0, 2));
    const mm = padded.slice(2);
    const suffix = hh >= 12 ? 'PM' : 'AM';
    const hour12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${hour12}:${mm} ${suffix}`;
  }
  return null;
}

export function normalizeMeeting(raw: RawMeeting): MeetingInfo {
  const building = (raw.buildingCode ?? '').trim();
  const room = (raw.roomNumber ?? '').trim();
  const location = building || room ? [building, room].filter(Boolean).join(' ') : null;

  return {
    days: formatDay(raw.meetingDay),
    startTime: formatTime(raw.startTime, raw.pmCode, raw.startTimeMilitary),
    endTime: formatTime(raw.endTime, raw.pmCode, raw.endTimeMilitary),
    mode: (raw.meetingModeDesc ?? '').trim() || null,
    campus: (raw.campusAbbrev ?? '').trim() || null,
    location,
  };
}

/** One-line human summary of a meeting, e.g. "Mon 3:50 PM-5:10 PM (LEC, CAC FH A2)". */
export function formatMeeting(m: MeetingInfo): string {
  const when = [m.days, [m.startTime, m.endTime].filter(Boolean).join('-')]
    .filter(Boolean)
    .join(' ')
    .trim();
  const whereParts = [m.mode, m.campus, m.location].filter(Boolean).join(' ');
  if (when && whereParts) return `${when} (${whereParts})`;
  return when || whereParts || 'TBA';
}

export function normalizeInstructors(raw: RawSection): string[] {
  const names = (raw.instructors ?? [])
    .map((i) => (i?.name ?? '').trim())
    .filter((n) => n.length > 0);
  // Rutgers sometimes repeats the same instructor across cross-listed entries.
  return [...new Set(names)];
}

export interface NormalizeContext {
  year: number;
  term: TermName;
  campus: CampusCode;
  /**
   * Set of index numbers reported open by openSections.json. When provided it
   * wins over the course payload's `openStatus`, because openSections is the
   * endpoint that refreshes fastest.
   */
  openIndexes?: ReadonlySet<string>;
}

export function normalizeSection(
  course: RawCourse,
  section: RawSection,
  ctx: NormalizeContext,
): SectionInfo {
  const index = section.index.trim();

  // Prefer the live open-sections feed; fall back to the catalog's own flag.
  const isOpen = ctx.openIndexes ? ctx.openIndexes.has(index) : section.openStatus === true;

  const statusText = ctx.openIndexes
    ? isOpen
      ? 'OPEN'
      : 'CLOSED'
    : ((section.openStatusText ?? '').trim() || (isOpen ? 'OPEN' : 'CLOSED'));

  const title =
    (course.expandedTitle ?? '').trim() || (course.title ?? '').trim() || 'Unknown course';

  const unit = (course.offeringUnitCode ?? '').trim();
  const subject = (course.subject ?? '').trim();
  const courseNumber = (course.courseNumber ?? '').trim();
  const courseString =
    (course.courseString ?? '').trim() ||
    (unit && subject && courseNumber ? `${unit}:${subject}:${courseNumber}` : '');

  return {
    indexNumber: index,
    sectionNumber: (section.number ?? '').trim() || '??',
    courseTitle: title,
    courseString,
    subject,
    subjectDescription: (course.subjectDescription ?? '').trim() || null,
    courseNumber,
    credits: typeof course.credits === 'number' ? course.credits : null,
    instructors: normalizeInstructors(section),
    meetings: (section.meetingTimes ?? []).map(normalizeMeeting),
    isOpen,
    statusText: statusText.toUpperCase(),
    campus: ctx.campus,
    year: ctx.year,
    term: ctx.term,
  };
}

/** Flatten the catalog (courses -> sections) into normalized sections. */
export function normalizeCourseList(courses: RawCourse[], ctx: NormalizeContext): SectionInfo[] {
  const out: SectionInfo[] = [];
  for (const course of courses) {
    for (const section of course.sections ?? []) {
      if (!section?.index) continue;
      out.push(normalizeSection(course, section, ctx));
    }
  }
  return out;
}

/** Short one-line summary used in CLI + Telegram listings. */
export function summarizeSection(s: SectionInfo): string {
  const who = s.instructors.length > 0 ? s.instructors.join(', ') : 'TBA';
  return `${s.courseString} sec ${s.sectionNumber} (index ${s.indexNumber}) — ${s.statusText} — ${who}`;
}

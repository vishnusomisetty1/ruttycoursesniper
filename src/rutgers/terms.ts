/**
 * Rutgers-specific vocabulary: terms, campuses, index numbers and course codes.
 *
 * These values were confirmed against the live public Schedule of Classes API
 * (classes.rutgers.edu/soc/api) rather than assumed.
 */
import { z } from 'zod';

/** Rutgers encodes the term as a single digit in its API. */
export const TERM_CODES = {
  winter: '0',
  spring: '1',
  summer: '7',
  fall: '9',
} as const;

export const TERM_NAMES = ['winter', 'spring', 'summer', 'fall'] as const;
export type TermName = (typeof TERM_NAMES)[number];

export const CAMPUS_CODES = ['NB', 'NK', 'CM'] as const;
export type CampusCode = (typeof CAMPUS_CODES)[number];

export const CAMPUS_LABELS: Record<CampusCode, string> = {
  NB: 'New Brunswick',
  NK: 'Newark',
  CM: 'Camden',
};

export const termSchema = z.enum(TERM_NAMES);
export const campusSchema = z.enum(CAMPUS_CODES);
export const yearSchema = z.coerce.number().int().min(2000).max(2100);

/**
 * Rutgers index numbers are exactly five digits and may have leading zeros
 * (e.g. "00745"), so they must be treated as strings, never numbers.
 */
export const indexNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{5}$/, 'Index number must be exactly 5 digits (e.g. 12845)');

export function normalizeIndexNumber(input: string | number): string {
  return String(input).trim();
}

export interface Term {
  year: number;
  term: TermName;
  campus: CampusCode;
}

export function termCode(term: TermName): string {
  return TERM_CODES[term];
}

/** Human label, e.g. "Fall 2026 (New Brunswick)". */
export function formatTerm(t: Term): string {
  const name = t.term.charAt(0).toUpperCase() + t.term.slice(1);
  return `${name} ${t.year} (${CAMPUS_LABELS[t.campus]})`;
}

/** Stable key used to group watches that can share a single HTTP request. */
export function termKey(t: Term): string {
  return `${t.year}:${t.term}:${t.campus}`;
}

export function parseTermName(input: string): TermName | null {
  const v = input.trim().toLowerCase();
  const aliases: Record<string, TermName> = {
    fall: 'fall',
    fa: 'fall',
    autumn: 'fall',
    spring: 'spring',
    sp: 'spring',
    summer: 'summer',
    su: 'summer',
    winter: 'winter',
    wi: 'winter',
  };
  return aliases[v] ?? null;
}

export interface CourseCode {
  /** School / offering unit, e.g. "01". */
  unit: string;
  /** Subject, e.g. "640" for Mathematics. */
  subject: string;
  /** Course number, e.g. "135". */
  courseNumber: string;
  /** Canonical "01:640:135". */
  courseString: string;
}

/**
 * Parse a Rutgers course code.
 *
 * Accepts the canonical `01:640:135` and common shorthands people type in
 * Telegram: `01-640-135`, `01 640 135`, or `640:135` (unit defaults to "01",
 * School of Arts and Sciences).
 */
export function parseCourseCode(input: string): CourseCode | null {
  const cleaned = input.trim().replace(/[\s\-.]+/g, ':').replace(/:+/g, ':');
  const parts = cleaned.split(':').filter((p) => p.length > 0);

  let unit: string;
  let subject: string;
  let courseNumber: string;

  if (parts.length === 3) {
    [unit, subject, courseNumber] = parts;
  } else if (parts.length === 2) {
    unit = '01';
    [subject, courseNumber] = parts;
  } else {
    return null;
  }

  if (!/^\d{1,2}$/.test(unit)) return null;
  if (!/^\d{1,3}$/.test(subject)) return null;
  if (!/^\d{1,3}[A-Za-z]?$/.test(courseNumber)) return null;

  const pad = (v: string, len: number) => v.padStart(len, '0');
  const u = pad(unit, 2);
  const s = pad(subject, 3);
  const c = pad(courseNumber.toUpperCase(), 3);

  return { unit: u, subject: s, courseNumber: c, courseString: `${u}:${s}:${c}` };
}

export const courseCodeSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const parsed = parseCourseCode(v);
    if (!parsed) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid Rutgers course code "${v}". Expected something like 01:640:135`,
      });
      return z.NEVER;
    }
    return parsed;
  });

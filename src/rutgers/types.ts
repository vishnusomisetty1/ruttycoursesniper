/**
 * The normalized shape the rest of the app uses.
 *
 * Nothing outside src/rutgers/ should ever see a raw Rutgers API field name.
 * If Rutgers changes their JSON, only the adapter + normalizer change; these
 * types (and every consumer of them) stay the same.
 */
import { z } from 'zod';
import type { CampusCode, TermName } from './terms.js';

export interface MeetingInfo {
  /** e.g. "MTh 3:50 PM - 5:10 PM" */
  days: string;
  startTime: string | null;
  endTime: string | null;
  /** e.g. "LEC", "REC", "Online" */
  mode: string | null;
  /** e.g. "CAC" */
  campus: string | null;
  /** e.g. "FH-A2" */
  location: string | null;
}

export interface SectionInfo {
  indexNumber: string;
  sectionNumber: string;
  courseTitle: string;
  courseString: string;
  subject: string;
  subjectDescription: string | null;
  courseNumber: string;
  credits: number | null;
  instructors: string[];
  meetings: MeetingInfo[];
  /** True when the section is currently open for registration. */
  isOpen: boolean;
  /** Rutgers' own words, e.g. "OPEN" / "CLOSED". */
  statusText: string;
  campus: CampusCode;
  year: number;
  term: TermName;
}

/**
 * Zod schemas describing the *raw* Rutgers payloads.
 *
 * These are deliberately permissive (`.passthrough()`, lots of `.optional()`)
 * because a university API can add fields at any time and we do not want to
 * crash over a field we never read.
 */
export const rawMeetingSchema = z
  .object({
    meetingDay: z.string().nullish(),
    startTime: z.string().nullish(),
    endTime: z.string().nullish(),
    pmCode: z.string().nullish(),
    startTimeMilitary: z.string().nullish(),
    endTimeMilitary: z.string().nullish(),
    meetingModeDesc: z.string().nullish(),
    campusAbbrev: z.string().nullish(),
    campusName: z.string().nullish(),
    buildingCode: z.string().nullish(),
    roomNumber: z.string().nullish(),
  })
  .loose();

export const rawInstructorSchema = z.object({ name: z.string().nullish() }).loose();

export const rawSectionSchema = z
  .object({
    index: z.string(),
    number: z.string().nullish(),
    openStatus: z.boolean().nullish(),
    openStatusText: z.string().nullish(),
    printed: z.string().nullish(),
    instructors: z.array(rawInstructorSchema).nullish(),
    meetingTimes: z.array(rawMeetingSchema).nullish(),
    campusCode: z.string().nullish(),
  })
  .loose();

export const rawCourseSchema = z
  .object({
    title: z.string().nullish(),
    expandedTitle: z.string().nullish(),
    subject: z.string().nullish(),
    subjectDescription: z.string().nullish(),
    courseNumber: z.string().nullish(),
    courseString: z.string().nullish(),
    offeringUnitCode: z.string().nullish(),
    credits: z.number().nullish(),
    sections: z.array(rawSectionSchema).nullish(),
  })
  .loose();

export const rawCourseListSchema = z.array(rawCourseSchema);

/** openSections.json is just a flat array of index-number strings. */
export const rawOpenSectionsSchema = z.array(z.string());

export type RawCourse = z.infer<typeof rawCourseSchema>;
export type RawSection = z.infer<typeof rawSectionSchema>;
export type RawMeeting = z.infer<typeof rawMeetingSchema>;

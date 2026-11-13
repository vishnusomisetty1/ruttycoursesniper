/**
 * Rutgers Schedule of Classes adapter.
 *
 * THIS IS THE ONLY FILE THAT KNOWS RUTGERS URLS. If Rutgers changes its public
 * Schedule of Classes system, this file is the only one that must change.
 *
 * It reads ONLY the public, unauthenticated Schedule of Classes JSON that backs
 * https://classes.rutgers.edu. It never touches WebReg, never logs in, and
 * never submits a registration.
 *
 * Endpoints verified live against the real API:
 *
 *   GET /soc/api/openSections.json?year=2026&term=9&campus=NB
 *       -> ["00007","00010",...]  (~12k index strings, ~95 KB)
 *       NOTE: the `campus` parameter is ignored by Rutgers; the response is
 *       university-wide. That is fine because index numbers are unique per term.
 *
 *   GET /soc/api/courses.json?year=2026&term=9&campus=NB
 *       -> full course catalog with sections (~21 MB raw, ~900 KB gzipped)
 *       NOTE: the `subject` parameter is ALSO ignored — the server returns every
 *       subject regardless. So subject filtering must happen on our side, and
 *       the response must be cached because it is expensive.
 *
 * Design consequence: availability polling uses openSections.json only, so
 * watching 1 section and watching 100 sections both cost ONE request per poll.
 */
import {
  rawCourseListSchema,
  rawOpenSectionsSchema,
  type RawCourse,
  type SectionInfo,
} from './types.js';
import { normalizeCourseList, normalizeSection } from './normalize.js';
import { termCode, type Term } from './terms.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export interface SocClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  retryBaseDelayMs?: number;
  catalogCacheMs?: number;
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

/** Thrown for HTTP/parse failures so callers can distinguish "not found". */
export class SocRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SocRequestError';
  }
}

const DEFAULT_BASE_URL = 'https://classes.rutgers.edu/soc/api';

interface CacheEntry {
  fetchedAt: number;
  courses: RawCourse[];
}

export class RutgersSocClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly catalogCacheMs: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private readonly catalogCache = new Map<string, CacheEntry>();
  /** De-duplicates concurrent catalog fetches for the same term. */
  private readonly inflightCatalog = new Map<string, Promise<RawCourse[]>>();

  constructor(options: SocClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.catalogCacheMs = options.catalogCacheMs ?? 60 * 60 * 1000;
    this.log = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.nowImpl ?? (() => Date.now());
  }

  private url(path: string, params: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /**
   * GET + JSON with a timeout and exponential backoff.
   *
   * Retries only transient problems (network blips, 429, 5xx). A 404 is a real
   * answer, not a blip, so it fails immediately.
   */
  private async getJson(url: string, label: string): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with a little randomness so retries don't sync up.
        const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
        const jitter = Math.floor(delay * 0.25 * Math.random());
        await this.sleep(delay + jitter);
        this.log.debug('retrying rutgers request', { label, attempt });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            // Identify ourselves honestly; this is a polite, low-rate reader.
            'user-agent': 'rutgers-course-sniper/1.0 (notification-only; personal use)',
          },
        });

        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          throw new SocRequestError(
            `Rutgers ${label} request failed with HTTP ${res.status}`,
            res.status,
            retryable,
          );
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        const retryable =
          err instanceof SocRequestError
            ? err.retryable
            : // Aborts and network errors are transient.
              true;

        if (!retryable || attempt === this.maxRetries) break;

        this.log.warn('rutgers request failed, will retry', {
          label,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastError instanceof SocRequestError) throw lastError;
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new SocRequestError(`Rutgers ${label} request failed: ${msg}`, undefined, true);
  }

  /**
   * The hot path: every index number currently open for a term.
   * One small request covers every section we are watching.
   */
  async fetchOpenIndexes(term: Term): Promise<Set<string>> {
    const url = this.url('openSections.json', {
      year: String(term.year),
      term: termCode(term.term),
      campus: term.campus,
    });

    const json = await this.getJson(url, 'openSections');
    const parsed = rawOpenSectionsSchema.safeParse(json);
    if (!parsed.success) {
      throw new SocRequestError('Rutgers openSections response was not a list of index numbers');
    }
    return new Set(parsed.data.map((i) => i.trim()));
  }

  /** The cold path: the full catalog, cached because it is large. */
  async fetchCatalog(term: Term, options: { force?: boolean } = {}): Promise<RawCourse[]> {
    const key = `${term.year}:${term.term}:${term.campus}`;

    const cached = this.catalogCache.get(key);
    if (!options.force && cached && this.now() - cached.fetchedAt < this.catalogCacheMs) {
      return cached.courses;
    }

    const existing = this.inflightCatalog.get(key);
    if (existing && !options.force) return existing;

    const url = this.url('courses.json', {
      year: String(term.year),
      term: termCode(term.term),
      campus: term.campus,
    });

    const promise = (async () => {
      const json = await this.getJson(url, 'courses');
      const parsed = rawCourseListSchema.safeParse(json);
      if (!parsed.success) {
        throw new SocRequestError('Rutgers courses response had an unexpected shape');
      }
      this.catalogCache.set(key, { fetchedAt: this.now(), courses: parsed.data });
      this.log.debug('fetched rutgers catalog', { term: key, courses: parsed.data.length });
      return parsed.data;
    })().finally(() => {
      this.inflightCatalog.delete(key);
    });

    this.inflightCatalog.set(key, promise);
    return promise;
  }

  /**
   * Look up one section by its five-digit index number.
   * Returns null when no such index exists in that term.
   */
  async getSectionByIndex(indexNumber: string, term: Term): Promise<SectionInfo | null> {
    const [catalog, openIndexes] = await Promise.all([
      this.fetchCatalog(term),
      this.fetchOpenIndexes(term),
    ]);

    for (const course of catalog) {
      for (const section of course.sections ?? []) {
        if (section?.index?.trim() === indexNumber) {
          return normalizeSection(course, section, { ...term, openIndexes });
        }
      }
    }
    return null;
  }

  /**
   * Resolve a course code such as 01:640:135 into all of its sections.
   *
   * Rutgers ignores the `subject` query parameter, so we filter client-side
   * against the cached catalog.
   */
  async getSectionsByCourseCode(courseString: string, term: Term): Promise<SectionInfo[]> {
    const [catalog, openIndexes] = await Promise.all([
      this.fetchCatalog(term),
      this.fetchOpenIndexes(term),
    ]);

    const matches = catalog.filter((c) => (c.courseString ?? '').trim() === courseString);
    const sections = normalizeCourseList(matches, { ...term, openIndexes });
    return sections.sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber));
  }

  /** Test helper / long-running-process hygiene. */
  clearCache(): void {
    this.catalogCache.clear();
  }
}

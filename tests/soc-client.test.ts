/**
 * Rutgers adapter behaviour: retries, backoff, timeouts, caching.
 * Every network call here is mocked — no real request is ever made.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RutgersSocClient, SocRequestError } from '../src/rutgers/soc-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const courseFixture = JSON.parse(readFileSync(join(here, 'fixtures/course-640-135.json'), 'utf8'));

const term = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Routes by URL so a single mock can serve both endpoints. */
function makeFetch(handlers: {
  openSections?: () => Response | Promise<Response>;
  courses?: () => Response | Promise<Response>;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('openSections.json')) {
      return handlers.openSections ? handlers.openSections() : jsonResponse(['12845']);
    }
    if (url.includes('courses.json')) {
      return handlers.courses ? handlers.courses() : jsonResponse(courseFixture);
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

const noSleep = async () => {};

describe('fetchOpenIndexes', () => {
  it('requests the verified endpoint with the right query parameters', async () => {
    const fetchImpl = makeFetch({});
    const client = new RutgersSocClient({ fetchImpl, sleepImpl: noSleep });

    await client.fetchOpenIndexes(term);

    const called = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(called).toContain('/openSections.json');
    expect(called).toContain('year=2026');
    expect(called).toContain('term=9'); // fall
    expect(called).toContain('campus=NB');
  });

  it('returns a Set of index numbers', async () => {
    const client = new RutgersSocClient({
      fetchImpl: makeFetch({ openSections: () => jsonResponse(['12845', '00745', ' 12846 ']) }),
      sleepImpl: noSleep,
    });
    const open = await client.fetchOpenIndexes(term);
    expect(open.has('12845')).toBe(true);
    expect(open.has('00745')).toBe(true);
    expect(open.has('12846')).toBe(true); // whitespace trimmed
    expect(open.has('99999')).toBe(false);
  });

  it('rejects a response that is not a list of strings', async () => {
    const client = new RutgersSocClient({
      fetchImpl: makeFetch({ openSections: () => jsonResponse({ oops: true }) }),
      sleepImpl: noSleep,
    });
    await expect(client.fetchOpenIndexes(term)).rejects.toThrow(SocRequestError);
  });
});

describe('retry behaviour', () => {
  it('retries transient network failures and eventually succeeds', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('ECONNRESET');
      return jsonResponse(['12845']);
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const client = new RutgersSocClient({
      fetchImpl,
      sleepImpl: async (ms) => void sleeps.push(ms),
      retryBaseDelayMs: 100,
    });

    const open = await client.fetchOpenIndexes(term);
    expect(open.has('12845')).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('backs off exponentially between attempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const client = new RutgersSocClient({
      fetchImpl,
      sleepImpl: async (ms) => void sleeps.push(ms),
      retryBaseDelayMs: 100,
      maxRetries: 3,
    });

    await expect(client.fetchOpenIndexes(term)).rejects.toThrow(SocRequestError);

    expect(sleeps).toHaveLength(3);
    // 100, 200, 400 (plus up to 25% jitter each).
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(125);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]).toBeLessThan(250);
    expect(sleeps[2]).toBeGreaterThanOrEqual(400);
    expect(sleeps[2]).toBeLessThan(500);
  });

  it('retries 5xx and 429 but NOT other 4xx', async () => {
    for (const [status, expectedAttempts] of [
      [500, 3],
      [429, 3],
      [404, 1],
      [400, 1],
    ] as const) {
      let attempts = 0;
      const fetchImpl = vi.fn(async () => {
        attempts++;
        return jsonResponse(null, status);
      }) as unknown as typeof fetch;

      const client = new RutgersSocClient({ fetchImpl, sleepImpl: noSleep, maxRetries: 2 });
      await expect(client.fetchOpenIndexes(term)).rejects.toThrow(SocRequestError);
      expect(attempts, `status ${status}`).toBe(expectedAttempts);
    }
  });

  it('gives up after maxRetries and reports a useful error', async () => {
    const client = new RutgersSocClient({
      fetchImpl: vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
      sleepImpl: noSleep,
      maxRetries: 1,
    });
    await expect(client.fetchOpenIndexes(term)).rejects.toThrow(/boom/);
  });

  it('aborts a request that exceeds the timeout', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    }) as unknown as typeof fetch;

    const client = new RutgersSocClient({
      fetchImpl,
      sleepImpl: noSleep,
      timeoutMs: 10,
      maxRetries: 0,
    });
    await expect(client.fetchOpenIndexes(term)).rejects.toThrow(/abort/i);
  });
});

describe('getSectionByIndex', () => {
  it('finds a section and applies live open status', async () => {
    const client = new RutgersSocClient({
      fetchImpl: makeFetch({ openSections: () => jsonResponse(['12848']) }),
      sleepImpl: noSleep,
    });

    const section = await client.getSectionByIndex('12848', term);
    expect(section).not.toBeNull();
    expect(section!.sectionNumber).toBe('04');
    // Catalog says CLOSED; the live feed says open and must win.
    expect(section!.isOpen).toBe(true);
  });

  it('returns null for an index that does not exist', async () => {
    const client = new RutgersSocClient({ fetchImpl: makeFetch({}), sleepImpl: noSleep });
    expect(await client.getSectionByIndex('99999', term)).toBeNull();
  });
});

describe('getSectionsByCourseCode', () => {
  it('filters the catalog client-side because Rutgers ignores ?subject', async () => {
    const client = new RutgersSocClient({ fetchImpl: makeFetch({}), sleepImpl: noSleep });

    const sections = await client.getSectionsByCourseCode('01:640:135', term);
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.sectionNumber)).toEqual(['01', '02', '03', '04']);

    expect(await client.getSectionsByCourseCode('01:198:111', term)).toEqual([]);
  });
});

describe('catalog caching', () => {
  it('does not re-download the large catalog within the cache window', async () => {
    const fetchImpl = makeFetch({});
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    let clock = 0;
    const client = new RutgersSocClient({
      fetchImpl,
      sleepImpl: noSleep,
      catalogCacheMs: 60_000,
      nowImpl: () => clock,
    });

    await client.fetchCatalog(term);
    await client.fetchCatalog(term);
    expect(mock.mock.calls.filter((c) => String(c[0]).includes('courses.json'))).toHaveLength(1);

    clock += 61_000; // cache expires
    await client.fetchCatalog(term);
    expect(mock.mock.calls.filter((c) => String(c[0]).includes('courses.json'))).toHaveLength(2);
  });

  it('collapses concurrent catalog requests into one download', async () => {
    const fetchImpl = makeFetch({});
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const client = new RutgersSocClient({ fetchImpl, sleepImpl: noSleep });

    await Promise.all([client.fetchCatalog(term), client.fetchCatalog(term), client.fetchCatalog(term)]);
    expect(mock.mock.calls.filter((c) => String(c[0]).includes('courses.json'))).toHaveLength(1);
  });
});

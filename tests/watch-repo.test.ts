/** Persistence: duplicate prevention, transitions bookkeeping, restart survival. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DuplicateWatchError, isAwaitingReply, WatchRepository } from '../src/db/watch-repo.js';

const term = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

function baseWatch(overrides: Partial<Parameters<WatchRepository['create']>[0]> = {}) {
  return {
    indexNumber: '12845',
    courseCode: '01:640:135',
    courseTitle: 'CALCULUS I',
    sectionNumber: '01',
    chatId: '123456789',
    ...term,
    ...overrides,
  };
}

describe('WatchRepository', () => {
  let repo: WatchRepository;

  beforeEach(() => {
    repo = new WatchRepository(':memory:');
  });
  afterEach(() => repo.close());

  it('creates and reads back a watch', () => {
    const watch = repo.create(baseWatch());
    expect(watch.id).toBeGreaterThan(0);
    expect(watch.indexNumber).toBe('12845');
    expect(watch.active).toBe(true);
    expect(watch.lastStatus).toBe('unknown');
    expect(watch.createdAt).toBeTruthy();
    expect(repo.getById(watch.id)).toEqual(watch);
  });

  it('stores the initial status observed at creation time', () => {
    const watch = repo.create(baseWatch({ initialStatus: 'closed' }));
    expect(watch.lastStatus).toBe('closed');
  });

  describe('duplicate prevention', () => {
    it('refuses a second active watch for the same chat, term and index', () => {
      repo.create(baseWatch());
      expect(() => repo.create(baseWatch())).toThrow(DuplicateWatchError);
      expect(repo.listActive()).toHaveLength(1);
    });

    it('exposes the existing watch on the error', () => {
      const first = repo.create(baseWatch());
      try {
        repo.create(baseWatch());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateWatchError);
        expect((err as DuplicateWatchError).existing.id).toBe(first.id);
      }
    });

    it('allows the same index for a DIFFERENT chat', () => {
      repo.create(baseWatch());
      expect(() => repo.create(baseWatch({ chatId: '999' }))).not.toThrow();
      expect(repo.listActive()).toHaveLength(2);
    });

    it('allows the same index in a different term or campus', () => {
      repo.create(baseWatch());
      expect(() => repo.create(baseWatch({ term: 'spring' }))).not.toThrow();
      expect(() => repo.create(baseWatch({ year: 2027 }))).not.toThrow();
      expect(() => repo.create(baseWatch({ campus: 'NK' }))).not.toThrow();
      expect(repo.listActive()).toHaveLength(4);
    });

    it('allows re-adding a watch after it was stopped', () => {
      repo.create(baseWatch());
      expect(repo.deactivate('123456789', '12845', term)).toBe(1);
      expect(() => repo.create(baseWatch())).not.toThrow();
      expect(repo.listActive()).toHaveLength(1);
    });
  });

  describe('listing and stopping', () => {
    it('lists only active watches by default', () => {
      repo.create(baseWatch());
      repo.create(baseWatch({ indexNumber: '12846' }));
      repo.deactivate('123456789', '12846', term);

      expect(repo.listByChat('123456789')).toHaveLength(1);
      expect(repo.listByChat('123456789', { includeInactive: true })).toHaveLength(2);
    });

    it('scopes listings to one chat', () => {
      repo.create(baseWatch());
      repo.create(baseWatch({ chatId: '999' }));
      expect(repo.listByChat('123456789')).toHaveLength(1);
      expect(repo.listAll()).toHaveLength(2);
    });

    it('reports 0 when stopping something not being watched', () => {
      expect(repo.deactivate('123456789', '55555', term)).toBe(0);
    });

    it('stops every watch for a chat', () => {
      repo.create(baseWatch());
      repo.create(baseWatch({ indexNumber: '12846' }));
      repo.create(baseWatch({ chatId: '999' }));

      expect(repo.deactivateAllForChat('123456789')).toBe(2);
      expect(repo.listByChat('123456789')).toHaveLength(0);
      expect(repo.listByChat('999')).toHaveLength(1);
    });

    it('lists the distinct chats that have active watches', () => {
      repo.create(baseWatch());
      repo.create(baseWatch({ indexNumber: '12846' }));
      repo.create(baseWatch({ chatId: '999' }));
      expect(repo.activeChatIds().sort()).toEqual(['123456789', '999']);
    });
  });

  describe('check bookkeeping', () => {
    it('records a check and stamps opened_at on a transition', () => {
      const watch = repo.create(baseWatch({ initialStatus: 'closed' }));

      repo.recordCheck(watch.id, 'open', { justOpened: true });
      const after = repo.getById(watch.id)!;
      expect(after.lastStatus).toBe('open');
      expect(after.lastCheckedAt).toBeTruthy();
      expect(after.openedAt).toBeTruthy();
      expect(after.reminderSentAt).toBeNull();
    });

    it('clears open bookkeeping when a section closes again', () => {
      const watch = repo.create(baseWatch());
      repo.recordCheck(watch.id, 'open', { justOpened: true });
      repo.markReminderSent(watch.id);
      repo.recordCheck(watch.id, 'closed');

      const after = repo.getById(watch.id)!;
      expect(after.lastStatus).toBe('closed');
      expect(after.openedAt).toBeNull();
      expect(after.reminderSentAt).toBeNull();
    });

    it('keeps opened_at while a section stays open', () => {
      const watch = repo.create(baseWatch());
      repo.recordCheck(watch.id, 'open', { justOpened: true });
      const openedAt = repo.getById(watch.id)!.openedAt;
      repo.recordCheck(watch.id, 'open');
      expect(repo.getById(watch.id)!.openedAt).toBe(openedAt);
    });

    it('records notification timestamps', () => {
      const watch = repo.create(baseWatch());
      expect(watch.lastNotifiedAt).toBeNull();
      repo.markNotified(watch.id);
      expect(repo.getById(watch.id)!.lastNotifiedAt).toBeTruthy();
    });

    it('backfills missing metadata without overwriting known values', () => {
      const watch = repo.create(baseWatch({ courseTitle: null, sectionNumber: null }));
      repo.updateMetadata(watch.id, { courseTitle: 'CALC I', sectionNumber: '04' });

      let after = repo.getById(watch.id)!;
      expect(after.courseTitle).toBe('CALC I');
      expect(after.sectionNumber).toBe('04');

      // COALESCE means a null update must not wipe an existing value.
      repo.updateMetadata(watch.id, { courseTitle: null });
      after = repo.getById(watch.id)!;
      expect(after.courseTitle).toBe('CALC I');
    });
  });
});

describe('follow-up bookkeeping', () => {
  let repo: WatchRepository;
  let clock: number;

  beforeEach(() => {
    clock = new Date('2026-08-01T00:00:00Z').getTime();
    repo = new WatchRepository(':memory:', { now: () => new Date(clock) });
  });
  afterEach(() => repo.close());

  it('counts each closed -> open transition', () => {
    const w = repo.create(baseWatch({ initialStatus: 'closed' }));

    repo.recordCheck(w.id, 'open', { justOpened: true });
    repo.recordCheck(w.id, 'open');
    expect(repo.getById(w.id)!.openCount).toBe(1);

    repo.recordCheck(w.id, 'closed');
    repo.recordCheck(w.id, 'open', { justOpened: true });
    expect(repo.getById(w.id)!.openCount).toBe(2);
  });

  it('schedules the question only when asked to', () => {
    const w = repo.create(baseWatch());

    repo.markNotified(w.id);
    expect(repo.getById(w.id)!.followupDueAt).toBeNull();

    repo.markNotified(w.id, 15 * 60_000);
    expect(repo.getById(w.id)!.followupDueAt).toBe('2026-08-01T00:15:00.000Z');
  });

  it('reports a question as due only once the delay has passed', () => {
    const w = repo.create(baseWatch());
    repo.markNotified(w.id, 15 * 60_000);

    expect(repo.listFollowupDue(new Date(clock + 10 * 60_000))).toHaveLength(0);
    expect(repo.listFollowupDue(new Date(clock + 16 * 60_000))).toHaveLength(1);

    repo.markFollowupSent(w.id);
    expect(repo.listFollowupDue(new Date(clock + 60 * 60_000))).toHaveLength(0);
  });

  it('stops the watch when the answer is "I got in"', () => {
    const w = repo.create(baseWatch());
    repo.markNotified(w.id, 60_000);
    repo.markFollowupSent(w.id);
    expect(isAwaitingReply(repo.getById(w.id)!)).toBe(true);

    const resolved = repo.recordOutcome(w.id, 'registered')!;
    expect(resolved.outcome).toBe('registered');
    expect(resolved.active).toBe(false);
    expect(resolved.resolvedAt).toBeTruthy();
    expect(isAwaitingReply(resolved)).toBe(false);
    expect(repo.listActive()).toHaveLength(0);
  });

  it('keeps watching when the answer is "I missed it"', () => {
    const w = repo.create(baseWatch());
    repo.markNotified(w.id, 60_000);
    repo.markFollowupSent(w.id);

    const resolved = repo.recordOutcome(w.id, 'missed')!;
    expect(resolved.outcome).toBe('missed');
    expect(resolved.active).toBe(true);
    expect(isAwaitingReply(resolved)).toBe(false);
    expect(repo.listActive()).toHaveLength(1);
  });

  it('lists only watches still waiting on an answer, per chat', () => {
    const mine = repo.create(baseWatch({ chatId: '111' }));
    const theirs = repo.create(baseWatch({ chatId: '222' }));
    const quiet = repo.create(baseWatch({ indexNumber: '12846', chatId: '111' }));

    for (const w of [mine, theirs]) {
      repo.markNotified(w.id, 60_000);
      repo.markFollowupSent(w.id);
    }

    expect(repo.listAwaitingReply().map((w) => w.id).sort()).toEqual([mine.id, theirs.id]);
    expect(repo.listAwaitingReply('111').map((w) => w.id)).toEqual([mine.id]);
    expect(repo.listAwaitingReply('111')).not.toContainEqual(
      expect.objectContaining({ id: quiet.id }),
    );

    repo.recordOutcome(mine.id, 'missed');
    expect(repo.listAwaitingReply('111')).toHaveLength(0);
  });

  it('finds an active watch by index when no term is given', () => {
    repo.create(baseWatch());
    expect(repo.findActiveByIndex('123456789', '12845')?.indexNumber).toBe('12845');
    expect(repo.findActiveByIndex('123456789', '99999')).toBeNull();

    repo.deactivate('123456789', '12845', term);
    expect(repo.findActiveByIndex('123456789', '12845')).toBeNull();
  });
});

describe('persistence across restarts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rutgers-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps watches after the process closes and reopens the database', () => {
    const path = join(dir, 'nested', 'watches.sqlite');

    const first = new WatchRepository(path);
    first.create(baseWatch());
    first.close();

    // Simulates a restart / reboot.
    const second = new WatchRepository(path);
    const watches = second.listActive();
    expect(watches).toHaveLength(1);
    expect(watches[0].indexNumber).toBe('12845');
    expect(watches[0].courseTitle).toBe('CALCULUS I');
    second.close();
  });

  it('still enforces duplicates after a reopen', () => {
    const path = join(dir, 'watches.sqlite');
    const first = new WatchRepository(path);
    first.create(baseWatch());
    first.close();

    const second = new WatchRepository(path);
    expect(() => second.create(baseWatch())).toThrow(DuplicateWatchError);
    second.close();
  });

  it('adds the follow-up columns to a database created before they existed', () => {
    const path = join(dir, 'legacy.sqlite');

    // Exactly the schema shipped in the first release, plus a row, so we prove
    // an upgrade in place does not lose existing watches.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE watches (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        index_number     TEXT    NOT NULL,
        course_code      TEXT,
        course_title     TEXT,
        section_number   TEXT,
        instructors      TEXT,
        year             INTEGER NOT NULL,
        term             TEXT    NOT NULL,
        campus           TEXT    NOT NULL,
        last_status      TEXT    NOT NULL DEFAULT 'unknown',
        active           INTEGER NOT NULL DEFAULT 1,
        chat_id          TEXT    NOT NULL,
        created_at       TEXT    NOT NULL,
        last_checked_at  TEXT,
        last_notified_at TEXT,
        opened_at        TEXT,
        reminder_sent_at TEXT
      );
      INSERT INTO watches (index_number, year, term, campus, chat_id, created_at)
      VALUES ('12845', 2026, 'fall', 'NB', '123456789', '2026-08-03T00:00:00.000Z');
    `);
    legacy.close();

    const repo = new WatchRepository(path);
    const watches = repo.listActive();
    expect(watches).toHaveLength(1);
    expect(watches[0].indexNumber).toBe('12845');
    expect(watches[0].followupDueAt).toBeNull();
    expect(watches[0].followupSentAt).toBeNull();
    expect(watches[0].outcome).toBeNull();
    expect(watches[0].openCount).toBe(0);

    // And a second open must be a no-op rather than an error.
    repo.close();
    const again = new WatchRepository(path);
    expect(again.listActive()).toHaveLength(1);
    again.close();
  });
});

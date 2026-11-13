/**
 * SQLite storage for watches.
 *
 * SQLite is a database that lives in a single file on disk. That is exactly
 * what we want here: watches survive restarts and reboots, with no separate
 * database server to install or keep running.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CampusCode, TermName } from '../rutgers/terms.js';

export type WatchStatus = 'open' | 'closed' | 'unknown';

/**
 * What the human told us after a section opened.
 *
 * `null` means we have not asked, or asked and they have not replied yet.
 */
export type WatchOutcome = 'registered' | 'missed';

export interface Watch {
  id: number;
  indexNumber: string;
  courseCode: string | null;
  courseTitle: string | null;
  sectionNumber: string | null;
  instructors: string | null;
  year: number;
  term: TermName;
  campus: CampusCode;
  /** What we saw last time, so we can detect a closed -> open transition. */
  lastStatus: WatchStatus;
  active: boolean;
  chatId: string;
  createdAt: string;
  lastCheckedAt: string | null;
  lastNotifiedAt: string | null;
  /** Set when we alert; the repeat clock counts from here until the first repeat. */
  openedAt: string | null;
  /** When we last re-alerted about the CURRENT opening. Null until the first repeat. */
  reminderSentAt: string | null;
  /** How many repeats we have sent for the current opening. Reset on each new one. */
  repeatCount: number;
  /**
   * When the "did you get in?" question becomes due. Stamped once an open alert
   * is actually delivered, and deliberately NOT cleared when the section closes
   * again — the section filling up is exactly when we most want to ask.
   */
  followupDueAt: string | null;
  /** When we asked. Non-null with a null `outcome` means we are still waiting. */
  followupSentAt: string | null;
  outcome: WatchOutcome | null;
  resolvedAt: string | null;
  /** How many closed -> open transitions we have seen for this watch. */
  openCount: number;
}

export interface CreateWatchInput {
  indexNumber: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  sectionNumber?: string | null;
  instructors?: string | null;
  year: number;
  term: TermName;
  campus: CampusCode;
  chatId: string;
  initialStatus?: WatchStatus;
}

/** Raw row shape as stored (SQLite has no boolean type; we use 0/1). */
interface WatchRow {
  id: number;
  index_number: string;
  course_code: string | null;
  course_title: string | null;
  section_number: string | null;
  instructors: string | null;
  year: number;
  term: string;
  campus: string;
  last_status: string;
  active: number;
  chat_id: string;
  created_at: string;
  last_checked_at: string | null;
  last_notified_at: string | null;
  opened_at: string | null;
  reminder_sent_at: string | null;
  repeat_count: number;
  followup_due_at: string | null;
  followup_sent_at: string | null;
  outcome: string | null;
  resolved_at: string | null;
  open_count: number;
}

function rowToWatch(row: WatchRow): Watch {
  return {
    id: row.id,
    indexNumber: row.index_number,
    courseCode: row.course_code,
    courseTitle: row.course_title,
    sectionNumber: row.section_number,
    instructors: row.instructors,
    year: row.year,
    term: row.term as TermName,
    campus: row.campus as CampusCode,
    lastStatus: row.last_status as WatchStatus,
    active: row.active === 1,
    chatId: row.chat_id,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    lastNotifiedAt: row.last_notified_at,
    openedAt: row.opened_at,
    reminderSentAt: row.reminder_sent_at,
    repeatCount: row.repeat_count ?? 0,
    followupDueAt: row.followup_due_at,
    followupSentAt: row.followup_sent_at,
    outcome: (row.outcome as WatchOutcome | null) ?? null,
    resolvedAt: row.resolved_at,
    openCount: row.open_count ?? 0,
  };
}

/** True when we asked "did you get in?" and the human has not answered yet. */
export function isAwaitingReply(watch: Watch): boolean {
  return watch.followupSentAt !== null && watch.outcome === null;
}

export class DuplicateWatchError extends Error {
  constructor(readonly existing: Watch) {
    super(
      `You are already watching index ${existing.indexNumber} for ${existing.term} ${existing.year}.`,
    );
    this.name = 'DuplicateWatchError';
  }
}

export interface WatchRepoOptions {
  /** Injectable clock keeps tests deterministic. */
  now?: () => Date;
}

export class WatchRepository {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(databasePath: string, options: WatchRepoOptions = {}) {
    this.now = options.now ?? (() => new Date());

    if (databasePath !== ':memory:') {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }
    this.db = new Database(databasePath);
    // WAL lets the CLI read while the worker writes, without locking errors.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watches (
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

      -- Enforces "no duplicate ACTIVE watch for the same chat + term + index".
      -- Partial index: inactive rows are ignored, so you can stop and re-add.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_unique_active
        ON watches (chat_id, year, term, campus, index_number)
        WHERE active = 1;

      CREATE INDEX IF NOT EXISTS idx_watches_active ON watches (active);
      CREATE INDEX IF NOT EXISTS idx_watches_chat   ON watches (chat_id);
    `);

    // Follow-up columns were added after the first release, so an existing
    // database on disk will not have them. ADD COLUMN is cheap and preserves
    // every existing row; we skip any column that is already present so this
    // stays safe to run on every startup.
    this.addColumnIfMissing('followup_due_at', 'TEXT');
    this.addColumnIfMissing('followup_sent_at', 'TEXT');
    this.addColumnIfMissing('outcome', 'TEXT');
    this.addColumnIfMissing('resolved_at', 'TEXT');
    this.addColumnIfMissing('open_count', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('repeat_count', 'INTEGER NOT NULL DEFAULT 0');
  }

  private addColumnIfMissing(column: string, definition: string): void {
    const columns = this.db.prepare('PRAGMA table_info(watches)').all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE watches ADD COLUMN ${column} ${definition}`);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  create(input: CreateWatchInput): Watch {
    const existing = this.findActive(input.chatId, input.indexNumber, {
      year: input.year,
      term: input.term,
      campus: input.campus,
    });
    if (existing) throw new DuplicateWatchError(existing);

    const stmt = this.db.prepare(`
      INSERT INTO watches (
        index_number, course_code, course_title, section_number, instructors,
        year, term, campus, last_status, active, chat_id, created_at
      ) VALUES (
        @index_number, @course_code, @course_title, @section_number, @instructors,
        @year, @term, @campus, @last_status, 1, @chat_id, @created_at
      )
    `);

    try {
      const info = stmt.run({
        index_number: input.indexNumber,
        course_code: input.courseCode ?? null,
        course_title: input.courseTitle ?? null,
        section_number: input.sectionNumber ?? null,
        instructors: input.instructors ?? null,
        year: input.year,
        term: input.term,
        campus: input.campus,
        last_status: input.initialStatus ?? 'unknown',
        chat_id: input.chatId,
        created_at: this.iso(),
      });
      return this.getById(Number(info.lastInsertRowid))!;
    } catch (err) {
      // Belt and braces: the unique index also guards against a race between
      // two concurrent `create` calls.
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        const dup = this.findActive(input.chatId, input.indexNumber, input);
        if (dup) throw new DuplicateWatchError(dup);
      }
      throw err;
    }
  }

  getById(id: number): Watch | null {
    const row = this.db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as
      | WatchRow
      | undefined;
    return row ? rowToWatch(row) : null;
  }

  findActive(
    chatId: string,
    indexNumber: string,
    term: { year: number; term: TermName; campus: CampusCode },
  ): Watch | null {
    const row = this.db
      .prepare(
        `SELECT * FROM watches
          WHERE chat_id = ? AND index_number = ? AND year = ? AND term = ? AND campus = ?
            AND active = 1`,
      )
      .get(chatId, indexNumber, term.year, term.term, term.campus) as WatchRow | undefined;
    return row ? rowToWatch(row) : null;
  }

  /**
   * Look up one active watch by index, preferring the given term but falling
   * back to any term — people usually just say "12845" without a term.
   */
  findActiveByIndex(
    chatId: string,
    indexNumber: string,
    term?: { year: number; term: TermName; campus: CampusCode },
  ): Watch | null {
    if (term) {
      const exact = this.findActive(chatId, indexNumber, term);
      if (exact) return exact;
    }
    const row = this.db
      .prepare(
        'SELECT * FROM watches WHERE chat_id = ? AND index_number = ? AND active = 1 ORDER BY id LIMIT 1',
      )
      .get(chatId, indexNumber) as WatchRow | undefined;
    return row ? rowToWatch(row) : null;
  }

  /** Every active watch, across all chats — this is what the worker polls. */
  listActive(): Watch[] {
    const rows = this.db
      .prepare('SELECT * FROM watches WHERE active = 1 ORDER BY id')
      .all() as WatchRow[];
    return rows.map(rowToWatch);
  }

  listByChat(chatId: string, options: { includeInactive?: boolean } = {}): Watch[] {
    const sql = options.includeInactive
      ? 'SELECT * FROM watches WHERE chat_id = ? ORDER BY active DESC, id'
      : 'SELECT * FROM watches WHERE chat_id = ? AND active = 1 ORDER BY id';
    return (this.db.prepare(sql).all(chatId) as WatchRow[]).map(rowToWatch);
  }

  listAll(options: { includeInactive?: boolean } = {}): Watch[] {
    const sql = options.includeInactive
      ? 'SELECT * FROM watches ORDER BY active DESC, id'
      : 'SELECT * FROM watches WHERE active = 1 ORDER BY id';
    return (this.db.prepare(sql).all() as WatchRow[]).map(rowToWatch);
  }

  /** Marks matching active watches inactive. Returns how many were stopped. */
  deactivate(
    chatId: string,
    indexNumber: string,
    term?: { year: number; term: TermName; campus: CampusCode },
  ): number {
    if (term) {
      const info = this.db
        .prepare(
          `UPDATE watches SET active = 0
             WHERE chat_id = ? AND index_number = ? AND year = ? AND term = ? AND campus = ?
               AND active = 1`,
        )
        .run(chatId, indexNumber, term.year, term.term, term.campus);
      return info.changes;
    }
    const info = this.db
      .prepare('UPDATE watches SET active = 0 WHERE chat_id = ? AND index_number = ? AND active = 1')
      .run(chatId, indexNumber);
    return info.changes;
  }

  deactivateAllForChat(chatId: string): number {
    return this.db
      .prepare('UPDATE watches SET active = 0 WHERE chat_id = ? AND active = 1')
      .run(chatId).changes;
  }

  /** Record a completed poll. Also stamps openedAt on a closed -> open flip. */
  recordCheck(id: number, status: WatchStatus, opts: { justOpened?: boolean } = {}): void {
    const now = this.iso();
    if (opts.justOpened) {
      this.db
        .prepare(
          `UPDATE watches
             SET last_status = ?, last_checked_at = ?, opened_at = ?, reminder_sent_at = NULL,
                 open_count = open_count + 1
           WHERE id = ?`,
        )
        .run(status, now, now, id);
      return;
    }
    // Leaving "open" clears the opened/reminder bookkeeping for the next cycle.
    if (status !== 'open') {
      this.db
        .prepare(
          `UPDATE watches
             SET last_status = ?, last_checked_at = ?, opened_at = NULL, reminder_sent_at = NULL
           WHERE id = ?`,
        )
        .run(status, now, id);
      return;
    }
    this.db
      .prepare('UPDATE watches SET last_status = ?, last_checked_at = ? WHERE id = ?')
      .run(status, now, id);
  }

  /**
   * Record that an open alert was delivered.
   *
   * `followupAfterMs > 0` also schedules the "did you get in?" question. A fresh
   * alert clears any previous unanswered question, so we ask about the newest
   * opening rather than a stale one.
   *
   * The repeat clock is reset here too. Without that, a watch that opened last
   * week and got its reminders would carry a stale `reminder_sent_at` into
   * today's opening, and the first repeat would fire instantly instead of one
   * interval later.
   */
  markNotified(id: number, followupAfterMs = 0): void {
    const now = this.iso();
    if (followupAfterMs > 0) {
      const dueAt = new Date(this.now().getTime() + followupAfterMs).toISOString();
      this.db
        .prepare(
          `UPDATE watches
             SET last_notified_at = ?, followup_due_at = ?, followup_sent_at = NULL,
                 outcome = NULL, resolved_at = NULL,
                 reminder_sent_at = NULL, repeat_count = 0
           WHERE id = ?`,
        )
        .run(now, dueAt, id);
      return;
    }
    this.db
      .prepare(
        `UPDATE watches
           SET last_notified_at = ?, reminder_sent_at = NULL, repeat_count = 0
         WHERE id = ?`,
      )
      .run(now, id);
  }

  /**
   * Active watches whose follow-up question is due to be asked.
   *
   * Deliberately not filtered by current status: a section that opened and then
   * closed again is the most interesting case to ask about.
   */
  listFollowupDue(asOf: Date = this.now()): Watch[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watches
          WHERE active = 1 AND followup_due_at IS NOT NULL AND followup_sent_at IS NULL
            AND followup_due_at <= ?
          ORDER BY id`,
      )
      .all(asOf.toISOString()) as WatchRow[];
    return rows.map(rowToWatch);
  }

  markFollowupSent(id: number): void {
    this.db
      .prepare('UPDATE watches SET followup_sent_at = ?, followup_due_at = NULL WHERE id = ?')
      .run(this.iso(), id);
  }

  /** Active watches we have asked about and are still waiting on. */
  listAwaitingReply(chatId?: string): Watch[] {
    const sql = `SELECT * FROM watches
                  WHERE active = 1 AND followup_sent_at IS NOT NULL AND outcome IS NULL
                    ${chatId ? 'AND chat_id = ?' : ''}
                  ORDER BY id`;
    const stmt = this.db.prepare(sql);
    const rows = (chatId ? stmt.all(chatId) : stmt.all()) as WatchRow[];
    return rows.map(rowToWatch);
  }

  /**
   * Record the human's answer.
   *
   * `registered` stops the watch — they are in, there is nothing left to alert
   * about. `missed` clears the question and keeps watching for the next opening.
   */
  recordOutcome(id: number, outcome: WatchOutcome): Watch | null {
    const now = this.iso();
    if (outcome === 'registered') {
      this.db
        .prepare(
          `UPDATE watches
             SET outcome = 'registered', resolved_at = ?, active = 0, followup_due_at = NULL
           WHERE id = ?`,
        )
        .run(now, id);
    } else {
      // `followup_sent_at` stays as a record of when we asked; the non-null
      // outcome is what takes it out of the awaiting-reply set.
      this.db
        .prepare(
          `UPDATE watches SET outcome = 'missed', resolved_at = ?, followup_due_at = NULL
           WHERE id = ?`,
        )
        .run(now, id);
    }
    return this.getById(id);
  }

  /** Record one repeat alert for the current opening and advance its counter. */
  markReminderSent(id: number): void {
    const now = this.iso();
    this.db
      .prepare(
        `UPDATE watches
           SET reminder_sent_at = ?, last_notified_at = ?, repeat_count = repeat_count + 1
         WHERE id = ?`,
      )
      .run(now, now, id);
  }

  /** Fill in metadata we could not resolve when the watch was created. */
  updateMetadata(
    id: number,
    meta: {
      courseTitle?: string | null;
      courseCode?: string | null;
      sectionNumber?: string | null;
      instructors?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE watches SET
            course_title   = COALESCE(?, course_title),
            course_code    = COALESCE(?, course_code),
            section_number = COALESCE(?, section_number),
            instructors    = COALESCE(?, instructors)
          WHERE id = ?`,
      )
      .run(
        meta.courseTitle ?? null,
        meta.courseCode ?? null,
        meta.sectionNumber ?? null,
        meta.instructors ?? null,
        id,
      );
  }

  /** Distinct chat ids with at least one active watch (for failure alerts). */
  activeChatIds(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT chat_id FROM watches WHERE active = 1')
      .all() as Array<{ chat_id: string }>;
    return rows.map((r) => r.chat_id);
  }

  close(): void {
    this.db.close();
  }
}

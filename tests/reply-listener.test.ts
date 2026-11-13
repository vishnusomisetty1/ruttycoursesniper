/**
 * The Telegram reply path.
 *
 * Two things are being pinned down here: that a plain "yes" resolves the right
 * watch, and — more importantly — that this listener can do NOTHING ELSE. It
 * exists so somebody can answer a question without being given access to the
 * machine, and that guarantee is only worth what the tests below prove.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { WatchRepository } from '../src/db/watch-repo.js';
import { NullNotifier, type TelegramUpdatesResult } from '../src/telegram/client.js';
import { ReplyListener } from '../src/worker/reply-listener.js';
import type { Logger } from '../src/logger.js';

const term = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

function baseWatch(overrides = {}) {
  return {
    indexNumber: '12845',
    courseCode: '01:640:135',
    courseTitle: 'CALCULUS I',
    sectionNumber: '01',
    chatId: '999',
    ...term,
    ...overrides,
  };
}

/** A fake inbox we can push messages into. */
class FakeUpdates {
  enabled = true;
  queue: TelegramUpdatesResult[] = [];
  offsets: Array<number | null> = [];

  async fetchUpdates(offset: number | null): Promise<TelegramUpdatesResult> {
    this.offsets.push(offset);
    return this.queue.shift() ?? { ok: true, messages: [] };
  }
}

function setup(options: { allowedChatIds?: string[] } = {}) {
  const repo = new WatchRepository(':memory:');
  const notifier = new NullNotifier();
  const updates = new FakeUpdates();
  let stored: number | null = null;
  const listener = new ReplyListener({
    repo,
    notifier,
    updates,
    allowedChatIds: options.allowedChatIds,
    readOffset: () => stored,
    writeOffset: (o) => {
      stored = o;
    },
  });
  return { repo, notifier, updates, listener, getOffset: () => stored };
}

/** Put a watch into the "we asked, waiting for an answer" state. */
function makePending(repo: WatchRepository, overrides = {}) {
  const watch = repo.create(baseWatch(overrides));
  repo.markNotified(watch.id, 60_000);
  repo.markFollowupSent(watch.id);
  return repo.getById(watch.id)!;
}

describe('recording an answer', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.repo.close());

  it('stops the watch on "yes"', async () => {
    const watch = makePending(ctx.repo);

    const result = await ctx.listener.handleMessage('999', 'yes');

    expect(result.action).toBe('recorded');
    const after = ctx.repo.getById(watch.id)!;
    expect(after.outcome).toBe('registered');
    expect(after.active).toBe(false);
    expect(ctx.notifier.sent[0].text).toContain("you're in");
  });

  it('keeps the watch on "no"', async () => {
    const watch = makePending(ctx.repo);

    await ctx.listener.handleMessage('999', 'nope, it filled up');

    const after = ctx.repo.getById(watch.id)!;
    expect(after.outcome).toBe('missed');
    expect(after.active).toBe(true);
    expect(ctx.notifier.sent[0].text).toContain('Still watching');
  });

  it('asks again rather than guessing at an ambiguous answer', async () => {
    const watch = makePending(ctx.repo);

    const result = await ctx.listener.handleMessage('999', 'no way, i got in!');

    expect(result.action).toBe('clarify');
    expect(ctx.repo.getById(watch.id)!.outcome).toBeNull();
    expect(ctx.notifier.sent[0].text).toContain('could not tell');
  });

  it('says nothing at all to unrelated chatter', async () => {
    makePending(ctx.repo);

    const result = await ctx.listener.handleMessage('999', 'what time does it meet?');

    expect(result).toEqual({ action: 'ignored', reason: 'not a yes/no answer' });
    expect(ctx.notifier.sent).toHaveLength(0);
  });

  it('logs unrelated chatter even though it stays silent in Telegram', async () => {
    // Silence towards the user, not silence in the logs: without this line,
    // "received and ignored" looks identical to "never arrived".
    const lines: string[] = [];
    const recorder: Logger = {
      debug: () => {},
      info: (msg: string) => void lines.push(msg),
      warn: () => {},
      error: () => {},
      child: () => recorder,
    };
    const listener = new ReplyListener({
      repo: ctx.repo,
      notifier: ctx.notifier,
      updates: ctx.updates,
      logger: recorder,
    });
    ctx.repo.create(baseWatch());

    await listener.handleMessage('999', 'hello');

    expect(lines).toContain('received a message that is not a yes/no answer; ignoring');
  });

  it('explains itself when nothing is pending', async () => {
    ctx.repo.create(baseWatch()); // watched, but no question outstanding

    const result = await ctx.listener.handleMessage('999', 'yes');

    expect(result.action).toBe('ignored');
    expect(ctx.notifier.sent[0].text).toContain('not waiting on an answer');
  });
});

describe('choosing which section the answer is about', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.repo.close());

  it('uses the index in the message when one is given', async () => {
    const a = makePending(ctx.repo, { indexNumber: '12845' });
    const b = makePending(ctx.repo, { indexNumber: '12846' });

    await ctx.listener.handleMessage('999', 'yes 12846');

    expect(ctx.repo.getById(a.id)!.outcome).toBeNull();
    expect(ctx.repo.getById(b.id)!.outcome).toBe('registered');
  });

  it('asks which one when several are pending and no index is given', async () => {
    const a = makePending(ctx.repo, { indexNumber: '12845' });
    const b = makePending(ctx.repo, { indexNumber: '12846' });

    const result = await ctx.listener.handleMessage('999', 'yes');

    expect(result.action).toBe('clarify');
    expect(ctx.repo.getById(a.id)!.outcome).toBeNull();
    expect(ctx.repo.getById(b.id)!.outcome).toBeNull();
    expect(ctx.notifier.sent[0].text).toContain('12845');
    expect(ctx.notifier.sent[0].text).toContain('12846');
  });

  it('refuses an index it is not waiting on', async () => {
    const watch = makePending(ctx.repo, { indexNumber: '12845' });

    const result = await ctx.listener.handleMessage('999', 'yes 55555');

    expect(result.action).toBe('clarify');
    expect(ctx.repo.getById(watch.id)!.outcome).toBeNull();
    expect(ctx.notifier.sent[0].text).toContain('not waiting on an answer about');
  });
});

describe('access boundary', () => {
  it('ignores a chat that has no watches here', async () => {
    const ctx = setup();
    makePending(ctx.repo, { chatId: '999' });

    const result = await ctx.listener.handleMessage('12345', 'yes');

    expect(result.action).toBe('ignored');
    expect(ctx.notifier.sent).toHaveLength(0);
    ctx.repo.close();
  });

  it('honours an explicit allowlist', async () => {
    const ctx = setup({ allowedChatIds: ['999'] });
    const mine = makePending(ctx.repo, { chatId: '999' });
    const theirs = makePending(ctx.repo, { chatId: '777' });

    await ctx.listener.handleMessage('777', 'yes');
    expect(ctx.repo.getById(theirs.id)!.outcome).toBeNull();

    await ctx.listener.handleMessage('999', 'yes');
    expect(ctx.repo.getById(mine.id)!.outcome).toBe('registered');
    ctx.repo.close();
  });

  it('can never resolve a watch belonging to a different chat', async () => {
    const ctx = setup();
    const mine = makePending(ctx.repo, { chatId: '999', indexNumber: '12845' });
    const theirs = makePending(ctx.repo, { chatId: '777', indexNumber: '12846' });

    // '999' names someone else's index explicitly.
    const result = await ctx.listener.handleMessage('999', 'yes 12846');

    expect(result.action).toBe('clarify');
    expect(ctx.repo.getById(theirs.id)!.outcome).toBeNull();
    expect(ctx.repo.getById(mine.id)!.outcome).toBeNull();
    ctx.repo.close();
  });

  it('cannot create, stop or otherwise touch a watch', async () => {
    const ctx = setup();
    const watch = ctx.repo.create(baseWatch()); // active, nothing pending

    for (const attempt of [
      'watch 01:640:135',
      'stop 12845',
      'stop --all',
      'watch-index 99999 --chat-id 1',
      'rm -rf /',
      '; DROP TABLE watches;--',
    ]) {
      await ctx.listener.handleMessage('999', attempt);
    }

    const after = ctx.repo.getById(watch.id)!;
    expect(after.active).toBe(true);
    expect(after.outcome).toBeNull();
    expect(ctx.repo.listAll({ includeInactive: true })).toHaveLength(1);
    expect(ctx.notifier.sent).toHaveLength(0);
    ctx.repo.close();
  });
});

describe('polling loop', () => {
  it('advances the offset past the whole batch so nothing is replayed', async () => {
    const ctx = setup();
    makePending(ctx.repo);
    ctx.updates.queue.push({
      ok: true,
      messages: [
        { updateId: 40, chatId: '999', text: 'hello' },
        { updateId: 41, chatId: '999', text: 'yes' },
      ],
    });

    const recorded = await ctx.listener.runOnce();

    expect(recorded).toBe(1);
    expect(ctx.getOffset()).toBe(42);
    ctx.repo.close();
  });

  it('advances past non-text updates it cannot act on', async () => {
    const ctx = setup();
    ctx.updates.queue.push({ ok: true, messages: [{ updateId: 7, chatId: '', text: '' }] });

    await ctx.listener.runOnce();

    expect(ctx.getOffset()).toBe(8);
    ctx.repo.close();
  });

  it('does not rewrite the offset on an empty poll', async () => {
    const ctx = setup();
    ctx.updates.queue.push({ ok: true, messages: [{ updateId: 10, chatId: '', text: '' }] });
    await ctx.listener.runOnce();
    expect(ctx.getOffset()).toBe(11);

    // An idle long-poll returns nothing every ~25s. Rewriting the same value
    // each time is churn, and makes the file's mtime look like a fresh receipt.
    const writes: number[] = [];
    const quiet = new ReplyListener({
      repo: ctx.repo,
      notifier: ctx.notifier,
      updates: ctx.updates,
      readOffset: () => 11,
      writeOffset: (o) => writes.push(o),
    });
    await quiet.runOnce();
    await quiet.runOnce();

    expect(writes).toEqual([]);
    ctx.repo.close();
  });

  it('does not move the offset when the fetch fails', async () => {
    const ctx = setup();
    ctx.updates.queue.push({ ok: false, messages: [], error: 'HTTP 409' });

    const recorded = await ctx.listener.runOnce();

    expect(recorded).toBe(0);
    expect(ctx.getOffset()).toBeNull();
    ctx.repo.close();
  });

  it('keeps going when one message in a batch throws', async () => {
    const ctx = setup();
    makePending(ctx.repo);
    // A message from an unknown chat is ignored, not fatal to the batch.
    ctx.updates.queue.push({
      ok: true,
      messages: [
        { updateId: 1, chatId: '404', text: 'yes' },
        { updateId: 2, chatId: '999', text: 'yes' },
      ],
    });

    const recorded = await ctx.listener.runOnce();

    expect(recorded).toBe(1);
    expect(ctx.getOffset()).toBe(3);
    ctx.repo.close();
  });
});

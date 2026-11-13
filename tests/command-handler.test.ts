/**
 * Telegram slash commands.
 *
 * The load-bearing property: a command can only ever touch the SENDER's own
 * watches. Everything else here is convenience.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { WatchRepository } from '../src/db/watch-repo.js';
import { NullNotifier } from '../src/telegram/client.js';
import { CommandHandler } from '../src/worker/command-handler.js';
import { parseCommand } from '../src/telegram/parse-command.js';
import type { RutgersSocClient } from '../src/rutgers/soc-client.js';

const term = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

const section = {
  indexNumber: '12845',
  sectionNumber: '01',
  courseTitle: 'CALCULUS I',
  courseString: '01:640:135',
  subject: '640',
  subjectDescription: null,
  courseNumber: '135',
  credits: 4,
  instructors: ['BANERJEE'],
  meetings: [],
  isOpen: false,
  statusText: 'CLOSED',
  ...term,
};

type AnyTerm = { year: number; term: string; campus: string };

class FakeClient {
  open = new Set<string>();
  sections = [section];
  failOpen = false;
  /** Every term we were asked about, so tests can assert what was requested. */
  askedTerms: AnyTerm[] = [];

  async fetchOpenIndexes(t: AnyTerm) {
    this.askedTerms.push(t);
    if (this.failOpen) throw new Error('Rutgers is down');
    return new Set(this.open);
  }
  async getSectionByIndex(index: string, t: AnyTerm) {
    this.askedTerms.push(t);
    return this.sections.find((s) => s.indexNumber === index) ?? null;
  }
  async getSectionsByCourseCode(code: string, t: AnyTerm) {
    this.askedTerms.push(t);
    return this.sections.filter((s) => s.courseString === code);
  }
}

function setup() {
  const repo = new WatchRepository(':memory:');
  const notifier = new NullNotifier();
  const client = new FakeClient();
  const handler = new CommandHandler({
    repo,
    client: client as unknown as RutgersSocClient,
    notifier,
    defaultTerm: term,
    databasePath: ':memory:',
    pollIntervalSeconds: 30,
  });
  const run = (chatId: string, text: string) => handler.handle(chatId, parseCommand(text)!);
  return { repo, notifier, client, handler, run };
}

describe('/help', () => {
  it('lists every command it actually supports', async () => {
    const ctx = setup();
    const reply = await ctx.run('999', '/help');
    for (const cmd of ['/watch', '/stop', '/list', '/status', '/check', '/pending', '/help']) {
      expect(reply).toContain(cmd);
    }
    expect(reply).toContain('you</b> register in WebReg');
    ctx.repo.close();
  });
});

describe('/watch', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.repo.close());

  it('creates a watch from an index number', async () => {
    const reply = await ctx.run('999', '/watch 12845');

    expect(reply).toContain('Now watching');
    const watches = ctx.repo.listByChat('999');
    expect(watches).toHaveLength(1);
    expect(watches[0].indexNumber).toBe('12845');
  });

  it('never creates a watch from a course code — it asks which section', async () => {
    const reply = await ctx.run('999', '/watch 01:640:135');

    expect(reply).toContain('Reply with the index number');
    expect(ctx.repo.listByChat('999')).toHaveLength(0);
  });

  it('refuses a duplicate instead of creating a second one', async () => {
    await ctx.run('999', '/watch 12845');
    const reply = await ctx.run('999', '/watch 12845');

    expect(reply).toContain('already watching');
    expect(ctx.repo.listByChat('999')).toHaveLength(1);
  });

  it('reports an index that does not exist', async () => {
    expect(await ctx.run('999', '/watch 99999')).toContain('No section with index');
  });

  it('refuses junk arguments', async () => {
    expect(await ctx.run('999', '/watch calculus')).toContain('not a 5-digit index');
    expect(ctx.repo.listByChat('999')).toHaveLength(0);
  });
});

describe('/stop', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.repo.close());

  it('stops one watch by index', async () => {
    await ctx.run('999', '/watch 12845');
    const reply = await ctx.run('999', '/stop 12845');

    expect(reply).toContain('Stopped watching');
    expect(ctx.repo.listByChat('999')).toHaveLength(0);
  });

  it('stops everything with "all"', async () => {
    await ctx.run('999', '/watch 12845');
    const reply = await ctx.run('999', '/stop all');

    expect(reply).toContain('Stopped all 1');
    expect(ctx.repo.listByChat('999')).toHaveLength(0);
  });

  it('says so when there is nothing to stop', async () => {
    expect(await ctx.run('999', '/stop 12845')).toContain('not watching');
  });
});

describe('ownership boundary', () => {
  it('cannot stop another chat\'s watch, by index or by "all"', async () => {
    const ctx = setup();
    await ctx.run('777', '/watch 12845');
    expect(ctx.repo.listByChat('777')).toHaveLength(1);

    expect(await ctx.run('999', '/stop 12845')).toContain('not watching');
    await ctx.run('999', '/stop all');

    expect(ctx.repo.listByChat('777')).toHaveLength(1); // untouched
    ctx.repo.close();
  });

  it('only lists the sender\'s own watches', async () => {
    const ctx = setup();
    await ctx.run('777', '/watch 12845');

    expect(await ctx.run('999', '/list')).toContain('not watching any');
    expect(await ctx.run('777', '/list')).toContain('12845');
    ctx.repo.close();
  });
});

describe('read-only and reporting commands', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.repo.close());

  it('/check creates nothing', async () => {
    const reply = await ctx.run('999', '/check 12845');

    expect(reply).toContain('Closed');
    expect(reply).toContain('nothing is being watched');
    expect(ctx.repo.listAll({ includeInactive: true })).toHaveLength(0);
  });

  it('/status reports a live open section', async () => {
    await ctx.run('999', '/watch 12845');
    ctx.client.open = new Set(['12845']);

    expect(await ctx.run('999', '/status')).toContain('🟢');
  });

  it('/status degrades gracefully when Rutgers is unreachable', async () => {
    await ctx.run('999', '/watch 12845');
    ctx.client.failOpen = true;

    const reply = await ctx.run('999', '/status');
    expect(reply).toContain('Could not reach Rutgers');
  });

  it('/pending reflects an outstanding question', async () => {
    await ctx.run('999', '/watch 12845');
    expect(await ctx.run('999', '/pending')).toContain('Nothing is waiting');

    const w = ctx.repo.listByChat('999')[0];
    ctx.repo.markNotified(w.id, 1);
    ctx.repo.markFollowupSent(w.id);

    expect(await ctx.run('999', '/pending')).toContain('12845');
  });
});

describe('failure handling', () => {
  it('turns an unexpected error into a message instead of crashing the loop', async () => {
    const ctx = setup();
    ctx.client.getSectionByIndex = async () => {
      throw new Error('boom');
    };

    const reply = await ctx.run('999', '/watch 12845');

    expect(reply).toContain('Something went wrong');
    expect(reply).toContain('boom');
    ctx.repo.close();
  });
});

describe('term and campus overrides', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.repo.close());

  it('defaults to the configured term when none is given', async () => {
    await ctx.run('999', '/watch 12845');

    expect(ctx.client.askedTerms[0]).toEqual(term);
    expect(ctx.repo.listByChat('999')[0]).toMatchObject({
      year: 2026,
      term: 'fall',
      campus: 'NB',
    });
  });

  it('asks Rutgers about the requested term, and stores the watch under it', async () => {
    await ctx.run('999', '/watch 12845 spring 2027 NK');

    expect(ctx.client.askedTerms[0]).toEqual({ year: 2027, term: 'spring', campus: 'NK' });
    expect(ctx.repo.listByChat('999')[0]).toMatchObject({
      year: 2027,
      term: 'spring',
      campus: 'NK',
    });
  });

  it('lets the same index be watched in two different terms', async () => {
    await ctx.run('999', '/watch 12845');
    await ctx.run('999', '/watch 12845 spring');

    expect(ctx.repo.listByChat('999')).toHaveLength(2);
  });

  it('/check honours the override without creating anything', async () => {
    await ctx.run('999', '/check 12845 summer');

    expect(ctx.client.askedTerms[0]).toMatchObject({ term: 'summer' });
    expect(ctx.repo.listAll({ includeInactive: true })).toHaveLength(0);
  });

  it('/stop targets the requested term first', async () => {
    await ctx.run('999', '/watch 12845 spring');
    await ctx.run('999', '/stop 12845 spring');

    expect(ctx.repo.listByChat('999')).toHaveLength(0);
  });

  it('/stop still finds a watch when the term is left off', async () => {
    await ctx.run('999', '/watch 12845 spring');
    await ctx.run('999', '/stop 12845');

    expect(ctx.repo.listByChat('999')).toHaveLength(0);
  });
});

/**
 * The heart of the system: closed -> open transition detection, anti-spam
 * behaviour, request grouping, and resilience to failures.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { WatchRepository } from '../src/db/watch-repo.js';
import { MonitorService } from '../src/worker/monitor.js';
import { NullNotifier } from '../src/telegram/client.js';
import { RutgersSocClient } from '../src/rutgers/soc-client.js';

const term = { year: 2026, term: 'fall' as const, campus: 'NB' as const };

function baseWatch(overrides = {}) {
  return {
    indexNumber: '12845',
    courseCode: '01:640:135',
    courseTitle: 'CALCULUS I',
    sectionNumber: '01',
    instructors: 'Banerjee',
    chatId: '123456789',
    ...term,
    ...overrides,
  };
}

/** A fake client whose open-set we control between cycles. */
class FakeClient {
  openIndexes = new Set<string>();
  failNext = 0;
  calls = 0;
  requestedTerms: string[] = [];

  async fetchOpenIndexes(t: typeof term): Promise<Set<string>> {
    this.calls++;
    this.requestedTerms.push(`${t.year}:${t.term}:${t.campus}`);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Rutgers is down');
    }
    return new Set(this.openIndexes);
  }

  async getSectionByIndex() {
    return null;
  }
}

function setup(options: {
  now?: () => Date;
  repeatAlertMinutes?: number;
  failureAlertAfterMinutes?: number;
  followupAfterMinutes?: number;
} = {}) {
  // The repository must share the monitor's clock, otherwise timestamps it
  // writes (openedAt) are on a different timeline than the monitor reads.
  const repo = new WatchRepository(':memory:', { now: options.now });
  const client = new FakeClient();
  const notifier = new NullNotifier();
  const monitor = new MonitorService({
    repo,
    client: client as unknown as RutgersSocClient,
    notifier,
    now: options.now,
    repeatAlertMinutes: options.repeatAlertMinutes ?? 0,
    failureAlertAfterMinutes: options.failureAlertAfterMinutes ?? 15,
    followupAfterMinutes: options.followupAfterMinutes ?? 0,
  });
  return { repo, client, notifier, monitor };
}

describe('closed -> open transition detection', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.repo.close());

  it('does not notify while a section stays closed', async () => {
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set();

    const result = await ctx.monitor.runOnce();
    expect(result.checked).toBe(1);
    expect(result.opened).toBe(0);
    expect(ctx.notifier.sent).toHaveLength(0);
  });

  it('notifies exactly once when the section opens', async () => {
    const watch = ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.openIndexes = new Set(['12845']);
    const result = await ctx.monitor.runOnce();

    expect(result.opened).toBe(1);
    expect(ctx.notifier.sent).toHaveLength(1);
    expect(ctx.notifier.sent[0].chatId).toBe('123456789');
    expect(ctx.notifier.sent[0].text).toContain('Rutgers section opened');
    expect(ctx.notifier.sent[0].text).toContain('12845');
    expect(ctx.notifier.sent[0].text).toContain('Open WebReg and register manually now.');

    const after = ctx.repo.getById(watch.id)!;
    expect(after.lastStatus).toBe('open');
    expect(after.lastNotifiedAt).toBeTruthy();
  });

  it('does NOT re-notify while the section remains open', async () => {
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    await ctx.monitor.runOnce();
    await ctx.monitor.runOnce();

    expect(ctx.notifier.sent).toHaveLength(1);
  });

  it('keeps monitoring after an alert and alerts again on a NEW transition', async () => {
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.openIndexes = new Set(['12845']);
    await ctx.monitor.runOnce(); // opens -> alert 1

    ctx.client.openIndexes = new Set(); // fills up again
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1);

    ctx.client.openIndexes = new Set(['12845']); // opens again -> alert 2
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(2);
  });

  it('alerts on the first check when status was still unknown', async () => {
    ctx.repo.create(baseWatch()); // lastStatus = 'unknown'
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1);
  });

  it('does not alert for a watch that was already open when created', async () => {
    ctx.repo.create(baseWatch({ initialStatus: 'open' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(0);
  });

  it('ignores watches that were stopped', async () => {
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.repo.deactivate('123456789', '12845', term);
    ctx.client.openIndexes = new Set(['12845']);

    const result = await ctx.monitor.runOnce();
    expect(result.checked).toBe(0);
    expect(ctx.notifier.sent).toHaveLength(0);
  });

  it('routes each alert to the right chat', async () => {
    ctx.repo.create(baseWatch({ chatId: '111', initialStatus: 'closed' }));
    ctx.repo.create(baseWatch({ chatId: '222', initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent.map((m) => m.chatId).sort()).toEqual(['111', '222']);
  });
});

describe('request grouping', () => {
  it('makes ONE request per term no matter how many sections are watched', async () => {
    const ctx = setup();
    for (const index of ['12845', '12846', '12847', '12848', '12849']) {
      ctx.repo.create(baseWatch({ indexNumber: index, initialStatus: 'closed' }));
    }

    const result = await ctx.monitor.runOnce();

    expect(result.checked).toBe(5);
    expect(result.groups).toBe(1);
    expect(ctx.client.calls).toBe(1); // <- the whole point
    ctx.repo.close();
  });

  it('makes one request per distinct term', async () => {
    const ctx = setup();
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.repo.create(baseWatch({ term: 'spring', initialStatus: 'closed' }));
    ctx.repo.create(baseWatch({ campus: 'NK', initialStatus: 'closed' }));

    const result = await ctx.monitor.runOnce();
    expect(result.groups).toBe(3);
    expect(ctx.client.calls).toBe(3);
    expect(ctx.client.requestedTerms.sort()).toEqual(['2026:fall:NB', '2026:fall:NK', '2026:spring:NB']);
    ctx.repo.close();
  });

  it('makes no request at all when nothing is being watched', async () => {
    const ctx = setup();
    const result = await ctx.monitor.runOnce();
    expect(result.checked).toBe(0);
    expect(ctx.client.calls).toBe(0);
    ctx.repo.close();
  });
});

describe('resilience', () => {
  it('does not crash or notify when Rutgers fails, and recovers next cycle', async () => {
    const ctx = setup();
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.failNext = 1;
    const failed = await ctx.monitor.runOnce();
    expect(failed.errors).toBe(1);
    expect(failed.checked).toBe(0);
    expect(ctx.notifier.sent).toHaveLength(0);
    expect(ctx.monitor.state.consecutiveFailures).toBe(1);

    ctx.client.openIndexes = new Set(['12845']);
    const ok = await ctx.monitor.runOnce();
    expect(ok.opened).toBe(1);
    expect(ctx.monitor.state.consecutiveFailures).toBe(0);
    ctx.repo.close();
  });

  it('keeps checking other terms when one term fails', async () => {
    const repo = new WatchRepository(':memory:');
    const notifier = new NullNotifier();
    let call = 0;
    const client = {
      async fetchOpenIndexes(t: typeof term) {
        call++;
        if (t.term === 'fall') throw new Error('down');
        return new Set(['12846']);
      },
      async getSectionByIndex() {
        return null;
      },
    };
    const monitor = new MonitorService({
      repo,
      client: client as unknown as RutgersSocClient,
      notifier,
    });

    repo.create(baseWatch({ initialStatus: 'closed' }));
    repo.create(baseWatch({ indexNumber: '12846', term: 'spring', initialStatus: 'closed' }));

    const result = await monitor.runOnce();
    expect(call).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.checked).toBe(1);
    expect(notifier.sent).toHaveLength(1); // the spring section still alerted
    repo.close();
  });

  it('sends a failure alert only after the outage threshold, and only once', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), failureAlertAfterMinutes: 15 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.failNext = 99;

    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(0); // too early

    clock += 10 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(0); // still under 15 minutes

    clock += 6 * 60_000; // now 16 minutes of failure
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1);
    expect(ctx.notifier.sent[0].text).toContain('having trouble');

    clock += 60 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1); // no repeat spam
    ctx.repo.close();
  });

  it('sends a recovery message after a sustained outage ends', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), failureAlertAfterMinutes: 1 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.failNext = 99;
    await ctx.monitor.runOnce();
    clock += 2 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1);

    ctx.client.failNext = 0;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(2);
    expect(ctx.notifier.sent[1].text).toContain('recovered');
    ctx.repo.close();
  });

  it('still marks the watch checked when Telegram delivery fails', async () => {
    const repo = new WatchRepository(':memory:');
    const failing = {
      enabled: true,
      sendMessage: vi.fn(async () => ({ ok: false, error: 'chat not found' })),
    };
    const client = new FakeClient();
    client.openIndexes = new Set(['12845']);
    const monitor = new MonitorService({
      repo,
      client: client as unknown as RutgersSocClient,
      notifier: failing,
    });

    const watch = repo.create(baseWatch({ initialStatus: 'closed' }));
    await monitor.runOnce();

    const after = repo.getById(watch.id)!;
    expect(after.lastStatus).toBe('open'); // status still recorded
    expect(after.lastNotifiedAt).toBeNull(); // but not marked as notified
    repo.close();
  });
});

describe('"did you get in?" follow-up', () => {
  it('is disabled when FOLLOWUP_AFTER_MINUTES is 0', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), followupAfterMinutes: 0 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    clock += 24 * 60 * 60_000;
    await ctx.monitor.runOnce();

    expect(ctx.notifier.sent).toHaveLength(1); // just the open alert
    ctx.repo.close();
  });

  it('asks once, after the configured delay', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), followupAfterMinutes: 15 });
    const watch = ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1);

    clock += 10 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1); // not due yet

    clock += 6 * 60_000; // 16 minutes since the alert
    const due = await ctx.monitor.runOnce();
    expect(due.followups).toBe(1);
    expect(ctx.notifier.sent).toHaveLength(2);
    expect(ctx.notifier.sent[1].text).toContain('Did you get in?');
    expect(ctx.notifier.sent[1].text).toContain('12845');

    clock += 60 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(2); // asked once, not repeatedly

    const after = ctx.repo.getById(watch.id)!;
    expect(after.followupSentAt).toBeTruthy();
    expect(after.outcome).toBeNull();
    ctx.repo.close();
  });

  it('still asks after the section has closed again', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), followupAfterMinutes: 15 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.openIndexes = new Set(['12845']);
    await ctx.monitor.runOnce(); // alert

    ctx.client.openIndexes = new Set(); // someone took it — maybe them
    clock += 20 * 60_000;
    await ctx.monitor.runOnce();

    expect(ctx.notifier.sent).toHaveLength(2);
    expect(ctx.notifier.sent[1].text).toContain('Did you get in?');
    expect(ctx.notifier.sent[1].text).toContain('closed again');
    ctx.repo.close();
  });

  it('never asks about an alert that failed to deliver', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const repo = new WatchRepository(':memory:', { now: () => new Date(clock) });
    const failing = {
      enabled: true,
      sendMessage: vi.fn(async () => ({ ok: false as const, error: 'chat not found' })),
    };
    const client = new FakeClient();
    client.openIndexes = new Set(['12845']);
    const monitor = new MonitorService({
      repo,
      client: client as unknown as RutgersSocClient,
      notifier: failing,
      now: () => new Date(clock),
      followupAfterMinutes: 15,
    });

    const watch = repo.create(baseWatch({ initialStatus: 'closed' }));
    await monitor.runOnce();

    clock += 60 * 60_000;
    const result = await monitor.runOnce();

    expect(result.followups).toBe(0);
    expect(repo.getById(watch.id)!.followupDueAt).toBeNull();
    repo.close();
  });

  it('asks again after a NEW opening, clearing the previous answer', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), followupAfterMinutes: 15 });
    const watch = ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.openIndexes = new Set(['12845']);
    await ctx.monitor.runOnce();
    clock += 20 * 60_000;
    await ctx.monitor.runOnce(); // asked
    ctx.repo.recordOutcome(watch.id, 'missed'); // they did not get in
    expect(ctx.notifier.sent).toHaveLength(2);

    ctx.client.openIndexes = new Set(); // closes
    await ctx.monitor.runOnce();
    ctx.client.openIndexes = new Set(['12845']); // opens again
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(3); // second open alert

    const reset = ctx.repo.getById(watch.id)!;
    expect(reset.outcome).toBeNull();
    expect(reset.followupSentAt).toBeNull();

    clock += 20 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(4);
    expect(ctx.notifier.sent[3].text).toContain('Did you get in?');
    ctx.repo.close();
  });

  it('goes out even on a cycle where Rutgers is unreachable', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), followupAfterMinutes: 15 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));

    ctx.client.openIndexes = new Set(['12845']);
    await ctx.monitor.runOnce();

    clock += 20 * 60_000;
    ctx.client.failNext = 1;
    const result = await ctx.monitor.runOnce();

    expect(result.errors).toBe(1);
    expect(result.followups).toBe(1);
    expect(ctx.notifier.sent[1].text).toContain('Did you get in?');
    ctx.repo.close();
  });
});

describe('repeat alerts while a section stays open', () => {
  it('is disabled when the interval is 0', async () => {
    const ctx = setup({ repeatAlertMinutes: 0 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    for (let i = 0; i < 5; i++) await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1);
    ctx.repo.close();
  });

  it('keeps re-alerting every interval for as long as it stays open', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), repeatAlertMinutes: 5 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce(); // initial alert
    expect(ctx.notifier.sent).toHaveLength(1);

    clock += 3 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(1); // too early

    // Three successive 5-minute intervals should each produce one more ping,
    // which is the whole point: it does not stop after the first.
    for (let expected = 2; expected <= 4; expected++) {
      clock += 5 * 60_000;
      await ctx.monitor.runOnce();
      expect(ctx.notifier.sent).toHaveLength(expected);
      expect(ctx.notifier.sent[expected - 1].text).toContain('Still open');
    }

    expect(ctx.notifier.sent[1].text).toContain('reminder #1');
    expect(ctx.notifier.sent[3].text).toContain('reminder #3');
    ctx.repo.close();
  });

  it('stops repeating once the section closes again', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), repeatAlertMinutes: 5 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    clock += 5 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(2);

    // It filled up. Insisting "still open" now would just be false.
    ctx.client.openIndexes = new Set();
    for (let i = 0; i < 4; i++) {
      clock += 5 * 60_000;
      await ctx.monitor.runOnce();
    }
    expect(ctx.notifier.sent).toHaveLength(2);
    ctx.repo.close();
  });

  it('stops repeating once the watcher confirms they registered', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), repeatAlertMinutes: 5 });
    const watch = ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    clock += 5 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(2);

    // "yes" — registered deactivates the watch, so it leaves listActive().
    ctx.repo.recordOutcome(watch.id, 'registered');

    for (let i = 0; i < 4; i++) {
      clock += 5 * 60_000;
      await ctx.monitor.runOnce();
    }
    expect(ctx.notifier.sent).toHaveLength(2);
    ctx.repo.close();
  });

  it('restarts the repeat clock on a brand new opening', async () => {
    let clock = new Date('2026-08-01T00:00:00Z').getTime();
    const ctx = setup({ now: () => new Date(clock), repeatAlertMinutes: 5 });
    ctx.repo.create(baseWatch({ initialStatus: 'closed' }));
    ctx.client.openIndexes = new Set(['12845']);

    await ctx.monitor.runOnce();
    clock += 5 * 60_000;
    await ctx.monitor.runOnce(); // repeat #1
    expect(ctx.notifier.sent).toHaveLength(2);

    ctx.client.openIndexes = new Set();
    clock += 60 * 60_000;
    await ctx.monitor.runOnce(); // closed for an hour

    ctx.client.openIndexes = new Set(['12845']);
    await ctx.monitor.runOnce(); // opens again -> fresh alert
    expect(ctx.notifier.sent).toHaveLength(3);

    // The stale reminder timestamp from the previous opening must not make the
    // next repeat fire instantly.
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(3);

    clock += 5 * 60_000;
    await ctx.monitor.runOnce();
    expect(ctx.notifier.sent).toHaveLength(4);
    expect(ctx.notifier.sent[3].text).toContain('reminder #1');
    ctx.repo.close();
  });
});

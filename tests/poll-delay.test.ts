/**
 * Adaptive poll cadence.
 *
 * The point is that a sustained Rutgers outage is met with *less* traffic, not
 * the same amount — while a healthy poller is completely unaffected.
 */
import { describe, expect, it } from 'vitest';
import { nextPollDelayMs, pollDelaySeconds } from '../src/worker/poll-delay.js';
import { isWorkerAlive, type Heartbeat } from '../src/worker/heartbeat.js';

const base = {
  baseSeconds: 30,
  jitterSeconds: 0,
  maxSeconds: 600,
  random: () => 0,
};

describe('healthy cadence', () => {
  it('polls at the configured interval when nothing is failing', () => {
    expect(nextPollDelayMs({ ...base, consecutiveFailures: 0 })).toBe(30_000);
  });

  it('adds jitter up to the configured maximum', () => {
    expect(
      nextPollDelayMs({ ...base, jitterSeconds: 5, consecutiveFailures: 0, random: () => 0.999 }),
    ).toBe(30_000 + 4995);
    expect(
      nextPollDelayMs({ ...base, jitterSeconds: 5, consecutiveFailures: 0, random: () => 0 }),
    ).toBe(30_000);
  });

  it('treats a negative failure count as healthy', () => {
    expect(nextPollDelayMs({ ...base, consecutiveFailures: -1 })).toBe(30_000);
  });
});

describe('backing off', () => {
  it('doubles the interval per consecutive failure', () => {
    expect(nextPollDelayMs({ ...base, consecutiveFailures: 1 })).toBe(60_000);
    expect(nextPollDelayMs({ ...base, consecutiveFailures: 2 })).toBe(120_000);
    expect(nextPollDelayMs({ ...base, consecutiveFailures: 3 })).toBe(240_000);
    expect(nextPollDelayMs({ ...base, consecutiveFailures: 4 })).toBe(480_000);
  });

  it('never exceeds the ceiling, however long the outage runs', () => {
    for (const failures of [5, 10, 50, 1000]) {
      expect(nextPollDelayMs({ ...base, consecutiveFailures: failures })).toBe(600_000);
    }
  });

  it('does not overflow on an absurd failure count', () => {
    const delay = nextPollDelayMs({ ...base, consecutiveFailures: 5000 });
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(600_000);
  });

  it('snaps straight back to normal on the first success', () => {
    expect(nextPollDelayMs({ ...base, consecutiveFailures: 8 })).toBe(600_000);
    expect(nextPollDelayMs({ ...base, consecutiveFailures: 0 })).toBe(30_000);
  });

  it('still adds jitter while backed off, so retries do not synchronise', () => {
    const delay = nextPollDelayMs({
      ...base,
      jitterSeconds: 5,
      consecutiveFailures: 2,
      random: () => 0.5,
    });
    expect(delay).toBe(120_000 + 2500);
  });
});

describe('misconfiguration', () => {
  it('never polls faster than the base interval when the ceiling is too low', () => {
    expect(nextPollDelayMs({ ...base, maxSeconds: 5, consecutiveFailures: 3 })).toBe(30_000);
  });

  it('handles a zero jitter setting', () => {
    expect(
      nextPollDelayMs({ ...base, jitterSeconds: 0, consecutiveFailures: 0, random: () => 0.9 }),
    ).toBe(30_000);
  });
});

describe('pollDelaySeconds', () => {
  it('reports the interval without jitter, for status and logs', () => {
    expect(pollDelaySeconds({ ...base, consecutiveFailures: 0 })).toBe(30);
    expect(pollDelaySeconds({ ...base, consecutiveFailures: 3 })).toBe(240);
    expect(pollDelaySeconds({ ...base, consecutiveFailures: 99 })).toBe(600);
  });
});

describe('liveness while backed off', () => {
  function beat(overrides: Partial<Heartbeat> = {}): Heartbeat {
    return {
      pid: process.pid,
      updatedAt: new Date('2026-08-01T00:00:00Z').toISOString(),
      lastPollAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
      pollIntervalSeconds: 30,
      ...overrides,
    };
  }

  it('does NOT call a backed-off worker dead', () => {
    // 5 minutes since the last beat: stale against a 30s cadence, healthy
    // against the 10-minute one actually in effect.
    const now = new Date('2026-08-01T00:05:00Z');

    expect(isWorkerAlive(beat(), now)).toBe(false);
    expect(isWorkerAlive(beat({ currentPollIntervalSeconds: 600 }), now)).toBe(true);
  });

  it('still calls a genuinely dead worker dead, even when backed off', () => {
    const now = new Date('2026-08-01T01:00:00Z'); // an hour later
    expect(isWorkerAlive(beat({ currentPollIntervalSeconds: 600 }), now)).toBe(false);
  });

  it('falls back to the healthy interval when the field is absent', () => {
    const now = new Date('2026-08-01T00:00:30Z');
    expect(isWorkerAlive(beat(), now)).toBe(true);
  });
});

/**
 * How long to wait before the next poll.
 *
 * Retries inside a single request (see `getJson` in the SOC client) handle a
 * blip. They do NOT handle Rutgers being unhappy with us for a sustained
 * stretch: without this, a 429 storm would still be met with a request every 30
 * seconds forever, which is both rude and the worst way to get un-rate-limited.
 *
 * So the cadence itself stretches while we are failing, and snaps back to
 * normal on the first success.
 *
 * Pure function, injectable randomness — the whole schedule is testable without
 * waiting in real time.
 */

export interface PollDelayOptions {
  /** The healthy interval, POLL_INTERVAL_SECONDS. */
  baseSeconds: number;
  /** Random extra delay so requests are not perfectly periodic. */
  jitterSeconds: number;
  /** Ceiling for the backed-off interval, MAX_POLL_INTERVAL_SECONDS. */
  maxSeconds: number;
  /** From MonitorState; 0 means healthy. */
  consecutiveFailures: number;
  random?: () => number;
}

/**
 * Doubling per consecutive failure: 30s → 60 → 120 → 240 … up to the ceiling.
 *
 * Note this also delays the "did you get in?" question during a Rutgers outage,
 * by at most one interval. That is an acceptable trade for not hammering a
 * service that is already struggling.
 */
export function nextPollDelayMs(options: PollDelayOptions): number {
  const { baseSeconds, jitterSeconds, consecutiveFailures } = options;
  const random = options.random ?? Math.random;

  // A ceiling below the base interval is a misconfiguration, not an instruction
  // to poll faster than normal.
  const maxSeconds = Math.max(options.maxSeconds, baseSeconds);

  const seconds =
    consecutiveFailures <= 0
      ? baseSeconds
      : Math.min(baseSeconds * 2 ** consecutiveFailures, maxSeconds);

  const jitterMs = Math.floor(random() * Math.max(0, jitterSeconds) * 1000);
  return seconds * 1000 + jitterMs;
}

/** The interval a delay corresponds to, ignoring jitter — for logs and status. */
export function pollDelaySeconds(options: Omit<PollDelayOptions, 'random'>): number {
  return Math.round(nextPollDelayMs({ ...options, jitterSeconds: 0, random: () => 0 }) / 1000);
}

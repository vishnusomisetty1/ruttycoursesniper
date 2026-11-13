/**
 * A "heartbeat" file the worker rewrites after every poll.
 *
 * The CLI is a separate short-lived process, so it cannot ask the worker
 * anything directly. Instead the worker leaves this small JSON file next to the
 * database, and `npm run cli -- status` reads it to answer "is the monitor
 * actually running?".
 *
 * A heartbeat is considered stale if it has not been updated recently, which
 * also covers the case where the worker was killed without cleaning up.
 */
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CycleResult } from './monitor.js';

export interface Heartbeat {
  pid: number;
  updatedAt: string;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  pollIntervalSeconds: number;
  /**
   * The interval currently in effect. Equals `pollIntervalSeconds` when healthy
   * and grows while the poller is backing off after failures.
   */
  currentPollIntervalSeconds?: number;
  lastCycle?: CycleResult;
}

export function heartbeatPath(databasePath: string): string {
  return resolve(databasePath) + '.heartbeat.json';
}

export function writeHeartbeat(databasePath: string, beat: Heartbeat): void {
  const path = heartbeatPath(databasePath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(beat, null, 2));
  } catch {
    // A heartbeat is a nicety; never let it take the worker down.
  }
}

export function readHeartbeat(databasePath: string): Heartbeat | null {
  const path = heartbeatPath(databasePath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Heartbeat;
  } catch {
    return null;
  }
}

export function removeHeartbeat(databasePath: string): void {
  try {
    rmSync(heartbeatPath(databasePath), { force: true });
  } catch {
    /* ignore */
  }
}

/** Is the process behind this heartbeat still alive and ticking? */
export function isWorkerAlive(beat: Heartbeat | null, now = new Date()): boolean {
  if (!beat) return false;

  // Allow three missed cycles before declaring it dead. This must follow the
  // interval ACTUALLY in effect: a worker backing off to 10 minutes is healthy,
  // and judging it against the 30s healthy interval would call it dead.
  const effectiveInterval = beat.currentPollIntervalSeconds ?? beat.pollIntervalSeconds;
  const staleAfterMs = Math.max(60, effectiveInterval * 3) * 1000;
  const age = now.getTime() - new Date(beat.updatedAt).getTime();
  if (Number.isNaN(age) || age > staleAfterMs) return false;

  // Signal 0 does not kill anything; it just tests whether the pid exists.
  try {
    process.kill(beat.pid, 0);
    return true;
  } catch {
    return false;
  }
}

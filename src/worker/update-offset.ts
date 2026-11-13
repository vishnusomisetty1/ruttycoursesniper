/**
 * Remembers the last Telegram update we acknowledged.
 *
 * Telegram keeps redelivering an update until you ask for a higher offset, so
 * without this a restart would replay the last batch and answer the same
 * question twice. Stored next to the database, like the heartbeat.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function offsetPath(databasePath: string): string {
  return resolve(databasePath) + '.updates.json';
}

export function readUpdateOffset(databasePath: string): number | null {
  const path = offsetPath(databasePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { offset?: unknown };
    return typeof parsed.offset === 'number' ? parsed.offset : null;
  } catch {
    // A corrupt file just means we start from whatever Telegram still holds.
    return null;
  }
}

export function writeUpdateOffset(databasePath: string, offset: number): void {
  const path = offsetPath(databasePath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    // Losing the offset costs us one replayed message, not correctness.
  }
}

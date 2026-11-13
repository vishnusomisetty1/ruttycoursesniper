/**
 * Configuration loader.
 *
 * Everything the program needs to know that is NOT code lives in environment
 * variables (usually loaded from a `.env` file). We validate them with Zod so
 * that a typo like POLL_INTERVAL_SECONDS=abc fails loudly at startup instead of
 * causing a weird bug an hour later.
 */
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAMPUS_CODES, TERM_NAMES } from './rutgers/terms.js';

/** Minimal .env parser so we don't need an extra dependency. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Load .env into process.env without clobbering already-set real env vars. */
export function loadDotEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const parsed = parseDotEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/**
 * A Telegram chat id is an integer, but group/channel ids are negative and can
 * exceed 32 bits, so we keep it as a validated string.
 */
export const chatIdSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/, 'Telegram chat id must be an integer (e.g. 123456789 or -1001234567890)');

const optionalNonEmpty = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: optionalNonEmpty,
  DEFAULT_TELEGRAM_CHAT_ID: optionalNonEmpty.pipe(chatIdSchema.optional()),
  RUTGERS_CAMPUS: z.enum(CAMPUS_CODES).default('NB'),
  RUTGERS_YEAR: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
  RUTGERS_TERM: z.enum(TERM_NAMES).default('fall'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(30),
  POLL_JITTER_SECONDS: z.coerce.number().int().min(0).max(120).default(5),
  /**
   * Ceiling for the poll interval while Rutgers is failing. The interval
   * doubles per consecutive failed cycle up to this, then snaps back to
   * POLL_INTERVAL_SECONDS on the first success.
   */
  MAX_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(600),
  /**
   * Keep re-alerting every this many minutes while a section is still open and
   * you have not confirmed you registered. 0 disables repeats, leaving exactly
   * one alert per opening.
   *
   * This replaces the old single-shot REMINDER_AFTER_MINUTES: a repeat that
   * fires once is just this with a longer interval, and running both would mean
   * two "still open" messages from two different code paths.
   */
  REPEAT_ALERT_MINUTES: z.coerce.number().int().min(0).max(10080).default(5),
  /**
   * Ask "did you get in?" this long after an open alert was delivered.
   * 0 disables the follow-up entirely.
   */
  FOLLOWUP_AFTER_MINUTES: z.coerce.number().int().min(0).max(10080).default(15),
  /** Warn over Telegram once the poller has failed continuously for this long. */
  FAILURE_ALERT_AFTER_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  /**
   * Listen for a yes/no answer to the follow-up question on this bot's own
   * inbox. Off unless explicitly enabled — reading messages should be a choice.
   */
  REPLY_LISTENER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Chat ids allowed to answer, comma-separated. Empty means "any chat that
   * already has a watch here", which is self-limiting.
   */
  REPLY_ALLOWED_CHAT_IDS: optionalNonEmpty.transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  DATABASE_PATH: z.string().trim().min(1).default('./data/rutgers-sniper.sqlite'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** How long the (large) course catalog response stays cached in memory. */
  CATALOG_CACHE_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  SOC_BASE_URL: z.string().url().default('https://classes.rutgers.edu/soc/api'),
  TELEGRAM_API_BASE_URL: z.string().url().default('https://api.telegram.org'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

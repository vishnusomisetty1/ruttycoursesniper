/**
 * A tiny structured logger.
 *
 * "Structured" means each line is JSON instead of free-form prose, which makes
 * logs greppable and machine-readable. It also redacts anything that looks like
 * a secret so a bot token can never end up in a log file.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always replaced with [REDACTED]. */
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|apikey|api_key|authorization|credential)/i;

/**
 * Telegram bot tokens look like 123456789:AAH<35 more chars>.
 *
 * Deliberately NOT anchored with \b at the start: a token most often leaks
 * inside a URL like ".../bot123456789:AAH...", where the digits follow a letter
 * and there is therefore no word boundary to match.
 */
const TELEGRAM_TOKEN_PATTERN = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;

export function redactString(input: string): string {
  return input.replace(TELEGRAM_TOKEN_PATTERN, '[REDACTED_TOKEN]');
}

/** Recursively strip secrets out of a value before it is written to a log. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v, seen);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injectable sink makes the logger testable and keeps stdout clean for CLI output. */
  sink?: (line: string) => void;
  bindings?: Record<string, unknown>;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const bindings = options.bindings ?? {};
  const now = options.now ?? (() => new Date());

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
    const record = {
      time: now().toISOString(),
      level: lvl,
      msg: redactString(msg),
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** Used by the CLI, which prints human output to stdout and logs to stderr. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

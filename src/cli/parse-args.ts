/**
 * Strict command-line parsing.
 *
 * SECURITY NOTE: this parser is a trust boundary — arguments may be assembled
 * by a script rather than typed by hand. It is deliberately strict:
 *
 *   - only commands in COMMANDS are accepted
 *   - only flags declared for that command are accepted
 *   - every value is validated by Zod before it reaches SQLite or the network
 *   - nothing is ever passed to a shell, eval'd, or interpolated into a command
 *
 * Anything unrecognised is a hard error rather than a best guess.
 */
import { z } from 'zod';
import { chatIdSchema } from '../config.js';
import {
  campusSchema,
  courseCodeSchema,
  indexNumberSchema,
  parseTermName,
  termSchema,
  yearSchema,
} from '../rutgers/terms.js';

export const COMMANDS = [
  'watch-index',
  'watch-course',
  'list',
  'stop',
  'status',
  'check',
  'resolve',
  'pending',
  'help',
] as const;

export type CommandName = (typeof COMMANDS)[number];

/** Flags every command understands. */
const COMMON_FLAGS = ['year', 'term', 'campus', 'chat-id', 'json', 'help'] as const;

const COMMAND_FLAGS: Record<CommandName, readonly string[]> = {
  'watch-index': [...COMMON_FLAGS, 'notify'],
  'watch-course': [...COMMON_FLAGS, 'all', 'notify'],
  list: [...COMMON_FLAGS, 'all-chats', 'include-inactive'],
  stop: [...COMMON_FLAGS, 'all'],
  status: [...COMMON_FLAGS, 'all-chats', 'cached'],
  check: [...COMMON_FLAGS],
  resolve: [...COMMON_FLAGS, 'got-in', 'missed', 'notify'],
  pending: [...COMMON_FLAGS, 'all-chats'],
  help: [...COMMON_FLAGS],
};

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'all',
  'all-chats',
  'include-inactive',
  'notify',
  'got-in',
  'missed',
  'cached',
]);

export interface RawArgs {
  command: CommandName;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseRawArgs(argv: string[]): RawArgs {
  if (argv.length === 0) return { command: 'help', positionals: [], flags: {} };

  const [commandInput, ...rest] = argv;
  const command = commandInput.trim().toLowerCase();

  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new CliUsageError(
      `Unknown command "${commandInput}". Valid commands: ${COMMANDS.join(', ')}`,
    );
  }
  const cmd = command as CommandName;
  const allowed = new Set(COMMAND_FLAGS[cmd]);

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    // Support both "--year 2026" and "--year=2026".
    let name = token.slice(2);
    let inlineValue: string | undefined;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    name = name.trim().toLowerCase();

    if (!allowed.has(name)) {
      throw new CliUsageError(
        `Unknown option "--${name}" for command "${cmd}". Allowed: ${[...allowed].map((f) => `--${f}`).join(', ')}`,
      );
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined && !['true', 'false'].includes(inlineValue)) {
        throw new CliUsageError(`Option --${name} does not take a value.`);
      }
      flags[name] = inlineValue !== 'false';
      continue;
    }

    const value = inlineValue ?? rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliUsageError(`Option --${name} requires a value.`);
    }
    if (inlineValue === undefined) i++;
    flags[name] = value;
  }

  return { command: cmd, positionals, flags };
}

/** Term options, falling back to environment defaults. */
export interface TermDefaults {
  year: number;
  term: string;
  campus: string;
  chatId?: string;
}

const termOptionsSchema = z.object({
  year: yearSchema,
  term: termSchema,
  campus: campusSchema,
});

export function resolveTermOptions(flags: Record<string, string | boolean>, defaults: TermDefaults) {
  const rawTerm = typeof flags.term === 'string' ? flags.term : defaults.term;
  const normalizedTerm = parseTermName(rawTerm);
  if (!normalizedTerm) {
    throw new CliUsageError(
      `Invalid --term "${rawTerm}". Use one of: fall, spring, summer, winter.`,
    );
  }

  const parsed = termOptionsSchema.safeParse({
    year: typeof flags.year === 'string' ? flags.year : defaults.year,
    term: normalizedTerm,
    campus:
      typeof flags.campus === 'string' ? flags.campus.trim().toUpperCase() : defaults.campus,
  });

  if (!parsed.success) {
    throw new CliUsageError(
      parsed.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

export function resolveChatId(
  flags: Record<string, string | boolean>,
  defaults: TermDefaults,
  { required = true }: { required?: boolean } = {},
): string | undefined {
  const raw = typeof flags['chat-id'] === 'string' ? flags['chat-id'] : defaults.chatId;
  if (raw === undefined || raw === '') {
    if (!required) return undefined;
    throw new CliUsageError(
      'A Telegram chat id is required. Pass --chat-id 123456789 or set DEFAULT_TELEGRAM_CHAT_ID.',
    );
  }
  const parsed = chatIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUsageError(parsed.error.issues[0].message);
  }
  return parsed.data;
}

export function requireIndexNumber(positionals: string[], commandName: string): string {
  const raw = positionals[0];
  if (raw === undefined) {
    throw new CliUsageError(`${commandName} requires an index number, e.g. ${commandName} 12845`);
  }
  const parsed = indexNumberSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUsageError(`Invalid index number "${raw}": ${parsed.error.issues[0].message}`);
  }
  return parsed.data;
}

export function requireCourseCode(positionals: string[]) {
  const raw = positionals[0];
  if (raw === undefined) {
    throw new CliUsageError('watch-course requires a course code, e.g. watch-course 01:640:135');
  }
  const parsed = courseCodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUsageError(parsed.error.issues[0].message);
  }
  return parsed.data;
}

/**
 * `resolve` needs an unambiguous answer, so exactly one of --got-in / --missed
 * must be present. We never infer the answer from free text.
 */
export function requireOutcome(flags: Record<string, string | boolean>): 'registered' | 'missed' {
  const gotIn = flags['got-in'] === true;
  const missed = flags.missed === true;

  if (gotIn && missed) {
    throw new CliUsageError('Pass either --got-in or --missed, not both.');
  }
  if (!gotIn && !missed) {
    throw new CliUsageError(
      'resolve requires --got-in (you registered) or --missed (you did not).',
    );
  }
  return gotIn ? 'registered' : 'missed';
}

/**
 * `check` accepts either an index number or a course code, so we sniff which
 * one was given: five digits and nothing else means an index.
 */
export function parseCheckTarget(
  positionals: string[],
): { kind: 'index'; indexNumber: string } | { kind: 'course'; courseString: string } {
  const raw = positionals[0];
  if (raw === undefined) {
    throw new CliUsageError('check requires an index number or course code, e.g. check 12845');
  }
  if (/^\d{5}$/.test(raw.trim())) {
    return { kind: 'index', indexNumber: raw.trim() };
  }
  const parsed = courseCodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUsageError(
      `"${raw}" is neither a 5-digit index number nor a course code like 01:640:135.`,
    );
  }
  return { kind: 'course', courseString: parsed.data.courseString };
}

export const HELP_TEXT = `Rutgers course-opening notifier (notification only — never registers for you)

Usage: npm run cli -- <command> [options]

Commands:
  watch-index <index>        Watch one section by its 5-digit Rutgers index number
  watch-course <code>        Show all sections for a course code (e.g. 01:640:135)
  list                       List your active watches
  stop <index>               Stop watching an index ( --all stops everything )
  status                     Live status report: worker health + every watch, checked right now
  check <index|code>         One-off lookup. Adds no watch and sends no Telegram message.
  resolve <index>            Answer the "did you get in?" question (--got-in or --missed)
  pending                    List watches waiting on a "did you get in?" answer
  help                       Show this message

Options:
  --year <YYYY>              Default: RUTGERS_YEAR
  --term <fall|spring|summer|winter>   Default: RUTGERS_TERM
  --campus <NB|NK|CM>        NB=New Brunswick, NK=Newark, CM=Camden. Default: RUTGERS_CAMPUS
  --chat-id <id>             Telegram chat id. Default: DEFAULT_TELEGRAM_CHAT_ID
  --json                     Machine-readable output (for scripting)
  --notify                   Send a Telegram confirmation (watch-index, resolve)
  --all                      watch-course: watch every section. stop: stop every watch.
  --got-in / --missed        resolve: whether you actually registered
  --cached                   status: skip the live lookup and report last-polled status

Examples:
  npm run cli -- watch-index 12845 --year 2026 --term fall --campus NB --chat-id 123456789
  npm run cli -- watch-course 01:640:135 --year 2026 --term fall
  npm run cli -- list --chat-id 123456789
  npm run cli -- stop 12845 --chat-id 123456789
  npm run cli -- check 12845
  npm run cli -- status --chat-id 123456789
  npm run cli -- resolve 12845 --got-in --chat-id 123456789
  npm run cli -- pending --chat-id 123456789
`;

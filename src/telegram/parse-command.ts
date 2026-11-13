/**
 * Slash-command parsing for the Telegram bot.
 *
 * Same trust posture as the CLI parser: an allowlist of known verbs, one
 * validated argument, and nothing ever reaching a shell. A message that is not
 * a recognised command falls through to the yes/no answer path.
 */
import {
  CAMPUS_CODES,
  courseCodeSchema,
  indexNumberSchema,
  parseTermName,
  type CampusCode,
  type Term,
} from '../rutgers/terms.js';

export const BOT_COMMANDS = [
  'help',
  'list',
  'status',
  'watch',
  'stop',
  'check',
  'pending',
] as const;

export type BotCommandName = (typeof BOT_COMMANDS)[number];

/**
 * Alternative spellings, resolved to a canonical verb before anything else
 * sees them.
 *
 * Aliasing here rather than in the handler means there is still exactly one
 * implementation of each action — `/cancel 12845` and `/stop 12845` cannot
 * drift apart, because by the time the handler runs they are the same command.
 */
const COMMAND_ALIASES: Readonly<Record<string, BotCommandName>> = {
  cancel: 'stop',
};

export interface BotCommand {
  name: BotCommandName;
  /** Raw remainder of the message, already trimmed. */
  arg: string;
}

/**
 * Recognise `/verb args`.
 *
 * Telegram appends `@BotName` to commands in groups, so `/status@Ruclasssniperbot`
 * has to work too. Returns null for anything that is not a slash command.
 */
export function parseCommand(input: string): BotCommand | null {
  const text = input.trim();
  if (!text.startsWith('/')) return null;

  const [head, ...rest] = text.slice(1).split(/\s+/);
  const typed = head.split('@')[0].toLowerCase();
  const verb = COMMAND_ALIASES[typed] ?? typed;

  if (!(BOT_COMMANDS as readonly string[]).includes(verb)) return null;
  return { name: verb as BotCommandName, arg: rest.join(' ').trim() };
}

export type CommandTarget =
  | { kind: 'index'; indexNumber: string }
  | { kind: 'course'; courseString: string }
  | { kind: 'all' }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

/**
 * Interpret a command argument: a five-digit index, a course code, or `all`.
 * Never guesses — an unparseable argument comes back as `invalid`.
 *
 * The overloads keep `all` out of the result type unless the caller asked for
 * it, so a command that has no "all" meaning cannot forget to handle it.
 */
export function parseTarget(arg: string, options: { allowAll: true }): CommandTarget;
export function parseTarget(
  arg: string,
  options?: { allowAll?: false },
): Exclude<CommandTarget, { kind: 'all' }>;
export function parseTarget(arg: string, { allowAll = false } = {}): CommandTarget {
  const raw = arg.trim();
  if (!raw) return { kind: 'missing' };

  if (allowAll && raw.toLowerCase() === 'all') return { kind: 'all' };

  if (/^\d{5}$/.test(raw)) {
    const parsed = indexNumberSchema.safeParse(raw);
    if (parsed.success) return { kind: 'index', indexNumber: parsed.data };
  }

  const course = courseCodeSchema.safeParse(raw);
  if (course.success) return { kind: 'course', courseString: course.data.courseString };

  return {
    kind: 'invalid',
    reason: `"${raw}" is not a 5-digit index number or a course code like 01:640:135.`,
  };
}

export interface TargetAndTerm {
  /** What is left after the term words are removed. */
  target: string;
  term: Term;
  /** True when the message actually asked for a non-default term. */
  overridden: boolean;
}

/**
 * Pull term/campus/year words out of a command argument.
 *
 * `/watch 12845 spring 2027 NK` should mean what it looks like, in any order.
 * Anything unrecognised stays in `target` so the target parser can reject it —
 * this function never decides something is invalid, it only recognises.
 *
 * A four-digit number is a year and a five-digit one is an index, so those two
 * can never be confused.
 */
export function splitTargetAndTerm(arg: string, defaults: Term): TargetAndTerm {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let { year, term, campus } = defaults;
  let overridden = false;

  for (const token of tokens) {
    const named = parseTermName(token);
    if (named) {
      term = named;
      overridden = true;
      continue;
    }

    const upper = token.toUpperCase();
    if ((CAMPUS_CODES as readonly string[]).includes(upper)) {
      campus = upper as CampusCode;
      overridden = true;
      continue;
    }

    if (/^\d{4}$/.test(token)) {
      const value = Number(token);
      if (value >= 2000 && value <= 2100) {
        year = value;
        overridden = true;
        continue;
      }
    }

    rest.push(token);
  }

  return { target: rest.join(' '), term: { year, term, campus }, overridden };
}

export const HELP_MESSAGE = [
  '<b>Rutgers Course Sniper</b>',
  '',
  'I watch Rutgers sections and message you the moment one opens.',
  'I only notify — <b>you</b> register in WebReg yourself.',
  '',
  '<b>Commands</b>',
  '/watch <code>12845</code> — watch a section by index number',
  '/watch <code>01:640:135</code> — show a course\'s sections so you can pick',
  '/stop <code>12845</code> — stop watching (or /stop <code>all</code>)',
  '/cancel <code>12845</code> — same as /stop',
  '/list — what am I watching?',
  '/status — is the monitor alive, and is anything open right now?',
  '/check <code>12845</code> — look something up without watching it',
  '/pending — what am I waiting on an answer for?',
  '/help — this message',
  '',
  '<b>Other terms and campuses</b>',
  'Add them to any of the above, in any order:',
  '/watch <code>12845 spring</code> · /check <code>12845 2027 NK</code>',
  'Campuses: NB = New Brunswick, NK = Newark, CM = Camden.',
  'Leave them off and I use your defaults.',
  '',
  '<b>After a section opens</b>',
  "I'll keep reminding you while it stays open, until you tell me you're in.",
  'Reply <b>yes</b> once you have registered and I stop watching it.',
  'Reply <b>no</b> and I keep going.',
].join('\n');

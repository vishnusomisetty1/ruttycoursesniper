/**
 * Understanding a one-word answer to "did you get in?".
 *
 * This is deliberately NOT a chatbot and NOT an LLM. It recognises the handful
 * of ways a person actually answers a yes/no question in Telegram and refuses
 * to guess at anything else — a wrong guess here silently stops watching a
 * section someone still needs, which is the worst failure this project has.
 *
 * All pure functions, so every phrase below is covered by a test.
 */

export type ReplyIntent = 'yes' | 'no' | 'ambiguous' | 'unknown';

/** Lowercase, strip accents/emoji/punctuation, collapse whitespace. */
export function normalizeReply(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words that flip the meaning of what follows.
 *
 * Without this, "didn't get in" matches both a no pattern ("didn't") and a yes
 * pattern ("get in") and comes out ambiguous — so the person gets asked again
 * even though they answered perfectly clearly.
 */
const NEGATOR =
  "(?:didn't|didnt|did not|couldn't|couldnt|could not|wasn't|wasnt|was not|not|never|no)";

/** A yes phrase that means the opposite when negated. */
function unnegated(phrase: string): RegExp {
  return new RegExp(`(?<!\\b${NEGATOR}\\s)\\b(?:${phrase})\\b`);
}

const YES_PATTERNS: RegExp[] = [
  /\b(yes|yea|yeah|yep|yup|ya|yah|yessir|yessuh)\b/,
  /\bi'?m in\b/,
  unnegated('(?:got|get|getting) (?:in|it)'),
  unnegated('registered|enrolled|signed up|snagged|grabbed|secured'),
  /\b(all set|made it)\b/,
];

const NO_PATTERNS: RegExp[] = [
  /\b(no|nope|nah|naw|negative)\b/,
  /\b(missed|miss|lost|failed|fail)\b/,
  /\b(didn't|didnt|did not|couldn't|couldnt|could not|wasn't|wasnt|was not)\b/,
  /\b(too late|no luck|still closed|filled up|full again|gone)\b/,
  /\bnot (in|yet|registered|enrolled)\b/,
];

/**
 * Single letters are only an answer when they are the entire message. "y" in a
 * sentence is a typo or a variable name; "y" alone is a yes.
 */
const BARE_YES = new Set(['y']);
const BARE_NO = new Set(['n']);

/**
 * Classify a reply.
 *
 * `ambiguous` matters: "no way, I got in!" matches both sides, and answering it
 * either way would be a coin flip. The listener asks again instead.
 */
export function parseReply(input: string): ReplyIntent {
  const text = normalizeReply(input);
  if (!text) return 'unknown';

  if (BARE_YES.has(text)) return 'yes';
  if (BARE_NO.has(text)) return 'no';

  const yes = YES_PATTERNS.some((re) => re.test(text));
  const no = NO_PATTERNS.some((re) => re.test(text));

  if (yes && no) return 'ambiguous';
  if (yes) return 'yes';
  if (no) return 'no';
  return 'unknown';
}

/**
 * Pull a Rutgers index out of a reply, e.g. "yes for 12845".
 *
 * Requires exactly one five-digit run so "12845 or 12846" is not silently
 * resolved to the first one.
 */
export function extractIndexNumber(input: string): string | null {
  const matches = normalizeReply(input).match(/\b\d{5}\b/g);
  if (!matches || matches.length !== 1) return null;
  return matches[0];
}

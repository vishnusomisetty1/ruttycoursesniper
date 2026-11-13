/**
 * Reading a yes/no answer.
 *
 * Getting this wrong stops watching a section someone still needs, so the bias
 * throughout is "refuse to guess" rather than "make a reasonable assumption".
 */
import { describe, expect, it } from 'vitest';
import { extractIndexNumber, normalizeReply, parseReply } from '../src/telegram/parse-reply.js';

describe('yes answers', () => {
  it.each([
    'yes',
    'Yes!',
    'YES',
    'yeah',
    'yep',
    'yup',
    'ya',
    'y',
    'yes 🎉',
    'i got in',
    'got it',
    'I’m in',
    'im in',
    'registered',
    'enrolled',
    'signed up',
    'all set',
    'yes, thanks!',
    'yeah i registered',
  ])('reads %j as yes', (text) => {
    expect(parseReply(text)).toBe('yes');
  });
});

describe('no answers', () => {
  it.each([
    'no',
    'No.',
    'nope',
    'nah',
    'n',
    'missed it',
    'i missed it',
    "didn't get it",
    'didnt get in',
    'too late',
    'no luck',
    'it filled up',
    'not yet',
    'no :(',
  ])('reads %j as no', (text) => {
    expect(parseReply(text)).toBe('no');
  });
});

describe('refusing to guess', () => {
  it.each([
    'no way, i got in!',
    'yes and no',
    'i did not get in but yes i tried',
  ])('treats %j as ambiguous rather than picking a side', (text) => {
    expect(parseReply(text)).toBe('ambiguous');
  });

  it.each([
    '',
    '   ',
    'what?',
    'thanks for the alert',
    'when does it open',
    'watch 01:640:135',
    '🎉🎉',
  ])('treats %j as unknown', (text) => {
    expect(parseReply(text)).toBe('unknown');
  });

  it('does not match yes/no inside unrelated words', () => {
    expect(parseReply('anyone know the professor')).toBe('unknown');
    expect(parseReply('the synopsis says otherwise')).toBe('unknown');
  });
});

describe('index extraction', () => {
  it('finds a single index', () => {
    expect(extractIndexNumber('yes 12845')).toBe('12845');
    expect(extractIndexNumber('no for 12845 sadly')).toBe('12845');
  });

  it('refuses when there is more than one', () => {
    expect(extractIndexNumber('yes 12845 or 12846')).toBeNull();
  });

  it('returns null when there is none', () => {
    expect(extractIndexNumber('yes')).toBeNull();
  });

  it('ignores numbers that are not five digits', () => {
    expect(extractIndexNumber('yes 1234')).toBeNull();
    expect(extractIndexNumber('yes 123456')).toBeNull();
  });
});

describe('normalization', () => {
  it('strips punctuation and emoji and lowercases', () => {
    expect(normalizeReply('  YES!!! 🎉  ')).toBe('yes');
  });

  it('normalizes curly apostrophes so contractions still match', () => {
    expect(parseReply('didn’t get in')).toBe('no');
  });
});

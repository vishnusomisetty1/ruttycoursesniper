/** Environment validation and secret redaction in logs. */
import { describe, expect, it } from 'vitest';
import { loadConfig, parseDotEnv } from '../src/config.js';
import { createLogger, redact, redactString } from '../src/logger.js';
import { isWorkerAlive } from '../src/worker/heartbeat.js';

describe('loadConfig', () => {
  it('applies sensible defaults', () => {
    const config = loadConfig({ RUTGERS_YEAR: '2026' } as NodeJS.ProcessEnv);
    expect(config.RUTGERS_CAMPUS).toBe('NB');
    expect(config.RUTGERS_TERM).toBe('fall');
    expect(config.POLL_INTERVAL_SECONDS).toBe(30);
    expect(config.DATABASE_PATH).toBe('./data/rutgers-sniper.sqlite');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.SOC_BASE_URL).toBe('https://classes.rutgers.edu/soc/api');
  });

  it('coerces numeric strings', () => {
    const config = loadConfig({ POLL_INTERVAL_SECONDS: '45', RUTGERS_YEAR: '2027' } as NodeJS.ProcessEnv);
    expect(config.POLL_INTERVAL_SECONDS).toBe(45);
    expect(config.RUTGERS_YEAR).toBe(2027);
  });

  it('rejects a poll interval that would hammer Rutgers', () => {
    expect(() => loadConfig({ POLL_INTERVAL_SECONDS: '1' } as NodeJS.ProcessEnv)).toThrow(
      /POLL_INTERVAL_SECONDS/,
    );
  });

  it.each([
    ['RUTGERS_CAMPUS', 'XX'],
    ['RUTGERS_TERM', 'quarter'],
    ['LOG_LEVEL', 'verbose'],
    ['POLL_INTERVAL_SECONDS', 'abc'],
    ['RUTGERS_YEAR', '1899'],
    ['DEFAULT_TELEGRAM_CHAT_ID', 'not-a-number'],
    ['SOC_BASE_URL', 'not-a-url'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => loadConfig({ [key]: value } as NodeJS.ProcessEnv)).toThrow(/Invalid environment/);
  });

  it('treats an empty optional value as unset', () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: '', DEFAULT_TELEGRAM_CHAT_ID: '' } as NodeJS.ProcessEnv);
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.DEFAULT_TELEGRAM_CHAT_ID).toBeUndefined();
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({ RUTGERS_CAMPUS: 'ZZ', LOG_LEVEL: 'loud' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('RUTGERS_CAMPUS');
      expect((err as Error).message).toContain('LOG_LEVEL');
    }
  });
});

describe('parseDotEnv', () => {
  it('parses keys, ignores comments and blank lines', () => {
    expect(
      parseDotEnv(`
# a comment
FOO=bar

BAZ = qux
EMPTY=
`),
    ).toEqual({ FOO: 'bar', BAZ: 'qux', EMPTY: '' });
  });

  it('strips surrounding quotes', () => {
    expect(parseDotEnv(`A="quoted"\nB='single'`)).toEqual({ A: 'quoted', B: 'single' });
  });

  it('keeps "=" that appear inside a value', () => {
    expect(parseDotEnv('TOKEN=123:AAH=xyz=').TOKEN).toBe('123:AAH=xyz=');
  });
});

describe('secret redaction', () => {
  it('redacts a Telegram bot token found anywhere in a string', () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    expect(redactString(`sending via ${token} now`)).toContain('[REDACTED_TOKEN]');
    expect(redactString(`sending via ${token} now`)).not.toContain(token);
  });

  it('redacts secret-looking object keys', () => {
    const out = redact({
      botToken: 'super-secret',
      TELEGRAM_BOT_TOKEN: 'x',
      password: 'hunter2',
      authorization: 'Bearer abc',
      chatId: '123',
    }) as Record<string, unknown>;

    expect(out.botToken).toBe('[REDACTED]');
    expect(out.TELEGRAM_BOT_TOKEN).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.chatId).toBe('123'); // not a secret
  });

  it('redacts nested values and survives circular references', () => {
    const obj: Record<string, unknown> = { a: { b: { token: 'x' } } };
    obj.self = obj;
    const out = redact(obj) as Record<string, Record<string, Record<string, string>>>;
    expect(out.a.b.token).toBe('[REDACTED]');
    expect((out as unknown as Record<string, unknown>).self).toBe('[Circular]');
  });

  it('never writes a token into a log line', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });

    log.info('starting', { botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' });
    log.info('url is https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/x');

    expect(lines.join('\n')).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });
});

describe('logger', () => {
  it('emits structured JSON', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) });
    log.info('hello', { count: 3 });

    const record = JSON.parse(lines[0]);
    expect(record.level).toBe('info');
    expect(record.msg).toBe('hello');
    expect(record.count).toBe(3);
    expect(record.time).toBeTruthy();
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.debug('no');
    log.info('no');
    log.warn('yes');
    log.error('yes');
    expect(lines).toHaveLength(2);
  });

  it('merges child bindings into every record', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) }).child({
      component: 'worker',
    });
    log.info('tick');
    expect(JSON.parse(lines[0]).component).toBe('worker');
  });
});

describe('worker liveness', () => {
  const base = {
    pid: process.pid,
    lastPollAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    lastError: null,
    pollIntervalSeconds: 30,
  };

  it('reports not-running when there is no heartbeat', () => {
    expect(isWorkerAlive(null)).toBe(false);
  });

  it('reports running for a fresh heartbeat from a live pid', () => {
    const now = new Date();
    expect(isWorkerAlive({ ...base, updatedAt: now.toISOString() }, now)).toBe(true);
  });

  it('reports not-running for a stale heartbeat', () => {
    const now = new Date('2026-08-01T12:00:00Z');
    expect(
      isWorkerAlive({ ...base, updatedAt: '2026-08-01T11:00:00Z' }, now),
    ).toBe(false);
  });

  it('reports not-running when the pid is gone', () => {
    const now = new Date();
    // pid 0x7FFFFFFF is not a real process.
    expect(isWorkerAlive({ ...base, pid: 2147483646, updatedAt: now.toISOString() }, now)).toBe(
      false,
    );
  });
});

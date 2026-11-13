/**
 * Worker entrypoint — the long-running process kept alive by PM2 or systemd.
 *
 * Runs entirely on the CPU. There is no model inference here: a poll is an HTTP
 * GET plus a set lookup, which costs microseconds of CPU. A GPU would sit idle.
 */
import { loadConfig, loadDotEnvFile } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { RutgersSocClient } from '../rutgers/soc-client.js';
import { WatchRepository } from '../db/watch-repo.js';
import { TelegramClient, TelegramUpdateReader } from '../telegram/client.js';
import { MonitorService } from './monitor.js';
import { ReplyListener } from './reply-listener.js';
import { CommandHandler } from './command-handler.js';
import { writeHeartbeat, removeHeartbeat } from './heartbeat.js';
import { readUpdateOffset, writeUpdateOffset } from './update-offset.js';
import { nextPollDelayMs, pollDelaySeconds } from './poll-delay.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig();
  const log = createLogger({ level: config.LOG_LEVEL, bindings: { component: 'worker' } });

  const repo = new WatchRepository(config.DATABASE_PATH);
  const client = new RutgersSocClient({
    baseUrl: config.SOC_BASE_URL,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    catalogCacheMs: config.CATALOG_CACHE_MINUTES * 60_000,
    logger: log.child({ component: 'soc-client' }),
  });
  const notifier = new TelegramClient({
    botToken: config.TELEGRAM_BOT_TOKEN,
    baseUrl: config.TELEGRAM_API_BASE_URL,
    logger: log.child({ component: 'telegram' }),
  });

  if (!notifier.enabled) {
    log.warn('TELEGRAM_BOT_TOKEN is not set — status will be tracked but no alerts can be sent');
  }

  const monitor = new MonitorService({
    repo,
    client,
    notifier,
    logger: log.child({ component: 'monitor' }),
    repeatAlertMinutes: config.REPEAT_ALERT_MINUTES,
    failureAlertAfterMinutes: config.FAILURE_ALERT_AFTER_MINUTES,
    followupAfterMinutes: config.FOLLOWUP_AFTER_MINUTES,
  });

  const controller = new AbortController();
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown signal received, finishing current cycle', { signal });
    controller.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash inside an async callback should be logged, not silently fatal.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });

  log.info('rutgers monitor started', {
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    jitterSeconds: config.POLL_JITTER_SECONDS,
    repeatAlertMinutes: config.REPEAT_ALERT_MINUTES,
    followupAfterMinutes: config.FOLLOWUP_AFTER_MINUTES,
    databasePath: config.DATABASE_PATH,
    telegramEnabled: notifier.enabled,
    replyListenerEnabled: config.REPLY_LISTENER_ENABLED,
  });

  // The reply listener runs as a second loop in this same process. better-sqlite3
  // is synchronous, so two loops sharing one connection cannot interleave a
  // write — which is exactly why this is one process and not two.
  const replyLoop = config.REPLY_LISTENER_ENABLED
    ? runReplyLoop({
        listener: new ReplyListener({
          repo,
          notifier,
          updates: new TelegramUpdateReader({
            botToken: config.TELEGRAM_BOT_TOKEN,
            baseUrl: config.TELEGRAM_API_BASE_URL,
            logger: log.child({ component: 'telegram-updates' }),
          }),
          logger: log.child({ component: 'reply-listener' }),
          allowedChatIds: config.REPLY_ALLOWED_CHAT_IDS,
          commands: new CommandHandler({
            repo,
            client,
            notifier,
            defaultTerm: {
              year: config.RUTGERS_YEAR,
              term: config.RUTGERS_TERM,
              campus: config.RUTGERS_CAMPUS,
            },
            databasePath: config.DATABASE_PATH,
            pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
            logger: log.child({ component: 'commands' }),
          }),
          readOffset: () => readUpdateOffset(config.DATABASE_PATH),
          writeOffset: (offset) => writeUpdateOffset(config.DATABASE_PATH, offset),
        }),
        signal: controller.signal,
        log: log.child({ component: 'reply-listener' }),
      })
    : Promise.resolve();

  while (!controller.signal.aborted) {
    try {
      const result = await monitor.runOnce();
      writeHeartbeat(config.DATABASE_PATH, {
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        lastPollAt: monitor.state.lastPollAt,
        lastSuccessAt: monitor.state.lastSuccessAt,
        consecutiveFailures: monitor.state.consecutiveFailures,
        lastError: monitor.state.lastError,
        pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
        // What we are ACTUALLY waiting, so `status` can say "backing off"
        // instead of claiming a 30s cadence that is not happening.
        currentPollIntervalSeconds: pollDelaySeconds({
          baseSeconds: config.POLL_INTERVAL_SECONDS,
          jitterSeconds: 0,
          maxSeconds: config.MAX_POLL_INTERVAL_SECONDS,
          consecutiveFailures: monitor.state.consecutiveFailures,
        }),
        lastCycle: result,
      });
    } catch (err) {
      // runOnce already handles its own errors; this is the last safety net so
      // an unexpected bug can never kill the process.
      log.error('unexpected error in poll cycle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (controller.signal.aborted) break;

    // Jitter stops us from hitting Rutgers on a perfectly predictable beat, and
    // the interval stretches while we are failing so an outage is not met with
    // undiminished traffic.
    const delayOptions = {
      baseSeconds: config.POLL_INTERVAL_SECONDS,
      jitterSeconds: config.POLL_JITTER_SECONDS,
      maxSeconds: config.MAX_POLL_INTERVAL_SECONDS,
      consecutiveFailures: monitor.state.consecutiveFailures,
    };
    const delayMs = nextPollDelayMs(delayOptions);

    if (monitor.state.consecutiveFailures > 0) {
      log.warn('backing off after failed cycles', {
        consecutiveFailures: monitor.state.consecutiveFailures,
        nextPollInSeconds: Math.round(delayMs / 1000),
      });
    }

    await sleep(delayMs, controller.signal);
  }

  await replyLoop;

  log.info('shutting down cleanly');
  removeHeartbeat(config.DATABASE_PATH);
  repo.close();
  process.exit(0);
}

/**
 * Long-poll for replies until shutdown.
 *
 * getUpdates blocks server-side for ~25s, so this loop is nearly free: it costs
 * one idle HTTP connection, not repeated requests.
 */
async function runReplyLoop({
  listener,
  signal,
  log,
}: {
  listener: ReplyListener;
  signal: AbortSignal;
  log: Logger;
}): Promise<void> {
  log.info('listening for yes/no replies');
  while (!signal.aborted) {
    try {
      const recorded = await listener.runOnce(signal);
      if (recorded > 0) log.info('recorded replies', { recorded });
    } catch (err) {
      log.error('reply loop error', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Back off briefly so a persistent failure cannot become a hot loop.
      await sleep(5_000, signal);
    }
  }
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      msg: 'worker failed to start',
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});

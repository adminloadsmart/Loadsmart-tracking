import type Redis from 'ioredis';
import { logger } from '../shared/logger';

const LOG_EVERY_MS = 10_000;

/**
 * ioredis emits 'error' on every failed reconnect attempt; without a listener it prints
 * "Unhandled error event" to stderr each time. Log through pino instead, at most once per
 * LOG_EVERY_MS per client so an outage doesn't flood the logs (readiness reports it anyway).
 */
export function attachRedisErrorLogging(client: Redis, name: string): void {
  let lastLoggedAt = 0;
  let suppressed = 0;

  client.on('error', (err) => {
    const now = Date.now();
    if (now - lastLoggedAt < LOG_EVERY_MS) {
      suppressed += 1;
      return;
    }
    logger.warn({ err, client: name, suppressed }, 'Redis connection error');
    lastLoggedAt = now;
    suppressed = 0;
  });
  client.on('ready', () => {
    if (lastLoggedAt > 0) logger.info({ client: name }, 'Redis connection restored');
    lastLoggedAt = 0;
    suppressed = 0;
  });
}

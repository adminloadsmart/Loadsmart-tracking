import Redis, { RedisOptions } from 'ioredis';
import { attachRedisErrorLogging } from './redis-errors';

/**
 * A dedicated ioredis client — for blocking commands (XREADGROUP BLOCK ties up its connection for
 * the duration) or for a second Redis server (the main backend's). Callers own it and must
 * quit() it on shutdown.
 */
export function createRedisConnection(
  url: string,
  name: string,
  options: RedisOptions = {},
): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: null, ...options });
  attachRedisErrorLogging(client, name);
  return client;
}

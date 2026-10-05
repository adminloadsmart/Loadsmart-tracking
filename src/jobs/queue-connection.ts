import Redis from 'ioredis';
import { env } from '../config/env';
import { attachRedisErrorLogging } from '../db/redis-errors';

// BullMQ requires its own ioredis connection with maxRetriesPerRequest: null — its blocking
// commands (used internally for job polling) error under ioredis's default retry behavior
// otherwise. Kept as a second client on the SAME Redis server as db/redis.ts's RedisManager
// (env.redisUrl), not a separate queue-only Redis: one Redis instance is enough at this scale,
// and BullMQ's connection-option contract only requires a distinct *client object*, not a
// distinct server.
let connection: Redis | null = null;

export function getQueueConnection(): Redis {
  if (!connection) {
    connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
    attachRedisErrorLogging(connection, 'queue');
  }
  return connection;
}

/** Called from entrypoints/main.ts's graceful shutdown, after every Queue/Worker built on top of this
 *  connection has already been closed. */
export async function closeQueueConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

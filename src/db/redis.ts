import Redis from 'ioredis';
import { env } from '../config/env';
import { attachRedisErrorLogging } from './redis-errors';

class RedisManager {
  private client: Redis | null = null;

  async connect(): Promise<void> {
    // Fail fast instead of queueing commands while Redis is down — /readyz should report the
    // outage, and callers on hot paths should get an error rather than hang.
    this.client = new Redis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    attachRedisErrorLogging(this.client, 'main');
    await this.client.connect();
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (!this.client) return;
    await this.client.quit();
    this.client = null;
  }

  async ping(): Promise<void> {
    await this.getClient().ping();
  }

  async set(key: string, value: string | number, exSeconds?: number): Promise<'OK'> {
    return exSeconds !== undefined
      ? this.getClient().set(key, value, 'EX', exSeconds)
      : this.getClient().set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.getClient().get(key);
  }

  async delete(key: string): Promise<number> {
    return this.getClient().del(key);
  }

  /** Raw client for callers that need commands beyond this thin wrapper (streams, Lua, ZSETs). */
  getClient(): Redis {
    if (!this.client) {
      throw new Error('Redis client not connected. Call connect() first.');
    }
    return this.client;
  }
}

export const redisManager = new RedisManager();

import Redis from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaderLock } from './leader-lock';

// Needs a real Redis (docker compose or CI service). Skipped when none is reachable so plain
// `npm test` still works on a machine without the infra running.
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisAvailable();
const silent = pino({ level: 'silent' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!available)('LeaderLock (real Redis)', () => {
  let redis: Redis;
  const key = `test:leader:${process.pid}:${Date.now()}`;

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });
  afterAll(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it('elects exactly one leader and fails over after the leader stops', async () => {
    const a = new LeaderLock(redis, { key, ttlMs: 600, logger: silent });
    const b = new LeaderLock(redis, { key, ttlMs: 600, logger: silent });

    await a.start();
    await b.start();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);

    // Leader keeps renewing past its TTL.
    await sleep(900);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);

    // Clean stop releases the key immediately; the standby takes over on its next tick (ttl/3).
    await a.stop();
    await sleep(400);
    expect(b.isLeader()).toBe(true);

    await b.stop();
    expect(await redis.get(key)).toBeNull();
  });

  it('a crashed leader (no release) is replaced once its TTL lapses', async () => {
    const crashKey = `${key}:crash`;
    await redis.set(crashKey, 'someone-else', 'PX', 500);

    const standby = new LeaderLock(redis, { key: crashKey, ttlMs: 600, logger: silent });
    await standby.start();
    expect(standby.isLeader()).toBe(false);

    await sleep(800);
    expect(standby.isLeader()).toBe(true);
    await standby.stop();
  });
});

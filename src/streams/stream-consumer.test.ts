import type Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { infraAvailable, silentLogger, testRedis, waitFor } from '../__tests__/support/infra';
import { BatchHandler, deadLetterKey, GroupConsumer, StreamEntry } from './stream-consumer';

const available = await infraAvailable();

describe.skipIf(!available)('GroupConsumer (real Redis)', () => {
  let redis: Redis;
  let blocking: Redis;
  let consumer: GroupConsumer | null = null;
  const stream = 'test:stream';

  beforeAll(() => {
    redis = testRedis();
    blocking = testRedis();
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterEach(async () => {
    await consumer?.stop();
    consumer = null;
  });
  afterAll(async () => {
    await Promise.all([redis.quit(), blocking.quit()]);
  });

  function startConsumer(
    handler: BatchHandler,
    overrides: { claimIdleMs?: number; maxDeliveries?: number } = {},
  ) {
    consumer = new GroupConsumer({
      name: 'test',
      redis,
      blockingRedis: blocking,
      group: 'g',
      consumer: 'c1',
      streams: () => [stream],
      handler,
      logger: silentLogger,
      blockMs: 50,
      claimIdleMs: overrides.claimIdleMs ?? 50,
      maxDeliveries: overrides.maxDeliveries ?? 3,
    });
    consumer.start();
  }

  const pendingCount = async () => {
    const [count] = (await redis.xpending(stream, 'g')) as [number];
    return count;
  };

  it('delivers entries in order and acks them', async () => {
    const seen: string[] = [];
    startConsumer(async (_s, entries) => {
      seen.push(...entries.map((e) => e.fields.n));
    });
    for (let i = 0; i < 20; i += 1) await redis.xadd(stream, '*', 'n', String(i));

    await waitFor(async () => seen.length === 20);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
    await waitFor(async () => (await pendingCount()) === 0);
  });

  it('retries a failed batch until it succeeds', async () => {
    let attempts = 0;
    startConsumer(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('db down');
    });
    await redis.xadd(stream, '*', 'n', '1');

    await waitFor(async () => attempts >= 3 && (await pendingCount()) === 0);
    expect(await redis.xlen(deadLetterKey(stream))).toBe(0);
  });

  it('dead-letters poison entries immediately without blocking the rest', async () => {
    const handled: string[] = [];
    startConsumer(async (_s, entries: StreamEntry[]) => {
      const dead = entries
        .filter((e) => e.fields.n === 'bad')
        .map((e) => ({ id: e.id, reason: 'unparseable' }));
      handled.push(...entries.filter((e) => e.fields.n !== 'bad').map((e) => e.fields.n));
      return { dead };
    });
    await redis.xadd(stream, '*', 'n', 'ok-1');
    await redis.xadd(stream, '*', 'n', 'bad');
    await redis.xadd(stream, '*', 'n', 'ok-2');

    // The three entries may arrive in one batch or several — wait for both outcomes.
    await waitFor(
      async () => handled.length === 2 && (await redis.xlen(deadLetterKey(stream))) === 1,
    );
    expect(handled).toEqual(['ok-1', 'ok-2']);
    const [[, fields]] = (await redis.xrange(deadLetterKey(stream), '-', '+')) as Array<
      [string, string[]]
    >;
    expect(fields).toEqual(
      expect.arrayContaining(['n', 'bad', '_reason', 'unparseable', '_origin_stream', stream]),
    );
    await waitFor(async () => (await pendingCount()) === 0);
  });

  it('dead-letters an entry that keeps failing after maxDeliveries', async () => {
    startConsumer(
      async () => {
        throw new Error('always fails');
      },
      { maxDeliveries: 2 },
    );
    await redis.xadd(stream, '*', 'n', 'doomed');

    await waitFor(async () => (await redis.xlen(deadLetterKey(stream))) === 1, {
      timeoutMs: 15_000,
    });
    await waitFor(async () => (await pendingCount()) === 0);
  }, 20_000);

  it('re-delivers a crashed consumer’s pending entries to another consumer', async () => {
    // Simulate a consumer that read but died before acking.
    await redis.xgroup('CREATE', stream, 'g', '0', 'MKSTREAM');
    await redis.xadd(stream, '*', 'n', 'orphan');
    await redis.xreadgroup('GROUP', 'g', 'dead-consumer', 'COUNT', 10, 'STREAMS', stream, '>');

    const seen: string[] = [];
    startConsumer(async (_s, entries) => {
      seen.push(...entries.map((e) => e.fields.n));
    });
    await waitFor(async () => seen.includes('orphan') && (await pendingCount()) === 0);
  });
});

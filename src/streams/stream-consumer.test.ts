import type Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { infraAvailable, silentLogger, testRedis, waitFor } from '../__tests__/support/infra';
import { streamLag, streamLength, streamTrimmed } from '../shared/metrics';
import {
  BatchHandler,
  deadLetterKey,
  GroupConsumer,
  groupInfo,
  StreamEntry,
} from './stream-consumer';

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

  it('a slow stream does not hold up the others, and each stream stays in order', async () => {
    const other = 'test:stream:other';
    const seen: Record<string, string[]> = { [stream]: [], [other]: [] };
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    consumer = new GroupConsumer({
      name: 'test',
      redis,
      blockingRedis: blocking,
      group: 'g',
      consumer: 'c1',
      streams: () => [stream, other],
      handler: async (s, entries) => {
        if (s === stream) await slow;
        seen[s].push(...entries.map((e) => e.fields.n));
      },
      logger: silentLogger,
      blockMs: 50,
      batchSize: 2,
    });
    consumer.start();
    for (let i = 0; i < 6; i += 1) {
      await redis.xadd(stream, '*', 'n', String(i));
      await redis.xadd(other, '*', 'n', String(i));
    }
    // The other stream is fully handled, batch after batch, while the first is still stuck.
    await waitFor(async () => seen[other].length === 6);
    expect(seen[stream]).toEqual([]);
    expect(consumer.health().oldestTaskAgoMs).not.toBeNull();
    release();
    await waitFor(async () => seen[stream].length === 6);
    expect(seen[stream]).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(seen[other]).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('stop() waits for batches in flight and acks them', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    startConsumer(async () => slow);
    await redis.xadd(stream, '*', 'n', '1');
    await waitFor(async () => (await pendingCount()) === 1);
    const stopped = consumer!.stop();
    release();
    await stopped;
    consumer = null;
    expect(await pendingCount()).toBe(0);
  });

  const gauge = async (metric: { get(): Promise<{ values: any[] }> }) =>
    (await metric.get()).values.find((v) => v.labels.stream === stream)?.value;

  it('reports the backlog: lag and length while entries wait, lag 0 once read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await redis.xgroup('CREATE', stream, 'g', '0', 'MKSTREAM');
    for (let i = 0; i < 5; i += 1) await redis.xadd(stream, '*', 'n', String(i));
    startConsumer(async () => gate);
    // The first iteration samples before reading: all 5 are still undelivered.
    await waitFor(async () => (await gauge(streamLag)) === 5);
    expect(await gauge(streamLength)).toBe(5);
    release();
    await waitFor(async () => (await gauge(streamLag)) === 0, { timeoutMs: 10_000 });
  }, 15_000);

  it('counts pending entries trimmed by MAXLEN before processing', async () => {
    const before = (await gauge(streamTrimmed)) ?? 0;
    await redis.xgroup('CREATE', stream, 'g', '0', 'MKSTREAM');
    await redis.xadd(stream, '*', 'n', 'lost');
    await redis.xreadgroup('GROUP', 'g', 'dead-consumer', 'COUNT', 10, 'STREAMS', stream, '>');
    await redis.xtrim(stream, 'MAXLEN', 0);
    startConsumer(async () => {});
    await waitFor(async () => (await pendingCount()) === 0);
    expect(await gauge(streamTrimmed)).toBe(before + 1);
  });
});

describe('groupInfo', () => {
  it('reads one group out of an XINFO GROUPS reply', () => {
    const reply = [
      ['name', 'other', 'pending', 9, 'lag', 9],
      ['name', 'g', 'consumers', 1, 'pending', 3, 'last-delivered-id', '1-0', 'lag', 7],
    ];
    expect(groupInfo(reply, 'g')).toEqual({ pending: 3, lag: 7 });
    expect(groupInfo([['name', 'g', 'pending', 0, 'lag', null]], 'g')).toEqual({
      pending: 0,
      lag: null,
    });
    expect(groupInfo(reply, 'missing')).toBeUndefined();
  });
});

import type Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { infraAvailable, silentLogger, testRedis } from '../__tests__/support/infra';
import { adoptPartitionCount, PARTITION_COUNT_KEY } from './partition-layout';
import { pointStreamKey } from './partitioner';

const available = await infraAvailable();

describe.skipIf(!available)('adoptPartitionCount (real Redis)', () => {
  let redis: Redis;
  const adopt = (partitions: number) => adoptPartitionCount(redis, partitions, 'g', silentLogger);

  beforeAll(() => {
    redis = testRedis();
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  /** An old layout of `partitions` streams; partition 0 holds one entry not yet processed. */
  async function oldLayout(partitions: number, { backlog }: { backlog: boolean }) {
    for (let i = 0; i < partitions; i += 1) {
      await redis.xgroup('CREATE', pointStreamKey(i), 'g', '$', 'MKSTREAM');
    }
    if (backlog) await redis.xadd(pointStreamKey(0), '*', 'n', '1');
  }

  it('records the count on a fresh Redis', async () => {
    await adopt(64);
    expect(await redis.get(PARTITION_COUNT_KEY)).toBe('64');
  });

  it('refuses a new count while the old streams (made before the key) hold points', async () => {
    await oldLayout(16, { backlog: true });
    await expect(adopt(64)).rejects.toThrow(/16 → 64/);
    expect(await redis.get(PARTITION_COUNT_KEY)).toBeNull();
  });

  it('refuses while entries are delivered but unacked', async () => {
    await oldLayout(16, { backlog: true });
    await redis.xreadgroup('GROUP', 'g', 'c', 'STREAMS', pointStreamKey(0), '>');
    await expect(adopt(64)).rejects.toThrow(/still hold unprocessed points/);
  });

  it('adopts the new count once the old layout is drained', async () => {
    await oldLayout(16, { backlog: true });
    await redis.xreadgroup('GROUP', 'g', 'c', 'STREAMS', pointStreamKey(0), '>');
    const [[, [[id]]]] = (await redis.xreadgroup(
      'GROUP',
      'g',
      'c',
      'STREAMS',
      pointStreamKey(0),
      '0',
    )) as any;
    await redis.xack(pointStreamKey(0), 'g', id);
    await adopt(64);
    expect(await redis.get(PARTITION_COUNT_KEY)).toBe('64');
  });

  it('keeps the same count without checking anything', async () => {
    await redis.set(PARTITION_COUNT_KEY, '16');
    await oldLayout(16, { backlog: true });
    await expect(adopt(16)).resolves.toBeUndefined();
  });

  it('an old pod (rollback) can not flip a recorded new layout while it has points', async () => {
    await redis.set(PARTITION_COUNT_KEY, '64');
    await redis.xadd(pointStreamKey(40), '*', 'n', '1');
    await expect(adopt(16)).rejects.toThrow(/64 → 16/);
  });
});

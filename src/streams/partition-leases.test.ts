import type Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { infraAvailable, silentLogger, testRedis } from '../__tests__/support/infra';
import { PartitionLeaseManager } from './partition-leases';

const available = await infraAvailable();

describe.skipIf(!available)('PartitionLeaseManager (real Redis)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = testRedis();
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  const manager = (instanceId: string, leaseTtlMs = 60_000) =>
    new PartitionLeaseManager({
      redis,
      prefix: 'test:points',
      partitions: 16,
      logger: silentLogger,
      instanceId,
      leaseTtlMs,
    });

  it('a single instance owns every partition', async () => {
    const a = manager('aaaaaaaa-0000-0000-0000-000000000000');
    await a.tick();
    expect(a.ownedPartitions()).toHaveLength(16);
    await a.stop();
  });

  it('rebalances to disjoint fair shares when a second instance joins, and back when it leaves', async () => {
    const a = manager('aaaaaaaa-0000-0000-0000-000000000000');
    const b = manager('bbbbbbbb-0000-0000-0000-000000000000');
    await a.tick();
    await b.tick(); // b joins: sees 2 members, but a still holds everything
    expect(b.ownedPartitions()).toHaveLength(0);

    await a.tick(); // a releases its extras down to ceil(16/2) = 8
    await b.tick(); // b picks them up
    expect(a.ownedPartitions()).toHaveLength(8);
    expect(b.ownedPartitions()).toHaveLength(8);
    const overlap = a.ownedPartitions().filter((p) => b.ownedPartitions().includes(p));
    expect(overlap).toEqual([]);

    await b.stop(); // clean leave releases leases and membership
    await a.tick();
    expect(a.ownedPartitions()).toHaveLength(16);
    await a.stop();
  });

  it('takes over a crashed instance’s partitions once its leases expire', async () => {
    const crashed = manager('cccccccc-0000-0000-0000-000000000000', 300);
    await crashed.tick();
    expect(crashed.ownedPartitions()).toHaveLength(16);
    // No stop(): simulate a crash. Its leases and heartbeat expire after 300ms.

    const survivor = manager('dddddddd-0000-0000-0000-000000000000', 300);
    await survivor.tick();
    expect(survivor.ownedPartitions()).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 400));
    await survivor.tick();
    expect(survivor.ownedPartitions()).toHaveLength(16);
    await survivor.stop();
  });
});

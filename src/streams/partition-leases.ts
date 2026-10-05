import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export interface PartitionLeaseOptions {
  redis: Redis;
  /** Namespaces the member set and lease keys, e.g. 'trk:points'. */
  prefix: string;
  partitions: number;
  logger: Logger;
  leaseTtlMs?: number;
  instanceId?: string;
}

/**
 * Spreads N stream partitions across however many processor instances are alive, with each
 * partition owned by exactly one instance (a Redis lease key per partition). Instances heartbeat
 * into a members ZSET; each takes its fair share ceil(N / live) and releases extras when a new
 * instance joins, so scaling processors out/in rebalances automatically. A crashed instance's
 * leases expire after leaseTtlMs and are picked up by the survivors.
 */
export class PartitionLeaseManager {
  readonly instanceId: string;
  private readonly owned = new Set<number>();
  private readonly ttlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly options: PartitionLeaseOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.ttlMs = options.leaseTtlMs ?? 10_000;
  }

  ownedPartitions(): number[] {
    return [...this.owned].sort((a, b) => a - b);
  }

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(200, Math.floor(this.ttlMs / 4)));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const { redis } = this.options;
    try {
      for (const partition of this.owned) {
        await redis.eval(RELEASE_SCRIPT, 1, this.leaseKey(partition), this.instanceId);
      }
      await redis.zrem(this.membersKey(), this.instanceId);
    } catch (err) {
      // Not fatal — leases and membership expire on their own.
      this.options.logger.warn({ err }, 'Failed to release partition leases');
    }
    this.owned.clear();
  }

  /** One rebalance round; exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const { redis, partitions, logger } = this.options;
    try {
      const now = Date.now();
      await redis
        .multi()
        .zadd(this.membersKey(), now, this.instanceId)
        .zremrangebyscore(this.membersKey(), '-inf', now - this.ttlMs)
        .pexpire(this.membersKey(), this.ttlMs * 6)
        .exec();
      const live = Math.max(1, await redis.zcard(this.membersKey()));
      const fairShare = Math.ceil(partitions / live);

      // Renew what we hold; anything we failed to renew was lost (e.g. we stalled past the TTL).
      for (const partition of [...this.owned]) {
        const renewed = await redis.eval(
          RENEW_SCRIPT,
          1,
          this.leaseKey(partition),
          this.instanceId,
          String(this.ttlMs),
        );
        if (renewed !== 1) this.owned.delete(partition);
      }

      // Give back extras so a newly joined instance can take them.
      const extras = this.ownedPartitions().slice(fairShare);
      for (const partition of extras) {
        await redis.eval(RELEASE_SCRIPT, 1, this.leaseKey(partition), this.instanceId);
        this.owned.delete(partition);
      }

      // Fill up to our fair share from unowned partitions, starting at a per-instance offset so
      // instances don't all race for the same keys.
      if (this.owned.size < fairShare) {
        const offset =
          Number.parseInt(this.instanceId.replace(/-/g, '').slice(0, 8), 16) % partitions;
        for (let i = 0; i < partitions && this.owned.size < fairShare; i += 1) {
          const partition = (offset + i) % partitions;
          if (this.owned.has(partition)) continue;
          const acquired = await redis.set(
            this.leaseKey(partition),
            this.instanceId,
            'PX',
            this.ttlMs,
            'NX',
          );
          if (acquired === 'OK') this.owned.add(partition);
        }
      }
    } catch (err) {
      // Can't confirm ownership — stop reading everything rather than risk two owners.
      logger.warn({ err }, 'Partition lease round failed; dropping owned partitions');
      this.owned.clear();
    } finally {
      this.ticking = false;
    }
  }

  private membersKey(): string {
    return `${this.options.prefix}:members`;
  }

  private leaseKey(partition: number): string {
    return `${this.options.prefix}:lease:${partition}`;
  }
}

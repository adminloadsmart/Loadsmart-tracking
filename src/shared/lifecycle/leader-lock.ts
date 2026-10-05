import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

// Compare-and-act scripts: only the current holder (matching token) may renew or release, so a
// process that stalled past the TTL can never extend or delete a lock someone else now holds.
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

export interface LeaderLockOptions {
  key: string;
  ttlMs: number;
  logger: Logger;
  onAcquired?: () => void;
  onLost?: () => void;
}

/**
 * Single-leader election over one Redis key (SET NX PX + token-checked renew/release). Used by
 * the scheduler role so the due-poll dispatcher, retention jobs and outbox relay run exactly once
 * across replicas; standbys keep retrying and take over within ~ttlMs of the leader dying.
 */
export class LeaderLock {
  private readonly token = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private leader = false;
  private ticking = false;

  constructor(
    private readonly redis: Redis,
    private readonly options: LeaderLockOptions,
  ) {}

  isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    await this.tick();
    // Renew well inside the TTL so a single slow/failed round trip doesn't drop leadership.
    this.timer = setInterval(
      () => void this.tick(),
      Math.max(250, Math.floor(this.options.ttlMs / 3)),
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.leader) {
      try {
        await this.redis.eval(RELEASE_SCRIPT, 1, this.options.key, this.token);
      } catch (err) {
        // Not fatal — the key expires on its own within ttlMs.
        this.options.logger.warn({ err }, 'Failed to release leader lock');
      }
      this.setLeader(false);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.leader) {
        const renewed = await this.redis.eval(
          RENEW_SCRIPT,
          1,
          this.options.key,
          this.token,
          String(this.options.ttlMs),
        );
        if (renewed !== 1) this.setLeader(false);
      } else {
        const acquired = await this.redis.set(
          this.options.key,
          this.token,
          'PX',
          this.options.ttlMs,
          'NX',
        );
        if (acquired === 'OK') this.setLeader(true);
      }
    } catch (err) {
      // Can't confirm we still hold the lock — step down rather than risk two leaders.
      this.options.logger.warn({ err }, 'Leader lock round trip failed');
      this.setLeader(false);
    } finally {
      this.ticking = false;
    }
  }

  private setLeader(value: boolean): void {
    if (this.leader === value) return;
    this.leader = value;
    this.options.logger.info(
      { key: this.options.key, leader: value },
      value ? 'Became leader' : 'Lost leadership',
    );
    if (value) this.options.onAcquired?.();
    else this.options.onLost?.();
  }
}

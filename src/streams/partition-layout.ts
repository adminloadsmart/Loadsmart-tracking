import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { POINT_STREAM_PREFIX, pointStreamKey } from './partitioner';
import { groupInfo } from './stream-consumer';

/** The partition count the point streams are laid out with (written by the processors). */
export const PARTITION_COUNT_KEY = `${POINT_STREAM_PREFIX}:partitions`;
/** Highest partition probed when no count is recorded yet (streams made before this key). */
const PROBE_LIMIT = 1024;

/**
 * Changing POINT_PARTITIONS moves vehicles to other partitions. Entries still waiting in the old
 * layout would then be processed next to newer points of the same vehicle on another partition:
 * out of order, racing on its state. So a processor adopts a new count only once every old
 * partition is drained (nothing undelivered or unacked for `group`), and refuses to start
 * otherwise. Runbook: stop ingest (realtime, poller), wait for tracking_stream_lag to reach 0,
 * deploy every role with the new POINT_PARTITIONS, start ingest again.
 */
export async function adoptPartitionCount(
  redis: Redis,
  partitions: number,
  group: string,
  logger: Logger,
): Promise<void> {
  const stored = await redis.get(PARTITION_COUNT_KEY);
  const previous = stored !== null ? Number(stored) : await existingPartitionCount(redis);
  if (previous === 0 || previous === partitions) {
    if (stored === null) await redis.set(PARTITION_COUNT_KEY, String(partitions));
    return;
  }
  const busy = await undrained(redis, previous, group);
  if (busy.length > 0) {
    throw new Error(
      `POINT_PARTITIONS changed ${previous} → ${partitions}, but ${busy.length} old partition(s) ` +
        `still hold unprocessed points (${busy.slice(0, 5).join(', ')}). Stop ingest, let the ` +
        `processors with POINT_PARTITIONS=${previous} drain them, then deploy the new count.`,
    );
  }
  await redis.set(PARTITION_COUNT_KEY, String(partitions));
  logger.warn({ from: previous, to: partitions }, 'Point stream partition count changed');
}

/** Ingest roles: a count that differs from the processors' layout puts points on partitions
 *  nobody reads in order. Logged, not fatal: ingest keeps accepting points. */
export async function checkPartitionCount(
  redis: Redis,
  partitions: number,
  logger: Logger,
): Promise<void> {
  try {
    const stored = await redis.get(PARTITION_COUNT_KEY);
    if (stored !== null && Number(stored) !== partitions) {
      logger.error(
        { stored: Number(stored), configured: partitions },
        'POINT_PARTITIONS differs from the point stream layout; set it the same on every role',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Could not check the point stream partition count');
  }
}

async function existingPartitionCount(redis: Redis): Promise<number> {
  const pipeline = redis.pipeline();
  for (let i = 0; i < PROBE_LIMIT; i += 1) pipeline.exists(pointStreamKey(i));
  const replies = (await pipeline.exec()) ?? [];
  let highest = -1;
  replies.forEach(([err, exists], i) => {
    if (!err && Number(exists) > 0) highest = i;
  });
  return highest + 1;
}

async function undrained(redis: Redis, partitions: number, group: string): Promise<string[]> {
  const pipeline = redis.pipeline();
  const streams = Array.from({ length: partitions }, (_, i) => pointStreamKey(i));
  for (const stream of streams) pipeline.xlen(stream).xinfo('GROUPS', stream);
  const replies = (await pipeline.exec()) ?? [];
  return streams.filter((_, i) => {
    const [lenErr, length] = replies[i * 2] ?? [];
    if (!lenErr && Number(length) === 0) return false;
    const [infoErr, groups] = replies[i * 2 + 1] ?? [];
    // A stream with entries but no group yet: none of them was ever processed.
    const info = infoErr ? undefined : groupInfo(groups, group);
    if (!info) return true;
    return info.pending > 0 || info.lag === null || info.lag > 0;
  });
}

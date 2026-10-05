import { env } from '../config/env';
import { createRedisConnection } from '../db/redis-connection';
import { redisManager } from '../db/redis';
import { createLivePublisher } from '../modules/live';
import { createPointsModule } from '../modules/points';
import { createRulesModule } from '../modules/rules';
import { createSyncModule, LOADSMART_EVENTS_STREAM } from '../modules/sync';
import { RoleStarter } from '../shared/lifecycle/role-runner';
import { POINT_STREAM_PREFIX, pointStreamKey } from '../streams/partitioner';
import { PartitionLeaseManager } from '../streams/partition-leases';
import { GroupConsumer } from '../streams/stream-consumer';

const POINTS_GROUP = 'processors';
const SYNC_GROUP = 'tracking-sync';
// A consumer loop that hasn't completed an iteration for this long is stuck (each iteration is
// bounded by the XREADGROUP block time plus one batch).
const STALL_THRESHOLD_MS = 30_000;

/**
 * Stream consumers (docs/ROADMAP.md §1):
 *  - points: the partitioned point stream — this instance reads only the partitions it holds a
 *    lease on, so each vehicle's points are processed in order by one consumer at a time
 *  - sync:   `loadsmart.events` snapshots from the main backend → read models + trip lifecycle
 * Scale out by adding processor instances; partitions rebalance automatically (up to 16).
 */
export const startProcessorRole: RoleStarter = async ({ dataSource, health, logger }) => {
  const redis = redisManager.getClient();
  const { activeTrips } = createSyncModule(dataSource, redis, logger);
  const rules = createRulesModule({ dataSource, redis, activeTrips, logger });
  const points = createPointsModule(
    dataSource,
    redis,
    {
      partitions: env.pointPartitions,
      maxLen: env.pointStreamMaxLen,
    },
    { maxAccuracyM: env.phoneMaxAccuracyM },
    { onLatestPositions: createLivePublisher(redis).publish, logger },
    rules.hook,
  );
  const sync = createSyncModule(dataSource, redis, logger);

  const leases = new PartitionLeaseManager({
    redis,
    prefix: POINT_STREAM_PREFIX,
    partitions: env.pointPartitions,
    logger,
  });
  await leases.start();

  const pointsReader = createRedisConnection(env.redisUrl, 'points-reader');
  const pointConsumer = new GroupConsumer({
    name: 'points',
    redis,
    blockingRedis: pointsReader,
    group: POINTS_GROUP,
    consumer: leases.instanceId,
    streams: () => leases.ownedPartitions().map(pointStreamKey),
    handler: (stream, entries) => points.processing.handleBatch(stream, entries),
    logger,
    maxDeliveries: env.streamMaxDeliveries,
  });

  const mainRedis = createRedisConnection(env.mainRedisUrl, 'main-backend');
  const syncReader = createRedisConnection(env.mainRedisUrl, 'sync-reader');
  const syncConsumer = new GroupConsumer({
    name: 'sync',
    redis: mainRedis,
    blockingRedis: syncReader,
    group: SYNC_GROUP,
    consumer: leases.instanceId,
    streams: () => [LOADSMART_EVENTS_STREAM],
    handler: (stream, entries) => sync.service.handleBatch(stream, entries),
    logger,
    batchSize: 200,
    maxDeliveries: env.streamMaxDeliveries,
  });

  pointConsumer.start();
  syncConsumer.start();

  health.register('processor', async () => {
    const pointsHealth = pointConsumer.health();
    const syncHealth = syncConsumer.health();
    for (const [name, state] of [
      ['points', pointsHealth],
      ['sync', syncHealth],
    ] as const) {
      if (!state.running) throw new Error(`${name} consumer is not running`);
      if (state.lastBatchAgoMs !== null && state.lastBatchAgoMs > STALL_THRESHOLD_MS) {
        throw new Error(`${name} consumer stalled for ${state.lastBatchAgoMs}ms`);
      }
    }
    if (env.mainRedisUrl !== env.redisUrl) await mainRedis.ping();
    return {
      ownedPartitions: leases.ownedPartitions(),
      points: pointsHealth,
      sync: syncHealth,
    };
  });

  return {
    async stop() {
      health.unregister('processor');
      // Finish and ack in-flight batches, then hand partitions to the surviving instances.
      await Promise.all([pointConsumer.stop(), syncConsumer.stop()]);
      await leases.stop();
      await Promise.all([pointsReader.quit(), syncReader.quit(), mainRedis.quit()]);
    },
  };
};

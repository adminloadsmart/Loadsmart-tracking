import { env } from '../config/env';
import { createRedisConnection } from '../db/redis-connection';
import { redisManager } from '../db/redis';
import { createGeofencesModule, dwellOptionsFromEnv } from '../modules/geofences';
import { createTripStartModule, tripStartOptionsFromEnv } from '../modules/trip-start';
import { createLivePublisher } from '../modules/live';
import { composeHooks, createPointsModule } from '../modules/points';
import { createRoutesModule } from '../modules/routes';
import { createRulesModule } from '../modules/rules';
import { createTripsModule } from '../modules/trips';
import { RoleStarter } from '../shared/lifecycle/role-runner';
import { POINT_STREAM_PREFIX, pointStreamKey } from '../streams/partitioner';
import { adoptPartitionCount } from '../streams/partition-layout';
import { PartitionLeaseManager } from '../streams/partition-leases';
import { GroupConsumer } from '../streams/stream-consumer';

const POINTS_GROUP = 'processors';
// A consumer loop that hasn't completed an iteration for this long is stuck (each iteration is
// bounded by the XREADGROUP block time plus one batch).
const STALL_THRESHOLD_MS = 30_000;

/**
 * The partitioned point stream (docs/ROADMAP.md §1): this instance reads only the partitions it
 * holds a lease on, so each vehicle's points are processed in order by one consumer at a time,
 * through the pipeline, the rules engine and the geofence check. Each owned partition is handled on its own (a slow one never holds up
 * the rest), up to PROCESSOR_CONCURRENCY at once. Scale out by adding processor instances;
 * partitions rebalance automatically (at most POINT_PARTITIONS instances do work).
 */
export const startProcessorRole: RoleStarter = async ({ dataSource, health, logger }) => {
  const redis = redisManager.getClient();
  // Before reading anything: a changed POINT_PARTITIONS is only safe once the old layout is drained.
  await adoptPartitionCount(redis, env.pointPartitions, POINTS_GROUP, logger);
  const { activeTrips } = createTripsModule(dataSource, redis, logger);
  const routes = createRoutesModule({ dataSource, redis, logger });
  const rules = createRulesModule({ dataSource, redis, activeTrips, logger, routes });
  const geofences = createGeofencesModule({
    dataSource,
    redis,
    activeTrips,
    logger,
    dwell: dwellOptionsFromEnv(env),
  });
  const tripStart = createTripStartModule({
    dataSource,
    redis,
    logger,
    options: tripStartOptionsFromEnv(env),
  });
  const points = createPointsModule(
    dataSource,
    redis,
    {
      partitions: env.pointPartitions,
      maxLen: env.pointStreamMaxLen,
    },
    { maxAccuracyM: env.phoneMaxAccuracyM },
    { onLatestPositions: createLivePublisher(redis).publish, logger },
    composeHooks(rules.hook, geofences.hook, tripStart.hook),
  );

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
    concurrency: env.processorConcurrency,
  });

  pointConsumer.start();

  health.register('processor', async () => {
    const state = pointConsumer.health();
    if (!state.running) throw new Error('points consumer is not running');
    if (state.lastBatchAgoMs !== null && state.lastBatchAgoMs > STALL_THRESHOLD_MS) {
      throw new Error(`points consumer stalled for ${state.lastBatchAgoMs}ms`);
    }
    if (state.oldestTaskAgoMs !== null && state.oldestTaskAgoMs > STALL_THRESHOLD_MS) {
      throw new Error(`a points batch has been running for ${state.oldestTaskAgoMs}ms`);
    }
    return { ownedPartitions: leases.ownedPartitions(), points: state };
  });

  return {
    async stop() {
      health.unregister('processor');
      // Finish and ack in-flight batches, then hand partitions to the surviving instances.
      await pointConsumer.stop();
      await leases.stop();
      await pointsReader.quit();
    },
  };
};

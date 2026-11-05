import { Worker } from 'bullmq';
import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { getQueueConnection } from '../jobs/queue-connection';
import {
  ROADCAST_QUEUE,
  RoadcastClient,
  RoadcastPollJob,
  RoadcastPollJobData,
} from '../modules/ingest-roadcast';
import {
  IntugineClient,
  RedisSimCursors,
  SIM_POLL_QUEUE,
  SimPollJob,
  SimPollJobData,
  SimTripRepository,
} from '../modules/ingest-sim';
import { createPointsModule } from '../modules/points';
import { createTripsModule } from '../modules/trips';
import { RoleStarter } from '../shared/lifecycle/role-runner';

interface ProviderHealth {
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

/**
 * Provider pull workers (docs/ROADMAP.md §3.2). The scheduler leader enqueues the polls; any
 * number of pollers run them. Roadcast GPS devices and Intugine SIM each start on their own
 * credentials; ULIP will join here.
 */
export const startPollerRole: RoleStarter = async ({ dataSource, health, logger }) => {
  const roadcastOn = Boolean(env.roadcastApiKey && env.roadcastApiUrl);
  const simOn = Boolean(env.intugineApiUrl && env.intugineUsername && env.intuginePassword);
  if (!roadcastOn)
    logger.info('ROADCAST_API_KEY/ROADCAST_API_URL not set — Roadcast poller is off');
  if (!simOn) logger.info('INTUGINE_* not set — SIM poller is off');
  if (!roadcastOn && !simOn) {
    health.register('poller', async () => ({ roadcast: 'disabled', sim: 'disabled' }));
    return {
      async stop() {
        health.unregister('poller');
      },
    };
  }

  const redis = redisManager.getClient();
  const points = createPointsModule(dataSource, redis, {
    partitions: env.pointPartitions,
    maxLen: env.pointStreamMaxLen,
  });
  const { activeTrips } = createTripsModule(dataSource, redis, logger);

  const workers: Worker[] = [];
  const healthOf: Record<string, ProviderHealth | 'disabled'> = {
    roadcast: 'disabled',
    sim: 'disabled',
  };

  /** One BullMQ worker per provider, with the same success / failure bookkeeping. */
  function startWorker<T>(
    name: 'roadcast' | 'sim',
    queue: string,
    run: (data: T) => Promise<unknown>,
    describe: (data: T) => Record<string, unknown>,
  ) {
    const state: ProviderHealth = { lastSuccessAt: null, consecutiveFailures: 0 };
    healthOf[name] = state;
    const worker = new Worker<T>(
      queue,
      async (bullJob) => {
        const result = await run(bullJob.data);
        state.lastSuccessAt = new Date().toISOString();
        state.consecutiveFailures = 0;
        logger.debug({ ...describe(bullJob.data), result }, `${name} pull done`);
      },
      {
        connection: getQueueConnection(),
        // Different orgs' / trips' calls in parallel; one never has two (its job ids are fixed).
        concurrency: 4,
      },
    );
    worker.on('failed', (bullJob, err) => {
      state.consecutiveFailures++;
      logger.warn(
        { err, jobId: bullJob?.id, consecutiveFailures: state.consecutiveFailures },
        `${name} poll failed`,
      );
    });
    worker.on('error', (err) => logger.error({ err }, `${name} poll worker error`));
    workers.push(worker);
  }

  if (roadcastOn) {
    const job = new RoadcastPollJob(
      new RoadcastClient({
        url: env.roadcastApiUrl!,
        apiKey: env.roadcastApiKey!,
        timeoutMs: env.roadcastTimeoutMs,
      }),
      redis,
      activeTrips,
      points.publisher,
      { idleIntervalMs: env.roadcastIdleIntervalMs, speedUnit: env.roadcastSpeedUnit },
    );
    startWorker<RoadcastPollJobData>(
      'roadcast',
      ROADCAST_QUEUE,
      (data) => job.run(data),
      (data) => ({ devices: data.devices.length }),
    );
  }

  if (simOn) {
    const job = new SimPollJob(
      new IntugineClient({
        url: env.intugineApiUrl!,
        username: env.intugineUsername!,
        password: env.intuginePassword!,
        timeoutMs: env.intugineTimeoutMs,
        slowTimeoutMs: env.intugineSlowTimeoutMs,
      }),
      new SimTripRepository(dataSource),
      new RedisSimCursors(redis),
      activeTrips,
      points.publisher,
      { limit: env.intugineStatusLimit },
    );
    startWorker<SimPollJobData>(
      'sim',
      SIM_POLL_QUEUE,
      (data) => job.run(data),
      (data) => ({ tripId: data.tripId }),
    );
  }

  // A provider outage is not this process being unready: report it, never fail on it. The
  // no-signal rules catch silent devices.
  health.register('poller', async () => ({ ...healthOf }));

  return {
    async stop() {
      health.unregister('poller');
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
};

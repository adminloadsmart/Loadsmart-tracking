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
import { createPointsModule } from '../modules/points';
import { createTripsModule } from '../modules/trips';
import { RoleStarter } from '../shared/lifecycle/role-runner';

/**
 * Provider pull workers (docs/ROADMAP.md §3.2). The scheduler leader enqueues the polls; any
 * number of pollers run them. Roadcast GPS devices today; Intugine SIM and ULIP join here.
 */
export const startPollerRole: RoleStarter = async ({ dataSource, health, logger }) => {
  if (!env.roadcastApiKey || !env.roadcastApiUrl) {
    logger.info('ROADCAST_API_KEY/ROADCAST_API_URL not set — Roadcast poller is off');
    health.register('poller', async () => ({ roadcast: 'disabled' }));
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
  const job = new RoadcastPollJob(
    new RoadcastClient({
      url: env.roadcastApiUrl,
      apiKey: env.roadcastApiKey,
      timeoutMs: env.roadcastTimeoutMs,
    }),
    redis,
    activeTrips,
    points.publisher,
    { idleIntervalMs: env.roadcastIdleIntervalMs, speedUnit: env.roadcastSpeedUnit },
  );

  let lastSuccessAt: string | null = null;
  let consecutiveFailures = 0;

  const worker = new Worker<RoadcastPollJobData>(
    ROADCAST_QUEUE,
    async (bullJob) => {
      const result = await job.run(bullJob.data);
      lastSuccessAt = new Date().toISOString();
      consecutiveFailures = 0;
      logger.debug({ devices: bullJob.data.devices.length, ...result }, 'Roadcast pull done');
    },
    {
      connection: getQueueConnection(),
      // Different orgs' calls in parallel; one org never has two (its job ids are fixed).
      concurrency: 4,
    },
  );
  worker.on('failed', (bullJob, err) => {
    consecutiveFailures++;
    logger.warn({ err, jobId: bullJob?.id, consecutiveFailures }, 'Roadcast poll failed');
  });
  worker.on('error', (err) => logger.error({ err }, 'Roadcast poll worker error'));

  // A Roadcast outage is not this process being unready: report it, never fail on it. The
  // no-signal rules catch silent devices.
  health.register('poller', async () => ({ roadcast: { lastSuccessAt, consecutiveFailures } }));

  return {
    async stop() {
      health.unregister('poller');
      await worker.close();
    },
  };
};

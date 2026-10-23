import './instrument';
import 'reflect-metadata';
import { createServer } from 'http';
import { env } from '../config/env';
import { parseRoles, Role } from '../config/roles';
import { AppDataSource } from '../db/data-source';
import { redisManager } from '../db/redis';
import { closeAllQueues } from '../jobs/queue-registry';
import { closeQueueConnection } from '../jobs/queue-connection';
import { HealthRegistry } from '../shared/lifecycle/health';
import { closeServer, listen } from '../shared/lifecycle/http-server';
import { createOpsApp } from '../shared/lifecycle/ops-server';
import { RoleStarter, startRoles, StartedRole, stopRoles } from '../shared/lifecycle/role-runner';
import { logger } from '../shared/logger';
import { metricsRegistry } from '../shared/metrics';
import { stopTelemetry } from '../shared/telemetry';
import { startApiRole } from './api.role';
import { startRealtimeRole } from './realtime.role';
import { startSchedulerRole } from './scheduler.role';
import { startProcessorRole } from './processor.role';
import { startPollerRole } from './poller.role';

const STARTERS: Record<Role, RoleStarter> = {
  scheduler: startSchedulerRole,
  processor: startProcessorRole,
  poller: startPollerRole,
  realtime: startRealtimeRole,
  api: startApiRole,
};

async function bootstrap() {
  const roles = parseRoles(env.role);
  logger.info({ roles, nodeEnv: env.nodeEnv }, 'Starting loadsmart-tracking');

  const health = new HealthRegistry();
  health.register('postgres', async () => {
    await AppDataSource.query('SELECT 1');
  });
  health.register('redis', async () => {
    await redisManager.ping();
  });

  // Ops server first, so /healthz answers while dependencies are still connecting and /readyz
  // reports exactly which one is failing if boot stalls.
  const opsServer = createServer(createOpsApp(health, metricsRegistry));
  await listen(opsServer, env.opsPort);
  logger.info({ port: env.opsPort }, 'Ops server listening (/healthz, /readyz, /metrics)');

  await AppDataSource.initialize();
  await redisManager.connect();

  let started: StartedRole[] = [];
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error(
        { timeoutMs: env.shutdownTimeoutMs },
        'Graceful shutdown timed out, forcing exit',
      );
      process.exit(1);
    }, env.shutdownTimeoutMs);
    forceExit.unref();

    let exitCode = 0;
    try {
      // Roles first (ingress stops before consumers), then the shared infra they used.
      await stopRoles(started, logger);
      await closeAllQueues();
      await closeQueueConnection();
      await redisManager.close();
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
      await closeServer(opsServer);
      await stopTelemetry();
      logger.info('Shutdown complete');
    } catch (err) {
      exitCode = 1;
      logger.error({ err }, 'Error during graceful shutdown');
    } finally {
      clearTimeout(forceExit);
      // Let pino flush before exiting.
      logger.flush(() => process.exit(exitCode));
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  started = await startRoles(roles, STARTERS, { dataSource: AppDataSource, health, logger });
  logger.info({ roles }, 'All roles started');
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  logger.flush(() => process.exit(1));
});

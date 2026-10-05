import { createServer } from 'http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { createRedisConnection } from '../db/redis-connection';
import { createIngestPhoneModule } from '../modules/ingest-phone';
import { createPointsModule } from '../modules/points';
import { createSyncModule } from '../modules/sync';
import { closeServer, listen } from '../shared/lifecycle/http-server';
import { RoleStarter } from '../shared/lifecycle/role-runner';

// Namespaces still to come (docs/ROADMAP.md §3.1 / Phase 3); they reject connections until then.
const PENDING_NAMESPACES = {
  '/live': 'Phase 3 (live map viewers)',
} as const;

export const startRealtimeRole: RoleStarter = async ({ dataSource, health, logger }) => {
  // Driver tokens are issued by the main backend; without its secret nobody could connect.
  if (!env.jwtSecret) throw new Error('JWT_SECRET is required for the realtime role');

  const httpServer = createServer();
  const io = new Server(httpServer, {
    // websocket-only: no HTTP long-polling fallback, so the load balancer needs no sticky
    // sessions (§3.1). Phones on flaky networks reconnect instead of degrading to polling.
    transports: ['websocket'],
    cors: { origin: env.corsOrigins, credentials: true },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Fits a full `loc:batch` (≤ 200 points) with room to spare.
    maxHttpBufferSize: 64 * 1024,
  });

  // Nothing is served on the default namespace.
  io.use((_socket, next) => next(new Error('Use a named namespace')));
  for (const [name, phase] of Object.entries(PENDING_NAMESPACES)) {
    io.of(name).use((_socket, next) =>
      next(new Error(`Namespace ${name} not implemented yet — ${phase}`)),
    );
  }

  const redis = redisManager.getClient();
  const mainRedis = createRedisConnection(env.mainRedisUrl, 'main-backend-blocklist');
  const points = createPointsModule(dataSource, redis, {
    partitions: env.pointPartitions,
    maxLen: env.pointStreamMaxLen,
  });
  const { activeTrips } = createSyncModule(dataSource, redis, logger);
  createIngestPhoneModule({
    dataSource,
    mainRedis,
    activeTrips,
    publisher: points.publisher,
    jwtSecret: env.jwtSecret,
    logger,
    options: { minLocIntervalMs: env.phoneMinIntervalMs, minBatchIntervalMs: 1000 },
  }).attach(io.of('/driver'));

  await listen(httpServer, env.realtimePort);
  logger.info({ port: env.realtimePort }, 'socket.io server listening');

  health.register('realtime', async () => {
    if (!httpServer.listening) throw new Error('socket.io server not listening');
    return { port: env.realtimePort, connections: io.engine.clientsCount };
  });

  return {
    async stop() {
      health.unregister('realtime');
      // Disconnects every client (they reconnect to another pod) and closes the http server.
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await closeServer(httpServer);
      await mainRedis.quit();
    },
  };
};

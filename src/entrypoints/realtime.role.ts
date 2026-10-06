import { createServer } from 'http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { createRedisConnection } from '../db/redis-connection';
import { createIngestPhoneModule } from '../modules/ingest-phone';
import { createLiveModule } from '../modules/live';
import { createPointsModule } from '../modules/points';
import { createTripsModule } from '../modules/trips';
import { createTrackingApiModule } from '../modules/tracking-api';
import { closeServer, listen } from '../shared/lifecycle/http-server';
import { RoleStarter } from '../shared/lifecycle/role-runner';

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

  const redis = redisManager.getClient();
  const mainRedis = createRedisConnection(env.mainRedisUrl, 'main-backend-blocklist');
  const points = createPointsModule(dataSource, redis, {
    partitions: env.pointPartitions,
    maxLen: env.pointStreamMaxLen,
  });
  const { activeTrips } = createTripsModule(dataSource, redis, logger);
  createIngestPhoneModule({
    dataSource,
    mainRedis,
    activeTrips,
    publisher: points.publisher,
    jwtSecret: env.jwtSecret,
    logger,
    options: { minLocIntervalMs: env.phoneMinIntervalMs, minBatchIntervalMs: 1000 },
  }).attach(io.of('/driver'));

  // /live: web map viewers. Fed by the processors over Redis pub/sub (every pod subscribes).
  const liveSubscriber = createRedisConnection(env.redisUrl, 'live-subscriber');
  const fanout = await createLiveModule({
    subscriber: liveSubscriber,
    mainRedis,
    service: createTrackingApiModule(dataSource, redis).service,
    jwtSecret: env.jwtSecret,
    logger,
  }).attach(io.of('/live'));

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
      await fanout.stop();
      await Promise.all([mainRedis.quit(), liveSubscriber.quit()]);
    },
  };
};

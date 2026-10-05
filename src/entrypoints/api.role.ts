import { createServer } from 'http';
import { createApp } from '../app';
import { buildContainer } from '../composition-root';
import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { createRedisConnection } from '../db/redis-connection';
import { closeServer, listen } from '../shared/lifecycle/http-server';
import { RoleStarter } from '../shared/lifecycle/role-runner';

// REST API: live positions, trips, tracks, timelines (docs/contracts/tracking-api.md).
export const startApiRole: RoleStarter = async ({ dataSource, health, logger }) => {
  // Staff tokens are issued by the main backend; without its secret nobody could authenticate.
  if (!env.jwtSecret) throw new Error('JWT_SECRET is required for the api role');

  const mainRedis = createRedisConnection(env.mainRedisUrl, 'main-backend-blocklist');
  const app = createApp(
    buildContainer({
      dataSource,
      redis: redisManager.getClient(),
      mainRedis,
      jwtSecret: env.jwtSecret,
      logger,
      googleMapsApiKey: env.googleMapsApiKey,
    }),
  );
  const server = createServer(app);
  await listen(server, env.port);
  logger.info({ port: env.port }, 'REST API listening');

  health.register('api', async () => {
    if (!server.listening) throw new Error('HTTP server not listening');
    return { port: env.port };
  });

  return {
    async stop() {
      health.unregister('api');
      await closeServer(server);
      await mainRedis.quit();
    },
  };
};

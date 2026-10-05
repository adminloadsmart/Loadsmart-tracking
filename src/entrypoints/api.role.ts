import { createServer } from 'http';
import { createApp } from '../app';
import { buildContainer } from '../composition-root';
import { env } from '../config/env';
import { closeServer, listen } from '../shared/lifecycle/http-server';
import { RoleStarter } from '../shared/lifecycle/role-runner';

// REST API: trips, vehicles, org settings, share links (added from Phase 1 on).
export const startApiRole: RoleStarter = async ({ dataSource, health, logger }) => {
  const app = createApp(buildContainer(dataSource));
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
    },
  };
};

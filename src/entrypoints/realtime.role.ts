import { createServer } from 'http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { closeServer, listen } from '../shared/lifecycle/http-server';
import { RoleStarter } from '../shared/lifecycle/role-runner';

// Namespaces from docs/ROADMAP.md §3.1 / Phase 3. Registered now so the wiring, port and probes
// are in place; each rejects connections until its phase implements it.
const PENDING_NAMESPACES = {
  '/driver': 'Phase 2 (phone GPS ingest)',
  '/live': 'Phase 3 (live map viewers)',
} as const;

export const startRealtimeRole: RoleStarter = async ({ health, logger }) => {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    // websocket-only: no HTTP long-polling fallback, so the load balancer needs no sticky
    // sessions (§3.1). Phones on flaky networks reconnect instead of degrading to polling.
    transports: ['websocket'],
    cors: { origin: env.corsOrigins, credentials: true },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Matches the per-message cap planned for `loc:batch` (≤ 200 points ≈ well under 64 KB).
    maxHttpBufferSize: 64 * 1024,
  });

  // Nothing is served on the default namespace.
  io.use((_socket, next) => next(new Error('Use a named namespace')));
  for (const [name, phase] of Object.entries(PENDING_NAMESPACES)) {
    io.of(name).use((_socket, next) =>
      next(new Error(`Namespace ${name} not implemented yet — ${phase}`)),
    );
  }

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
    },
  };
};

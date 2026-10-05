import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { Container } from './composition-root';
import { env } from './config/env';
import { API_VERSION_PREFIX } from './shared/constants/api';
import { errorHandler, notFoundHandler } from './shared/middleware/error-handler.middleware';
import { requestId } from './shared/middleware/request-id.middleware';

// REST API for the api role. Health/readiness/metrics are NOT here — they live on the ops server
// (shared/lifecycle/ops-server.ts) so every role exposes them the same way.
export function createApp({ publicRouters, routers }: Container): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Non-browser clients do not send an Origin header and should remain supported.
        if (!origin || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin is not allowed by CORS'));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);

  for (const { path, router } of publicRouters) {
    app.use(`${API_VERSION_PREFIX}${path}`, router);
  }

  // Auth + tenant-scope middleware are inserted here in Phase 2/3 (shared JWT_SECRET with the
  // main backend — see docs/ROADMAP.md §8.3).
  for (const { path, router } of routers) {
    app.use(`${API_VERSION_PREFIX}${path}`, router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

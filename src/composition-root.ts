import { RequestHandler, Router } from 'express';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import { createAlertsModule } from './modules/alerts';
import { createAddressResolver } from './modules/geocoding';
import { createRoutesModule, RouteProvider } from './modules/routes';
import { createTrackingApiModule } from './modules/tracking-api';
import { createTokenBlocklist } from './shared/auth/token-blocklist';
import { createStaffAuth } from './shared/middleware/staff-auth.middleware';

export interface RouterMount {
  path: string;
  router: Router;
}

export interface Container {
  // Unauthenticated routes (e.g. public share-link tracking, Phase 10).
  publicRouters: RouterMount[];
  // Staff-token auth (main backend's access token) guarding `routers`.
  authMiddleware?: RequestHandler;
  // Authenticated, tenant-scoped routes (trips, vehicles, org settings, ...).
  routers: RouterMount[];
}

export interface ContainerDeps {
  dataSource: DataSource;
  /** Our own Redis (live positions, trip metrics). */
  redis: Redis;
  /** The main backend's Redis (access-token blocklist). */
  mainRedis: Redis;
  jwtSecret: string;
  logger: Logger;
  googleMapsApiKey?: string;
  /** Test override for route planning (fixture provider). */
  routeProvider?: RouteProvider | null;
}

/**
 * Hand-wired dependency graph, same pattern as the main loadsmart backend: each module exports a
 * createXModule(...) factory returning { service, router }, wired here.
 */
export function buildContainer(deps: ContainerDeps): Container {
  const addresses = createAddressResolver({
    redis: deps.redis,
    logger: deps.logger,
    googleMapsApiKey: deps.googleMapsApiKey,
  });
  const trackingApi = createTrackingApiModule(deps.dataSource, deps.redis, addresses);
  const alerts = createAlertsModule(deps.dataSource, deps.redis, addresses);
  const routes = createRoutesModule({
    dataSource: deps.dataSource,
    redis: deps.redis,
    logger: deps.logger,
    googleMapsApiKey: deps.googleMapsApiKey,
    provider: deps.routeProvider,
  });
  return {
    publicRouters: [],
    authMiddleware: createStaffAuth({
      jwtSecret: deps.jwtSecret,
      isBlocked: createTokenBlocklist(deps.mainRedis, deps.logger),
    }),
    routers: [
      { path: '', router: trackingApi.router },
      { path: '', router: alerts.router },
      { path: '', router: routes.router },
    ],
  };
}

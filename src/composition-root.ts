import { RequestHandler, Router } from 'express';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import { createAlertsModule } from './modules/alerts';
import { createAddressResolver } from './modules/geocoding';
import {
  createSimConsentRoutes,
  SimConsentApiService,
  SimConsentRepository,
  SimConsentService,
  SimTripRepository,
  type SimConsentOptions,
  type SimProvider,
} from './modules/ingest-sim';
import { MainDataRepository } from './modules/main-data';
import { createRoutesModule, RouteProvider } from './modules/routes';
import { createTrackingApiModule } from './modules/tracking-api';
import { createTokenBlocklist } from './shared/auth/token-blocklist';
import { createStaffAuth } from './shared/middleware/staff-auth.middleware';

/** Stands in for Intugine where it is not configured: only the consent status is read there. */
const UNCONFIGURED_SIM_PROVIDER = new Proxy({} as SimProvider, {
  get: () => () => Promise.reject(new Error('SIM provider is not configured')),
});

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
  /** Intugine, for sending the SIM consent SMS again; without it the consent status is still shown. */
  simProvider?: SimProvider | null;
  simConsentOptions?: SimConsentOptions;
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
  const trackingApi = createTrackingApiModule(
    deps.dataSource,
    deps.redis,
    addresses,
    deps.googleMapsApiKey,
  );
  const alerts = createAlertsModule(deps.dataSource, deps.redis, addresses);
  const routes = createRoutesModule({
    dataSource: deps.dataSource,
    redis: deps.redis,
    logger: deps.logger,
    googleMapsApiKey: deps.googleMapsApiKey,
    provider: deps.routeProvider,
  });
  const simTrips = new SimTripRepository(deps.dataSource);
  const simConsent = new SimConsentApiService(
    new MainDataRepository(deps.dataSource),
    simTrips,
    new SimConsentService(
      simTrips,
      deps.simProvider ?? UNCONFIGURED_SIM_PROVIDER,
      deps.simConsentOptions ?? { checkIntervalMs: 60 * 60_000, ttlMs: 12 * 60 * 60_000 },
      new SimConsentRepository(deps.dataSource),
    ),
    !!deps.simProvider,
  );
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
      { path: '', router: createSimConsentRoutes(simConsent) },
    ],
  };
}

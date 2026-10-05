import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import { GoogleGeocoder, GoogleRoutesProvider, Geocoder, RouteProvider } from './google.client';
import { RouteApprovalService } from './route-approval.service';
import { RoutePlanner } from './route-planner';
import { RouteStore } from './route.store';
import { RoutesRepository } from './routes.repository';
import { RoutesController } from './routes.controller';
import { createRoutesRoutes } from './routes.routes';

export interface RoutesModuleDeps {
  dataSource: DataSource;
  redis: Redis;
  logger: Logger;
  /** Without a key, planning is skipped (trips show route_status no_api_key; DELAY/DEV inactive). */
  googleMapsApiKey?: string;
  /** Overrides for tests (fixture routes, no network). */
  provider?: RouteProvider | null;
  geocoder?: Geocoder | null;
}

export function createRoutesModule(deps: RoutesModuleDeps) {
  const repository = new RoutesRepository(deps.dataSource);
  const provider =
    deps.provider !== undefined
      ? deps.provider
      : deps.googleMapsApiKey
        ? new GoogleRoutesProvider(deps.googleMapsApiKey)
        : null;
  const geocoder =
    deps.geocoder !== undefined
      ? deps.geocoder
      : deps.googleMapsApiKey
        ? new GoogleGeocoder(deps.googleMapsApiKey)
        : null;
  const store = new RouteStore(repository);
  const approval = new RouteApprovalService(
    deps.dataSource,
    repository,
    provider,
    store,
    deps.redis,
  );
  return {
    repository,
    store,
    planner: new RoutePlanner(repository, provider, geocoder, deps.logger),
    approval,
    router: createRoutesRoutes(new RoutesController(approval)),
  };
}

export { RouteGeometry, decodePolyline, encodePolyline } from './route-geometry';
export type { RouteProvider, Geocoder, ComputedRoute } from './google.client';
export { TRACKING_ROUTES_APPROVE } from './route-approval.service';
export { TripRoutes } from './trip-routes';

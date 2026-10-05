import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { VehicleStateStore } from '../processing/vehicle-state.store';
import { TrackingApiController } from './tracking-api.controller';
import { TrackingApiRepository } from './tracking-api.repository';
import { createTrackingApiRoutes } from './tracking-api.routes';
import { TrackingApiService } from './tracking-api.service';

export function createTrackingApiModule(dataSource: DataSource, redis: Redis) {
  const service = new TrackingApiService(
    new TrackingApiRepository(dataSource),
    new VehicleStateStore(redis),
  );
  return { service, router: createTrackingApiRoutes(new TrackingApiController(service)) };
}

export { toPositionView } from './tracking-api.service';
export type { PositionView } from './tracking-api.service';

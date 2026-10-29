import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import type { AddressResolver } from '../geocoding';
import { VehicleStateStore } from '../processing/vehicle-state.store';
import { TrackingApiController } from './tracking-api.controller';
import { TrackingApiRepository } from './tracking-api.repository';
import { createTrackingApiRoutes } from './tracking-api.routes';
import { TrackingApiService } from './tracking-api.service';

export function createTrackingApiModule(
  dataSource: DataSource,
  redis: Redis,
  addresses?: AddressResolver,
) {
  const service = new TrackingApiService(
    new TrackingApiRepository(dataSource),
    new VehicleStateStore(redis),
    (tripId) => redis.hgetall(`trk:trip:${tripId}:eta`),
    addresses,
  );
  return { service, router: createTrackingApiRoutes(new TrackingApiController(service)) };
}

export { toPositionView } from './tracking-api.service';
export type { PositionView } from './tracking-api.service';

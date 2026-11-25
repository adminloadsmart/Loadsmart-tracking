import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import type { AddressResolver } from '../geocoding';
import { GoogleGeocoder } from '../routes/google.client';
import { VehicleStateStore } from '../processing/vehicle-state.store';
import { readLiveEta } from './live-eta';
import { TrackingApiController } from './tracking-api.controller';
import { TrackingApiRepository } from './tracking-api.repository';
import { createTrackingApiRoutes } from './tracking-api.routes';
import { TrackingApiService } from './tracking-api.service';

export function createTrackingApiModule(
  dataSource: DataSource,
  redis: Redis,
  addresses?: AddressResolver,
  /** Geocodes a master place saved without a pin (Create trip / Edit tracking). */
  googleMapsApiKey?: string,
) {
  const service = new TrackingApiService(
    new TrackingApiRepository(dataSource),
    new VehicleStateStore(redis),
    (tripId) => readLiveEta(redis, tripId),
    addresses,
    googleMapsApiKey ? new GoogleGeocoder(googleMapsApiKey) : null,
  );
  return { service, router: createTrackingApiRoutes(new TrackingApiController(service)) };
}

export { toPositionView } from './tracking-api.service';
export type { PositionView } from './tracking-api.service';

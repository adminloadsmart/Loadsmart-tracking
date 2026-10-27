import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import { MainDataRepository } from '../main-data';
import { ActiveTripIndex } from './active-trip-index';
import { TripWatcher } from './trip-watcher';

/** Trips = the main backend's loads, tracked from loading confirmation to delivery. */
export function createTripsModule(dataSource: DataSource, redis: Redis, logger: Logger) {
  const mainData = new MainDataRepository(dataSource);
  const activeTrips = new ActiveTripIndex(redis);
  return { mainData, activeTrips, watcher: new TripWatcher(mainData, activeTrips, redis, logger) };
}

export {
  ActiveTripIndex,
  driverActiveTripKey,
  ON_TRIP_TENANTS_KEY,
  onTripDevicesKey,
  tripRefKey,
  vehicleActiveTripKey,
} from './active-trip-index';
export type { ActiveTripRefs, OnTripDevice, TripRef } from './active-trip-index';
export {
  ACTIVE_STATUSES,
  APPROACH_STATUSES,
  IN_TRANSIT_STATUS,
  isApproachStatus,
  isTrackingSource,
  AFTER_DELIVERY_STATUSES,
  DELIVERED_FOLLOW_MS,
  GEOFENCE_ONLY_STATUSES,
  INDEXED_STATUSES,
  isAfterDelivery,
  isGeofenceOnly,
  isIndexed,
  LOAD_STATUSES,
  marketVehicleId,
  normalizePlate,
  trackingStateFor,
} from './trip-state';
export type { LoadStatus, TrackingState } from './trip-state';
export { TripWatcher } from './trip-watcher';

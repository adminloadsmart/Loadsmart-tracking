import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import { ActiveTripIndex } from './active-trip-index';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

/**
 * @param redis our own Redis — where the active-trip index lives (the main backend's Redis is
 *              only the source of the `loadsmart.events` stream, read by the processor role).
 */
export function createSyncModule(dataSource: DataSource, redis: Redis, logger: Logger) {
  const activeTrips = new ActiveTripIndex(redis);
  return {
    service: new SyncService(new SyncRepository(dataSource), activeTrips, logger),
    activeTrips,
  };
}

export { LOADSMART_EVENTS_STREAM } from './sync.contract';
export type { SyncService } from './sync.service';
export type { ActiveTripIndex } from './active-trip-index';

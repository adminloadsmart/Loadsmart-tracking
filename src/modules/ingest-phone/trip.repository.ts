import { DataSource } from 'typeorm';
import { MainDataRepository } from '../main-data';

export interface TripAtTime {
  recordedAt: string;
  tripId: string;
  tenantId: string;
  vehicleId: string | null;
  /** loads.tracking_source of the trip. */
  trackingSource: string | null;
  /** The point is from the drive to the plant, before tracking started (see TripResolver). */
  approach: boolean;
}

/** How far before tracking officially started a point may still belong to the trip — the
 *  loading-confirmed timestamp is entered by a person and can lag the truck slightly. */
export const TRIP_START_GRACE_MINUTES = 10;

export class TripRepository {
  private readonly mainData: MainDataRepository;

  constructor(dataSource: DataSource) {
    this.mainData = new MainDataRepository(dataSource);
  }

  /**
   * For each timestamp, the driver's trip (load, in one of these tenants) whose tracking window covers
   * it. Used only for points the Redis fast path can't place — e.g. an offline batch flushed
   * after its trip ended. One round trip per batch.
   */
  async findTripsForDriverAt(
    driverId: string,
    tenantIds: string[],
    recordedAts: string[],
  ): Promise<TripAtTime[]> {
    const found = await this.mainData.driverLoadsAt(
      driverId,
      tenantIds,
      recordedAts,
      TRIP_START_GRACE_MINUTES,
    );
    return found.map(({ recordedAt, load }) => ({
      recordedAt,
      tripId: load.id,
      tenantId: load.tenantId,
      vehicleId: load.vehicleId,
      trackingSource: load.trackingSource,
      approach:
        load.startedAt === null ||
        Date.parse(recordedAt) < load.startedAt.getTime() - TRIP_START_GRACE_MINUTES * 60_000,
    }));
  }
}

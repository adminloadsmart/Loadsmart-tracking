import { DataSource } from 'typeorm';

export interface TripAtTime {
  recordedAt: string;
  tripId: string;
  tenantId: string;
  vehicleId: string | null;
}

/** How far before tracking officially started a point may still belong to the trip — the
 *  loading-confirmed timestamp is entered by a person and can lag the truck slightly. */
export const TRIP_START_GRACE = '10 minutes';

export class TripRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * For each timestamp, the driver's trip (in this tenant) whose tracking window covers it. Used
   * only for points the Redis fast path can't place — e.g. an offline batch flushed after its
   * trip ended. One round trip per batch.
   */
  async findTripsForDriverAt(
    driverId: string,
    tenantId: string,
    recordedAts: string[],
  ): Promise<TripAtTime[]> {
    if (recordedAts.length === 0) return [];
    const rows: Array<{
      recorded_at: string;
      id: string;
      tenant_id: string;
      vehicle_id: string | null;
    }> = await this.dataSource.query(
      `SELECT p.recorded_at, t.id, t.tenant_id, t.vehicle_id
         FROM unnest($3::text[]) AS p(recorded_at)
         JOIN LATERAL (
           SELECT id, tenant_id, vehicle_id FROM tracking.trips
           WHERE driver_id = $1 AND tenant_id = $2
             AND tracking_started_at IS NOT NULL
             AND tracking_started_at - INTERVAL '${TRIP_START_GRACE}' <= p.recorded_at::timestamptz
             AND (tracking_ended_at IS NULL OR tracking_ended_at >= p.recorded_at::timestamptz)
           ORDER BY tracking_started_at DESC
           LIMIT 1
         ) t ON true`,
      [driverId, tenantId, recordedAts],
    );
    return rows.map((row) => ({
      recordedAt: row.recorded_at,
      tripId: row.id,
      tenantId: row.tenant_id,
      vehicleId: row.vehicle_id,
    }));
  }
}

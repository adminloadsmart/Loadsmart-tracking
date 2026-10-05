import { DataSource } from 'typeorm';
import { NormalizedPoint } from './point.contract';

export type PointTable = 'location_points' | 'location_points_short';

/**
 * Bulk writer for the location hypertables. One INSERT ... SELECT FROM unnest(arrays) per batch:
 * a fixed 13 bind parameters regardless of batch size (no 65k-parameter ceiling, one plan), and
 * ON CONFLICT DO NOTHING on (vehicle_id, source, recorded_at) makes replays and duplicate
 * deliveries free. Deliberately raw SQL, not TypeORM entities — this is the hottest write path.
 */
export class PointRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Returns the number of rows actually inserted (duplicates excluded). */
  async insertMany(table: PointTable, points: NormalizedPoint[]): Promise<number> {
    if (points.length === 0) return 0;

    const rows = await this.dataSource.query(
      `INSERT INTO tracking.${table}
         (tenant_id, vehicle_id, trip_id, source, source_ref, recorded_at, received_at,
          lat, lng, speed_kmh, heading, accuracy_m, flags)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::timestamptz[],
         $7::timestamptz[], $8::float8[], $9::float8[], $10::real[], $11::real[], $12::real[],
         $13::jsonb[])
       ON CONFLICT DO NOTHING
       RETURNING 1`,
      [
        points.map((p) => p.tenantId),
        points.map((p) => p.vehicleId),
        points.map((p) => p.tripId ?? null),
        points.map((p) => p.source),
        points.map((p) => p.sourceRef),
        points.map((p) => p.recordedAt),
        points.map((p) => p.receivedAt),
        points.map((p) => p.lat),
        points.map((p) => p.lng),
        points.map((p) => p.speedKmh ?? null),
        points.map((p) => p.heading ?? null),
        points.map((p) => p.accuracyM ?? null),
        points.map((p) => (p.flags ? JSON.stringify(p.flags) : null)),
      ],
    );
    return rows.length;
  }
}

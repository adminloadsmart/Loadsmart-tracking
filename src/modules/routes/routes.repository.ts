import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

export interface TripNeedingRoute {
  id: string;
  tenant_id: string;
  promised_delivery_at: Date | null;
  route_attempts: number;
  origin_id: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  destination_id: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  destination_address: string | null;
}

export interface TripRouteRow {
  id: string;
  trip_id: string;
  version: number;
  kind: 'planned' | 'approved_alternate';
  polyline: string;
  distance_m: number;
  duration_s: number | null;
  promised_at: Date | null;
  created_at: Date;
}

export interface InTransitTrip {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  tracking_started_at: Date | null;
  promised_delivery_at: Date | null;
}

const MAX_BACKOFF_MIN = 360;

export class RoutesRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Active trips with no route yet, whose last attempt is older than their back-off. */
  tripsNeedingRoute(limit: number): Promise<TripNeedingRoute[]> {
    return this.dataSource.query(
      `SELECT t.id, t.tenant_id, t.promised_delivery_at, t.route_attempts,
              o.id AS origin_id, o.lat AS origin_lat, o.lng AS origin_lng,
              d.id AS destination_id, d.lat AS destination_lat, d.lng AS destination_lng,
              concat_ws(', ', NULLIF(d.name, ''), d.address, d.city, d.state, d.pin_code) AS destination_address
       FROM tracking.trips t
       LEFT JOIN tracking.places o ON o.id = t.origin_place_id
       LEFT JOIN tracking.places d ON d.id = t.destination_place_id
       WHERE t.tracking_state = 'active' AND t.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM tracking.trip_routes r WHERE r.trip_id = t.id)
         AND (t.route_checked_at IS NULL OR t.route_checked_at <
              now() - make_interval(mins => LEAST(${MAX_BACKOFF_MIN}, 5 * power(2, t.route_attempts)::int)))
       ORDER BY t.tracking_started_at NULLS LAST
       LIMIT $1`,
      [limit],
    );
  }

  async setRouteStatus(tripId: string, status: string, attempted: boolean): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.trips
         SET route_status = $2, route_checked_at = now(),
             route_attempts = route_attempts + CASE WHEN $3 THEN 1 ELSE 0 END
       WHERE id = $1`,
      [tripId, status, attempted],
    );
  }

  async saveGeocode(placeId: string, lat: number, lng: number, source: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.places SET lat = $2, lng = $3, geocoded_at = now(), geocode_source = $4
       WHERE id = $1 AND lat IS NULL`,
      [placeId, lat, lng, source],
    );
  }

  /** Appends a route version (PostGIS decodes the polyline for the geometry column). */
  async insertRoute(input: {
    tripId: string;
    kind: 'planned' | 'approved_alternate';
    polyline: string;
    distanceM: number;
    durationS: number | null;
    provider: string;
    promisedAt: Date | null;
    createdBy: string | null;
  }): Promise<TripRouteRow> {
    const rows: TripRouteRow[] = await this.dataSource.query(
      `INSERT INTO tracking.trip_routes
         (id, trip_id, version, kind, polyline, geom, distance_m, duration_s, provider, promised_at, created_by)
       VALUES ($1, $2,
               COALESCE((SELECT max(version) FROM tracking.trip_routes WHERE trip_id = $2), 0) + 1,
               $3, $4, ST_LineFromEncodedPolyline($4, 5), $5, $6, $7, $8, $9)
       RETURNING id, trip_id, version, kind, polyline, distance_m, duration_s, promised_at, created_at`,
      [
        randomUUID(),
        input.tripId,
        input.kind,
        input.polyline,
        input.distanceM,
        input.durationS,
        input.provider,
        input.promisedAt,
        input.createdBy,
      ],
    );
    return rows[0];
  }

  routesFor(tripIds: string[]): Promise<TripRouteRow[]> {
    if (tripIds.length === 0) return Promise.resolve([]);
    return this.dataSource.query(
      `SELECT id, trip_id, version, kind, polyline, distance_m, duration_s, promised_at, created_at
       FROM tracking.trip_routes WHERE trip_id = ANY($1::uuid[]) ORDER BY trip_id, version`,
      [tripIds],
    );
  }

  /** Trips the DELAY rule evaluates: active, load in transit, with a route. */
  inTransitTripsWithRoute(): Promise<InTransitTrip[]> {
    return this.dataSource.query(
      `SELECT t.id, t.tenant_id, t.vehicle_id, t.tracking_started_at, t.promised_delivery_at
       FROM tracking.trips t
       WHERE t.tracking_state = 'active' AND t.load_status = 'in_transit' AND t.vehicle_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM tracking.trip_routes r WHERE r.trip_id = t.id)`,
    );
  }

  async tripInfo(
    tripIds: string[],
  ): Promise<Map<string, { tracking_state: string; load_status: string }>> {
    if (tripIds.length === 0) return new Map();
    const rows: Array<{ id: string; tracking_state: string; load_status: string }> =
      await this.dataSource.query(
        `SELECT id, tracking_state, load_status FROM tracking.trips WHERE id = ANY($1::uuid[])`,
        [tripIds],
      );
    return new Map(rows.map((row) => [row.id, row]));
  }
}

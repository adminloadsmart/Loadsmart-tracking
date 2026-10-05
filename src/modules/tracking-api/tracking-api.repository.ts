import { DataSource } from 'typeorm';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { PointSource } from '../points';

export interface VehicleRow {
  id: string;
  tenant_id: string;
  kind: 'fleet' | 'market';
  registration_number: string;
  gps_provider: string | null;
  gps_enabled: boolean;
}

export interface PlaceRow {
  id: string;
  name: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
}

export interface TripRow {
  id: string;
  tenant_id: string;
  load_code: string;
  load_status: string;
  source_type: string;
  vehicle_id: string | null;
  vehicle_number: string | null;
  driver_id: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  tracking_state: 'pending' | 'active' | 'ended';
  tracking_started_at: Date | null;
  tracking_ended_at: Date | null;
  milestones: Record<string, string | null>;
  origin: PlaceRow | null;
  destination: PlaceRow | null;
}

export interface TrackPoint {
  recorded_at: Date;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  heading: number | null;
  source: PointSource;
  motion: string | null;
}

export interface TrackPolyline {
  polyline: string | null;
  point_count: number;
  first_at: Date | null;
  last_at: Date | null;
}

const PLACE_JSON = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object(
     'id', ${alias}.id, 'name', ${alias}.name, 'city', ${alias}.city,
     'lat', ${alias}.lat, 'lng', ${alias}.lng) END`;

/** `AND tenant_id = $n` for a tenant-scoped caller, nothing for platform admins. */
function scopeFilter(scope: TenantScope, column: string, param: number): string {
  return 'allTenants' in scope ? '' : `AND ${column} = $${param}`;
}
function scopeParams(scope: TenantScope): string[] {
  return 'allTenants' in scope ? [] : [scope.tenantId];
}

/**
 * Read side of the tracking data. Every lookup takes the caller's TenantScope so a row outside it
 * simply isn't found (callers turn that into 404 — no "exists but forbidden" oracle).
 *
 * Tracks are built in PostGIS: ST_MakeLine over the trip's points, simplified with
 * ST_SimplifyPreserveTopology and returned as a Google encoded polyline (precision 5), so a
 * multi-day trip ships as a few KB instead of tens of thousands of JSON points.
 */
export class TrackingApiRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findVehicle(scope: TenantScope, id: string): Promise<VehicleRow | null> {
    const rows = await this.dataSource.query(
      `SELECT id, tenant_id, kind, registration_number, gps_provider, gps_enabled
       FROM tracking.vehicles
       WHERE id = $1 AND deleted_at IS NULL ${scopeFilter(scope, 'tenant_id', 2)}`,
      [id, ...scopeParams(scope)],
    );
    return rows[0] ?? null;
  }

  listVehicles(scope: TenantScope, limit: number): Promise<VehicleRow[]> {
    return this.dataSource.query(
      `SELECT id, tenant_id, kind, registration_number, gps_provider, gps_enabled
       FROM tracking.vehicles
       WHERE deleted_at IS NULL ${scopeFilter(scope, 'tenant_id', 2)}
       ORDER BY registration_number
       LIMIT $1`,
      [limit, ...scopeParams(scope)],
    );
  }

  /** Active trip per vehicle, for the given vehicles. */
  async activeTripsByVehicle(vehicleIds: string[]): Promise<Map<string, string>> {
    if (vehicleIds.length === 0) return new Map();
    const rows: Array<{ id: string; vehicle_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT ON (vehicle_id) id, vehicle_id FROM tracking.trips
       WHERE tracking_state = 'active' AND vehicle_id = ANY($1::uuid[])
       ORDER BY vehicle_id, tracking_started_at DESC NULLS LAST`,
      [vehicleIds],
    );
    return new Map(rows.map((row) => [row.vehicle_id, row.id]));
  }

  async findTrip(scope: TenantScope, id: string): Promise<TripRow | null> {
    const rows = await this.dataSource.query(
      `${this.tripSelect()} WHERE t.id = $1 AND t.deleted_at IS NULL ${scopeFilter(scope, 't.tenant_id', 2)}`,
      [id, ...scopeParams(scope)],
    );
    return rows[0] ?? null;
  }

  listTrips(
    scope: TenantScope,
    state: 'pending' | 'active' | 'ended',
    limit: number,
  ): Promise<TripRow[]> {
    return this.dataSource.query(
      `${this.tripSelect()}
       WHERE t.tracking_state = $1 AND t.deleted_at IS NULL ${scopeFilter(scope, 't.tenant_id', 3)}
       ORDER BY t.tracking_started_at DESC NULLS LAST, t.load_code DESC
       LIMIT $2`,
      [state, limit, ...scopeParams(scope)],
    );
  }

  /** Raw trip points in time order (playback). */
  tripPoints(tripId: string, source: PointSource | null, limit: number): Promise<TrackPoint[]> {
    return this.dataSource.query(
      `SELECT recorded_at, lat, lng, speed_kmh, heading, source, flags->>'motion' AS motion
       FROM tracking.location_points
       WHERE trip_id = $1 AND ($2::text IS NULL OR source = $2)
       ORDER BY recorded_at
       LIMIT $3`,
      [tripId, source, limit],
    );
  }

  /** Simplified trip line; tolerance in degrees (0 = no simplification). */
  async tripPolyline(
    tripId: string,
    source: PointSource | null,
    toleranceDeg: number,
  ): Promise<TrackPolyline> {
    const rows = await this.dataSource.query(
      `WITH pts AS (
         SELECT recorded_at, ST_SetSRID(ST_MakePoint(lng, lat), 4326) AS geom
         FROM tracking.location_points
         WHERE trip_id = $1 AND ($2::text IS NULL OR source = $2)
       )
       ${this.polylineSelect('$3')}`,
      [tripId, source, toleranceDeg],
    );
    return rows[0];
  }

  /**
   * A vehicle's path over a time window across both retention tables (trip and idle points,
   * rejected fixes excluded). Raw points for windows up to a day; older/longer windows read the
   * 1-minute rollups, which outlive the 7-day raw retention of idle points.
   */
  async vehicleTimelinePolyline(
    vehicleId: string,
    from: Date,
    to: Date,
    toleranceDeg: number,
    useRollups: boolean,
  ): Promise<TrackPolyline> {
    const pointsCte = useRollups
      ? `SELECT bucket AS recorded_at, ST_SetSRID(ST_MakePoint(lng, lat), 4326) AS geom
           FROM tracking.location_points_1min WHERE vehicle_id = $1 AND bucket >= $2 AND bucket < $3
         UNION ALL
         SELECT bucket, ST_SetSRID(ST_MakePoint(lng, lat), 4326)
           FROM tracking.location_points_short_1min WHERE vehicle_id = $1 AND bucket >= $2 AND bucket < $3`
      : `SELECT recorded_at, ST_SetSRID(ST_MakePoint(lng, lat), 4326) AS geom
           FROM tracking.location_points
           WHERE vehicle_id = $1 AND recorded_at >= $2 AND recorded_at < $3
         UNION ALL
         SELECT recorded_at, ST_SetSRID(ST_MakePoint(lng, lat), 4326)
           FROM tracking.location_points_short
           WHERE vehicle_id = $1 AND recorded_at >= $2 AND recorded_at < $3
             AND NOT (flags ? 'rejected')`;
    const rows = await this.dataSource.query(
      `WITH pts AS (${pointsCte}) ${this.polylineSelect('$4')}`,
      [vehicleId, from, to, toleranceDeg],
    );
    return rows[0];
  }

  private polylineSelect(toleranceParam: string): string {
    // ST_MakeLine needs ≥ 2 points; a single fix is returned as a one-point polyline.
    return `SELECT
         CASE
           WHEN count(*) = 0 THEN NULL
           WHEN count(*) = 1 THEN ST_AsEncodedPolyline(ST_MakeLine(ARRAY[min(geom), min(geom)]), 5)
           ELSE ST_AsEncodedPolyline(
             ST_SimplifyPreserveTopology(ST_MakeLine(geom ORDER BY recorded_at), ${toleranceParam}::float8), 5)
         END AS polyline,
         count(*)::int AS point_count,
         min(recorded_at) AS first_at,
         max(recorded_at) AS last_at
       FROM pts`;
  }

  private tripSelect(): string {
    return `SELECT t.id, t.tenant_id, t.load_code, t.load_status, t.source_type, t.vehicle_id,
              t.vehicle_number, t.driver_id, t.driver_name, t.driver_phone, t.tracking_state,
              t.tracking_started_at, t.tracking_ended_at, t.milestones,
              ${PLACE_JSON('o')} AS origin, ${PLACE_JSON('d')} AS destination
       FROM tracking.trips t
       LEFT JOIN tracking.places o ON o.id = t.origin_place_id
       LEFT JOIN tracking.places d ON d.id = t.destination_place_id`;
  }
}

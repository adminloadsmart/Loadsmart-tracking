import { DataSource } from 'typeorm';
import { detectFeatures, DbFeatures } from '../../db/db-features';
import { encodePolyline, simplifyPolyline } from '../routes/route-geometry';
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
  route_status: string | null;
  promised_delivery_at: Date | null;
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

interface LineRow {
  recorded_at: Date;
  lat: number;
  lng: number;
}

function buildPolyline(rows: LineRow[], toleranceDeg: number): TrackPolyline {
  if (rows.length === 0) return { polyline: null, point_count: 0, first_at: null, last_at: null };
  const points = rows.map((row) => ({ lat: row.lat, lng: row.lng }));
  return {
    polyline: encodePolyline(simplifyPolyline(points, toleranceDeg)),
    point_count: rows.length,
    first_at: new Date(rows[0].recorded_at),
    last_at: new Date(rows[rows.length - 1].recorded_at),
  };
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
 * Tracks are returned as a Google encoded polyline (precision 5), simplified with Douglas-Peucker,
 * so a multi-day trip ships as a few KB instead of tens of thousands of JSON points. Built
 * in-process from (lat, lng) rows, so no PostGIS is needed.
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
    const rows: LineRow[] = await this.dataSource.query(
      `SELECT recorded_at, lat, lng FROM tracking.location_points
       WHERE trip_id = $1 AND ($2::text IS NULL OR source = $2)
       ORDER BY recorded_at`,
      [tripId, source],
    );
    return buildPolyline(rows, toleranceDeg);
  }

  /**
   * A vehicle's path over a time window across both retention tables (trip and idle points,
   * rejected fixes excluded). Raw points for windows up to a day; older/longer windows one point
   * per minute — from the TimescaleDB 1-minute rollups when available (they outlive the 7-day raw
   * retention of idle points), else by aggregating the raw rows.
   */
  async vehicleTimelinePolyline(
    vehicleId: string,
    from: Date,
    to: Date,
    toleranceDeg: number,
    useRollups: boolean,
  ): Promise<TrackPolyline> {
    const raw = `SELECT recorded_at, lat, lng FROM tracking.location_points
                   WHERE vehicle_id = $1 AND recorded_at >= $2 AND recorded_at < $3
                 UNION ALL
                 SELECT recorded_at, lat, lng FROM tracking.location_points_short
                   WHERE vehicle_id = $1 AND recorded_at >= $2 AND recorded_at < $3
                     AND NOT (flags ? 'rejected')`;
    let sql: string;
    if (!useRollups) {
      sql = `${raw} ORDER BY recorded_at`;
    } else if ((await this.features()).timescale) {
      sql = `SELECT bucket AS recorded_at, lat, lng FROM tracking.location_points_1min
               WHERE vehicle_id = $1 AND bucket >= $2 AND bucket < $3
             UNION ALL
             SELECT bucket, lat, lng FROM tracking.location_points_short_1min
               WHERE vehicle_id = $1 AND bucket >= $2 AND bucket < $3
             ORDER BY 1`;
    } else {
      // Last fix of each minute.
      sql = `SELECT DISTINCT ON (date_trunc('minute', recorded_at))
                    date_trunc('minute', recorded_at) AS recorded_at, lat, lng
             FROM (${raw}) pts
             ORDER BY date_trunc('minute', recorded_at), pts.recorded_at DESC`;
    }
    const rows: LineRow[] = await this.dataSource.query(sql, [vehicleId, from, to]);
    return buildPolyline(rows, toleranceDeg);
  }

  private featuresPromise: Promise<DbFeatures> | null = null;
  private features(): Promise<DbFeatures> {
    this.featuresPromise ??= detectFeatures(this.dataSource);
    return this.featuresPromise;
  }

  private tripSelect(): string {
    return `SELECT t.id, t.tenant_id, t.load_code, t.load_status, t.source_type, t.vehicle_id,
              t.vehicle_number, t.driver_id, t.driver_name, t.driver_phone, t.tracking_state,
              t.tracking_started_at, t.tracking_ended_at, t.milestones, t.route_status,
              t.promised_delivery_at,
              ${PLACE_JSON('o')} AS origin, ${PLACE_JSON('d')} AS destination
       FROM tracking.trips t
       LEFT JOIN tracking.places o ON o.id = t.origin_place_id
       LEFT JOIN tracking.places d ON d.id = t.destination_place_id`;
  }
}

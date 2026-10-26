import { DataSource } from 'typeorm';
import { detectFeatures, DbFeatures } from '../../db/db-features';
import { encodePolyline, simplifyPolyline } from '../routes/route-geometry';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { PointSource } from '../points';
import { MainDataRepository, MainLoad, MainVehicle } from '../main-data';
import { ACTIVE_STATUSES, LoadStatus, trackingStateFor } from '../trips';

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
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface PlannedRouteRow {
  trip_id: string;
  kind: 'planned' | 'approved_alternate';
  version: number;
  polyline: string;
  distance_m: number;
  duration_s: number | null;
  created_at: Date;
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
  customer_name: string | null;
  planned_tonnes: number | null;
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

const PENDING_STATUSES: readonly LoadStatus[] = [
  'created',
  'bids_received',
  'truck_assigned',
  'in_transit_loading',
];
const ENDED_STATUSES: readonly LoadStatus[] = [
  'delivered_ok',
  'delivered_with_issues',
  'original_pod_received',
  'invoice_generated',
  'payment',
  'closed',
];

function toVehicleRow(v: MainVehicle): VehicleRow {
  return {
    id: v.id,
    tenant_id: v.tenantId,
    kind: v.kind,
    registration_number: v.registrationNumber,
    gps_provider: v.gpsProvider,
    gps_enabled: v.gpsEnabled,
  };
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

/**
 * Read side of the tracking data. Every lookup takes the caller's TenantScope so a row outside it
 * simply isn't found (callers turn that into 404 — no "exists but forbidden" oracle).
 *
 * Tracks are returned as a Google encoded polyline (precision 5), simplified with Douglas-Peucker,
 * so a multi-day trip ships as a few KB instead of tens of thousands of JSON points. Built
 * in-process from (lat, lng) rows, so no PostGIS is needed.
 */
export class TrackingApiRepository {
  private readonly mainData: MainDataRepository;

  constructor(private readonly dataSource: DataSource) {
    this.mainData = new MainDataRepository(dataSource);
  }

  // Loads, vehicles and places are the main backend's — read through main-data, never copied.

  async findVehicle(scope: TenantScope, id: string): Promise<VehicleRow | null> {
    const vehicle = await this.mainData.vehicle(scope, id);
    return vehicle ? toVehicleRow(vehicle) : null;
  }

  async listVehicles(scope: TenantScope, limit: number): Promise<VehicleRow[]> {
    return (await this.mainData.vehicles(scope, limit)).map(toVehicleRow);
  }

  /** Active trip (load) per vehicle, for the given vehicles. */
  async activeTripsByVehicle(vehicleIds: string[]): Promise<Map<string, string>> {
    if (vehicleIds.length === 0) return new Map();
    const wanted = new Set(vehicleIds);
    const result = new Map<string, string>();
    for (const load of await this.mainData.activeLoads()) {
      if (load.vehicleId && wanted.has(load.vehicleId) && !result.has(load.vehicleId)) {
        result.set(load.vehicleId, load.id);
      }
    }
    return result;
  }

  async findTrip(scope: TenantScope, id: string): Promise<TripRow | null> {
    const load = await this.mainData.load(scope, id);
    return load ? (await this.toTripRows([load]))[0] : null;
  }

  async listTrips(
    scope: TenantScope,
    state: 'pending' | 'active' | 'ended',
    limit: number,
  ): Promise<TripRow[]> {
    const statuses =
      state === 'active'
        ? ACTIVE_STATUSES
        : state === 'pending'
          ? PENDING_STATUSES
          : ENDED_STATUSES;
    return this.toTripRows(await this.mainData.loadsByStatus(scope, statuses, limit));
  }

  private async toTripRows(loads: MainLoad[]): Promise<TripRow[]> {
    const places = await this.mainData.places(
      loads.map((l) => l.loadingPointId).filter((x): x is string => !!x),
      loads.map((l) => l.deliveryPointId).filter((x): x is string => !!x),
    );
    const statusRows: Array<{ trip_id: string; status: string }> = loads.length
      ? await this.dataSource.query(
          `SELECT trip_id, status FROM tracking.trip_route_status WHERE trip_id = ANY($1::uuid[])`,
          [loads.map((l) => l.id)],
        )
      : [];
    const routeStatus = new Map(statusRows.map((r) => [r.trip_id, r.status]));
    const place = (id: string | null): PlaceRow | null => {
      const p = id ? places.get(id) : undefined;
      return p
        ? { id: p.id, name: p.name, city: p.city, address: p.address, lat: p.lat, lng: p.lng }
        : null;
    };
    return loads.map((load) => ({
      id: load.id,
      tenant_id: load.tenantId,
      load_code: load.code,
      load_status: load.status,
      source_type: load.sourceType,
      vehicle_id: load.vehicleId,
      vehicle_number: load.vehicleNumber,
      driver_id: load.driverId,
      driver_name: load.driverName,
      driver_phone: load.driverNumber,
      customer_name: load.customerName,
      planned_tonnes: load.plannedTonnes,
      tracking_state: trackingStateFor(load.status, false),
      tracking_started_at: load.startedAt,
      tracking_ended_at: load.endedAt,
      milestones: load.milestones,
      route_status: routeStatus.get(load.id) ?? null,
      promised_delivery_at: load.promisedDeliveryAt,
      origin: place(load.loadingPointId),
      destination: place(load.deliveryPointId),
    }));
  }

  /** The route currently in force per trip (latest version: planned, or the approved alternate). */
  async currentRoutes(tripIds: string[]): Promise<Map<string, PlannedRouteRow>> {
    if (tripIds.length === 0) return new Map();
    const rows: PlannedRouteRow[] = await this.dataSource.query(
      `SELECT DISTINCT ON (trip_id) trip_id, kind, version, polyline, distance_m, duration_s, created_at
       FROM tracking.trip_routes WHERE trip_id = ANY($1::uuid[])
       ORDER BY trip_id, version DESC`,
      [tripIds],
    );
    return new Map(rows.map((row) => [row.trip_id, row]));
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
}

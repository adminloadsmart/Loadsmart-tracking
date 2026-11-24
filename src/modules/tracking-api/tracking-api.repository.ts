import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { detectFeatures, DbFeatures } from '../../db/db-features';
import { encodePolyline, simplifyPolyline } from '../routes/route-geometry';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { PointSource } from '../points';
import { FastagCrossingRepository, type CrossingRow } from '../ingest-ulip';
import { MainDataRepository, MainLoad, MainVehicle } from '../main-data';
import { ACTIVE_STATUSES, LoadStatus, trackingStateFor } from '../trips';
import type { StatsPoint } from './vehicle-stats';
import { TrackingTripEntity, TripStatus } from './trip.entity';

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

export interface ApproachRouteRow {
  trip_id: string;
  polyline: string;
  distance_m: number;
  duration_s: number | null;
}

export interface TripRow {
  id: string;
  tenant_id: string;
  load_code: string;
  load_title: string | null;
  load_status: string;
  posting_type: string;
  route: string | null;
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
  eway_bill_number: string | null;
  eway_bill_expires_at: Date | null;
  origin: PlaceRow | null;
  destination: PlaceRow | null;
  /** Only on trips created from the tracking screen (tracking.trips) — absent for load trips. */
  created?: CreatedTripExtras;
}

/** The fields a created (tracking-only) trip has beyond a load trip's. */
export interface CreatedTripExtras {
  direction: 'in' | 'out' | null;
  status: TripStatus;
  transporterName: string | null;
  transporterPhone: string | null;
  loadingReportingAt: Date | null;
  appointment: { ref: string | null; from: Date | null; to: Date | null } | null;
  createdAt: Date;
}

/** A new created trip, as the service hands it to the repository (code is assigned here). */
export type NewCreatedTrip = Omit<
  TrackingTripEntity,
  'id' | 'code' | 'status' | 'endedAt' | 'createdAt' | 'updatedAt'
>;

export interface TrackPoint {
  recorded_at: Date;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  heading: number | null;
  source: PointSource;
  motion: string | null;
}

const PENDING_STATUSES: readonly LoadStatus[] = ['created', 'bids_received'];
/** Created trips per list state: they start active (no pending stage — there is no load to wait on). */
const CREATED_TRIP_STATUSES: Record<'pending' | 'active' | 'ended', TripStatus[]> = {
  pending: [],
  active: ['active'],
  ended: ['ended', 'cancelled'],
};
const CREATED_TRIP_CODE_PREFIX = 'TRP-';
// Postgres unique_violation — two creates in one tenant raced for the same code.
const UNIQUE_VIOLATION = '23505';
const ENDED_STATUSES: readonly LoadStatus[] = [
  'delivered_ok',
  'delivered_with_issues',
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
  private readonly fastag: FastagCrossingRepository;
  private readonly createdTrips: Repository<TrackingTripEntity>;

  constructor(private readonly dataSource: DataSource) {
    this.mainData = new MainDataRepository(dataSource);
    this.fastag = new FastagCrossingRepository(dataSource);
    this.createdTrips = dataSource.getRepository(TrackingTripEntity);
  }

  /** The FASTag toll crossings stored for a trip, oldest first (collected by the ULIP poller). */
  tripFastagCrossings(tripId: string, limit: number): Promise<CrossingRow[]> {
    return this.fastag.listByLoad(tripId, limit);
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

  /** A trip by id: a load trip, else a trip created from the tracking screen. */
  async findTrip(scope: TenantScope, id: string): Promise<TripRow | null> {
    const load = await this.mainData.load(scope, id);
    if (load) return (await this.toTripRows([load]))[0];
    const created = await this.createdTrips.findOne({ where: { id, ...tenantWhere(scope) } });
    return created ? (await this.toCreatedTripRows([created]))[0] : null;
  }

  /** Created trips (newest first) ahead of load trips, `limit` in total. */
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
    const createdStatuses = CREATED_TRIP_STATUSES[state];
    const created = createdStatuses.length
      ? await this.createdTrips.find({
          where: { status: In(createdStatuses), ...tenantWhere(scope) },
          order: { createdAt: 'DESC' },
          take: limit,
        })
      : [];
    const createdRows = await this.toCreatedTripRows(created);
    const remaining = limit - createdRows.length;
    const loadRows =
      remaining > 0
        ? await this.toTripRows(await this.mainData.loadsByStatus(scope, statuses, remaining))
        : [];
    return [...createdRows, ...loadRows];
  }

  /** Saves a created trip with the tenant's next TRP-#### code (retried if a concurrent create
   *  took the same one). */
  async createTrip(data: NewCreatedTrip): Promise<TripRow> {
    for (let attempt = 1; ; attempt++) {
      const code = await this.nextTripCode(data.tenantId);
      try {
        const saved = await this.createdTrips.save(this.createdTrips.create({ ...data, code }));
        return (await this.toCreatedTripRows([saved]))[0];
      } catch (error) {
        const duplicate =
          error instanceof QueryFailedError &&
          (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;
        if (!duplicate || attempt >= 3) throw error;
      }
    }
  }

  /** Ends an active created trip; null when it isn't one of the caller's created trips or has
   *  already ended. */
  async endCreatedTrip(
    scope: TenantScope,
    id: string,
    status: Exclude<TripStatus, 'active'>,
  ): Promise<TripRow | null> {
    const result = await this.createdTrips.update(
      { id, status: 'active', ...tenantWhere(scope) },
      { status, endedAt: new Date() },
    );
    if (!result.affected) return null;
    const trip = await this.createdTrips.findOneByOrFail({ id });
    return (await this.toCreatedTripRows([trip]))[0];
  }

  private async nextTripCode(tenantId: string): Promise<string> {
    const row = await this.createdTrips
      .createQueryBuilder('t')
      .select("MAX(CAST(SUBSTRING(t.code FROM '[0-9]+$') AS integer))", 'max')
      .where('t.tenant_id = :tenantId', { tenantId })
      .getRawOne<{ max: number | null }>();
    const next = Number(row?.max ?? 0) + 1;
    return `${CREATED_TRIP_CODE_PREFIX}${String(next).padStart(4, '0')}`;
  }

  /** Created trips → TripRow, with coordinates read from the picked masters (typed-in addresses
   *  have none, so the map shows them without a pin). */
  private async toCreatedTripRows(trips: TrackingTripEntity[]): Promise<TripRow[]> {
    if (trips.length === 0) return [];
    const refsOf = (kind: TrackingTripEntity['originKind']) =>
      trips.flatMap((t) => [
        ...(t.originKind === kind && t.originRefId ? [t.originRefId] : []),
        ...(t.destinationKind === kind && t.destinationRefId ? [t.destinationRefId] : []),
      ]);
    const [masters, statusRows] = await Promise.all([
      this.mainData.places(refsOf('loading_point'), refsOf('customer_address')),
      this.dataSource
        .createQueryBuilder()
        .select(['s.trip_id AS trip_id', 's.status AS status'])
        .from('tracking.trip_route_status', 's')
        .where('s.trip_id IN (:...ids)', { ids: trips.map((t) => t.id) })
        .getRawMany<{ trip_id: string; status: string }>(),
    ]);
    // Route planning (RoutePlanner) covers created trips too: no_api_key, not_found, ok, ...
    const routeStatus = new Map(statusRows.map((r) => [r.trip_id, r.status]));
    const place = (
      refId: string | null,
      name: string,
      address: string,
      city: string | null,
    ): PlaceRow => {
      const master = refId ? masters.get(refId) : undefined;
      return {
        id: refId ?? '',
        name,
        city: city ?? master?.city ?? null,
        address,
        lat: master?.lat ?? null,
        lng: master?.lng ?? null,
      };
    };
    return trips.map((t) => ({
      id: t.id,
      tenant_id: t.tenantId,
      load_code: t.code,
      load_title: null,
      load_status: t.status,
      posting_type: 'tracking_only',
      route: null,
      vehicle_id: null,
      vehicle_number: t.vehicleNumber,
      driver_id: null,
      driver_name: t.driverName,
      driver_phone: t.driverPhone,
      customer_name: t.customerName,
      planned_tonnes: null,
      tracking_state: t.status === 'active' ? 'active' : 'ended',
      tracking_started_at: t.createdAt,
      tracking_ended_at: t.endedAt,
      milestones: {},
      route_status: routeStatus.get(t.id) ?? null,
      promised_delivery_at:
        t.deliveryMode === 'appointment' ? t.appointmentTo : t.deliveryReportingAt,
      eway_bill_number: t.ewayBillNumber,
      eway_bill_expires_at: t.ewayBillValidTill,
      origin: place(t.originRefId, t.originName, t.originAddress, t.originCity),
      destination: place(
        t.destinationRefId,
        t.destinationName,
        t.destinationAddress,
        t.destinationCity,
      ),
      created: {
        direction: t.direction,
        status: t.status,
        transporterName: t.transporterName,
        transporterPhone: t.transporterPhone,
        loadingReportingAt: t.loadingReportingAt,
        appointment:
          t.deliveryMode === 'appointment'
            ? { ref: t.appointmentRef, from: t.appointmentFrom, to: t.appointmentTo }
            : null,
        createdAt: t.createdAt,
      },
    }));
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
      load_title: load.title ?? null,
      load_status: load.status,
      posting_type: load.postingType,
      route: load.route,
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
      eway_bill_number: load.ewayBillNumber ?? null,
      eway_bill_expires_at: load.ewayBillExpiresAt ?? null,
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

  /** The display-only approach leg (first tracked point → loading point), when one was drawn. */
  async approachRoute(tripId: string): Promise<ApproachRouteRow | null> {
    const row = await this.dataSource
      .createQueryBuilder()
      .select(['a.trip_id AS trip_id', 'a.polyline AS polyline'])
      .addSelect('a.distance_m', 'distance_m')
      .addSelect('a.duration_s', 'duration_s')
      .from('tracking.trip_approach_routes', 'a')
      .where('a.trip_id = :tripId', { tripId })
      .andWhere('a.polyline IS NOT NULL')
      .getRawOne<ApproachRouteRow>();
    return row ?? null;
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

  /**
   * The vehicle's own GPS-device fixes since `from`, oldest first, on a trip or not (for the
   * My fleet day stats). Raw points: idle-vehicle points are kept for 7 days, enough for a week.
   */
  async vehicleGpsPoints(vehicleId: string, from: Date): Promise<StatsPoint[]> {
    const rows: Array<{
      recorded_at: Date;
      lat: number;
      lng: number;
      speed_kmh: number | null;
      ignition: string | null;
      battery_pct: string | null;
      device_status: string | null;
    }> = await this.dataSource.query(
      `SELECT recorded_at, lat, lng, speed_kmh, flags->>'ignition' AS ignition,
              flags->>'batteryPct' AS battery_pct, flags->>'deviceStatus' AS device_status
       FROM (
         SELECT recorded_at, lat, lng, speed_kmh, flags FROM tracking.location_points
           WHERE vehicle_id = $1 AND source = 'roadcast' AND recorded_at >= $2
         UNION ALL
         SELECT recorded_at, lat, lng, speed_kmh, flags FROM tracking.location_points_short
           WHERE vehicle_id = $1 AND source = 'roadcast' AND recorded_at >= $2
             AND NOT (coalesce(flags, '{}'::jsonb) ? 'rejected')
       ) pts
       ORDER BY recorded_at`,
      [vehicleId, from],
    );
    const num = (v: string | null) =>
      v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
    return rows.map((r) => ({
      at: new Date(r.recorded_at).getTime(),
      lat: Number(r.lat),
      lng: Number(r.lng),
      speedKmh: r.speed_kmh === null ? null : Number(r.speed_kmh),
      ignition: r.ignition === 'true' ? true : r.ignition === 'false' ? false : null,
      batteryPct: num(r.battery_pct),
      deviceStatus: r.device_status,
    }));
  }

  private featuresPromise: Promise<DbFeatures> | null = null;
  private features(): Promise<DbFeatures> {
    this.featuresPromise ??= detectFeatures(this.dataSource);
    return this.featuresPromise;
  }
}

/** TypeORM `where` fragment limiting created trips to the caller's tenant. */
function tenantWhere(scope: TenantScope): { tenantId?: string } {
  return 'allTenants' in scope ? {} : { tenantId: scope.tenantId };
}

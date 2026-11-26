import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { detectFeatures, DbFeatures } from '../../db/db-features';
import { encodePolyline, simplifyPolyline } from '../routes/route-geometry';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { PointSource } from '../points';
import { FastagCrossingRepository, type CrossingRow } from '../ingest-ulip';
import { MainDataRepository, MainLoad, MainVehicle } from '../main-data';
import { ACTIVE_STATUSES, LoadStatus, trackingStateFor } from '../trips';
import type { StatsPoint } from './vehicle-stats';
import {
  isRunningTrip,
  RUNNING_TRIP_STATUSES,
  TrackingTripEntity,
  TripStatus,
} from './trip.entity';
import type { TripListState } from './tracking-api.validators';

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
  /** How the truck is tracked (gps | driver_app | sim | fastag), as decided on the load / trip. */
  tracking_source: string | null;
  lr_number: string | null;
  /** The registry (VAHAN) has verified the truck. */
  vehicle_verified: boolean;
  /** The trip's first location point: tracking starts there (null until it arrives). */
  first_ping_at: Date | null;
  /** How an ended trip ended: delivered / closed, or called off. Null while it runs. */
  outcome: 'completed' | 'cancelled' | null;
  /** Only on trips created from the tracking screen (tracking.trips) — absent for load trips. */
  created?: CreatedTripExtras;
}

/** The fields a created (tracking-only) trip has beyond a load trip's. */
export interface CreatedTripExtras {
  direction: 'in' | 'out' | null;
  status: TripStatus;
  customerId: string | null;
  transporterName: string | null;
  transporterPhone: string | null;
  /** The driver's licence as saved (Edit tracking opens on it). */
  driverLicenceNumber: string | null;
  driverDateOfBirth: string | null;
  dlStatus: string | null;
  loadingReportingAt: Date | null;
  appointment: { ref: string | null; from: Date | null; to: Date | null } | null;
  arrivedPickupAt: Date | null;
  departedPickupAt: Date | null;
  arrivedDropAt: Date | null;
  createdAt: Date;
}

/** What Edit tracking changes on a created trip (TrackingApiService.updateTrip). */
/** A driver number change saved with Edit tracking (tracking.trip_driver_changes). */
export interface DriverChangeInput {
  tenantId: string;
  fromPhone: string;
  toPhone: string;
  fromName: string | null;
  toName: string | null;
  changedBy: string | null;
}

export interface DriverChangeRow {
  changed_at: Date;
  from_phone: string;
  to_phone: string;
  from_name: string | null;
  to_name: string | null;
  /** The truck's last point at or before the change; null before the first ping. */
  lat: number | null;
  lng: number | null;
  recorded_at: Date | null;
}

export type CreatedTripPatch = Partial<
  Pick<
    TrackingTripEntity,
    | 'vehicleNumber'
    | 'driverPhone'
    | 'driverName'
    | 'driverLicenceNumber'
    | 'driverDateOfBirth'
    | 'dlStatus'
    | 'dlFrontKey'
    | 'dlBackKey'
    | 'ewayBillNumber'
    | 'ewayBillValidTill'
    | 'vehicleId'
    | 'ownFleet'
    | 'driverId'
    | 'trackingSource'
    | 'vahanStatus'
    | 'rcKey'
    | 'destinationKind'
    | 'destinationRefId'
    | 'destinationName'
    | 'destinationAddress'
    | 'destinationCity'
    | 'destinationLat'
    | 'destinationLng'
    | 'lrNumber'
  >
>;

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
const CREATED_TRIP_STATUSES: Record<TripListState, TripStatus[]> = {
  pending: [],
  active: [...RUNNING_TRIP_STATUSES],
  completed: ['completed'],
  cancelled: ['cancelled'],
  ended: ['completed', 'cancelled'],
};
const CREATED_TRIP_CODE_PREFIX = 'TRP-';
// Postgres unique_violation — two creates in one tenant raced for the same code.
const UNIQUE_VIOLATION = '23505';
/** One active trip per truck, and per driver number, in a tenant (migration 1759790000000). */
const ACTIVE_TRIP_INDEXES = ['trips_active_truck_uq', 'trips_active_driver_uq'];

/** The save hit a one-active-trip-per-truck / per-driver index (two creates raced). */
export function isActiveTruckConflict(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string; constraint?: string } | undefined)?.code ===
      UNIQUE_VIOLATION &&
    ACTIVE_TRIP_INDEXES.includes((error.driverError as { constraint?: string }).constraint ?? '')
  );
}
const ENDED_STATUSES: readonly LoadStatus[] = [
  'delivered_ok',
  'delivered_with_issues',
  'invoice_generated',
  'payment',
  'closed',
];
/** Load statuses per list state (cancelled loads only show under Cancelled / Ended). */
const LOAD_LIST_STATUSES: Record<TripListState, readonly LoadStatus[]> = {
  pending: PENDING_STATUSES,
  active: ACTIVE_STATUSES,
  completed: ENDED_STATUSES,
  cancelled: ['cancelled'],
  ended: [...ENDED_STATUSES, 'cancelled'],
};

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
    const [loads, created] = await Promise.all([
      this.mainData.activeLoads(),
      this.mainData.activeCreatedTrips(),
    ]);
    for (const load of [...loads, ...created]) {
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
  async listTrips(scope: TenantScope, state: TripListState, limit: number): Promise<TripRow[]> {
    const statuses = LOAD_LIST_STATUSES[state];
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

  /** How a created trip's truck will be tracked (vehicle id, driver account, source). */
  truckTracking(tenantId: string, vehicleNumber: string, driverPhone: string | null) {
    return this.mainData.truckTracking(tenantId, vehicleNumber, driverPhone);
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
        if (!duplicate || isActiveTruckConflict(error) || attempt >= 3) throw error;
      }
    }
  }

  /** The tenant's running trip with this truck and driver number (one at a time), if any. */
  activeTripOnTruck(
    tenantId: string,
    vehicleNumber: string,
    driverPhone: string,
    exceptId?: string,
  ) {
    return this.mainData.activeTripOnTruck(tenantId, vehicleNumber, driverPhone, exceptId);
  }

  /** A picked master place's coordinates (a delivery point's own, else its geocode cache). */
  async placeCoordinates(
    kind: 'loading_point' | 'customer_address',
    id: string,
  ): Promise<{ lat: number; lng: number } | null> {
    const places = await this.mainData.places(
      kind === 'loading_point' ? [id] : [],
      kind === 'customer_address' ? [id] : [],
    );
    const place = places.get(id);
    return place?.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;
  }

  /** The caller's active created trip by id (what Edit tracking may change), else null. */
  findActiveCreatedTrip(scope: TenantScope, id: string): Promise<TrackingTripEntity | null> {
    return this.createdTrips.findOne({
      where: { id, status: In([...RUNNING_TRIP_STATUSES]), ...tenantWhere(scope) },
    });
  }

  /**
   * Saves Edit tracking's changes on an active created trip, and the driver change with them when
   * the number changed (one transaction); null if it is no longer active.
   */
  async updateCreatedTrip(
    scope: TenantScope,
    id: string,
    patch: CreatedTripPatch,
    driverChange?: DriverChangeInput,
  ): Promise<TripRow | null> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const result = await manager
        .getRepository(TrackingTripEntity)
        .update({ id, status: In([...RUNNING_TRIP_STATUSES]), ...tenantWhere(scope) }, patch);
      if (!result.affected) return false;
      if (driverChange) {
        await manager.query(
          `INSERT INTO tracking.trip_driver_changes
             (tenant_id, trip_id, from_phone, to_phone, from_name, to_name, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            driverChange.tenantId,
            id,
            driverChange.fromPhone,
            driverChange.toPhone,
            driverChange.fromName,
            driverChange.toName,
            driverChange.changedBy,
          ],
        );
      }
      return true;
    });
    if (!saved) return null;
    const trip = await this.createdTrips.findOneByOrFail({ id });
    return (await this.toCreatedTripRows([trip]))[0];
  }

  /** Each trip's first location point (the first ping), via the (trip_id, recorded_at) index. */
  private async firstPings(tripIds: string[]): Promise<Map<string, Date>> {
    if (tripIds.length === 0) return new Map();
    const rows: Array<{ trip_id: string; recorded_at: Date }> = await this.dataSource.query(
      `SELECT t.id AS trip_id, p.recorded_at
       FROM unnest($1::uuid[]) AS t(id)
       JOIN LATERAL (
         SELECT recorded_at FROM tracking.location_points
         WHERE trip_id = t.id ORDER BY recorded_at LIMIT 1
       ) p ON true`,
      [tripIds],
    );
    return new Map(rows.map((r) => [r.trip_id, new Date(r.recorded_at)]));
  }

  /** Ends an active created trip; null when it isn't one of the caller's created trips or has
   *  already ended. */
  async endCreatedTrip(
    scope: TenantScope,
    id: string,
    status: 'completed' | 'cancelled',
  ): Promise<TripRow | null> {
    const result = await this.createdTrips.update(
      { id, status: In([...RUNNING_TRIP_STATUSES]), ...tenantWhere(scope) },
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
    const [masters, statusRows, firstPings, fleetVerified] = await Promise.all([
      this.mainData.places(refsOf('loading_point'), refsOf('customer_address')),
      this.dataSource
        .createQueryBuilder()
        .select(['s.trip_id AS trip_id', 's.status AS status'])
        .from('tracking.trip_route_status', 's')
        .where('s.trip_id IN (:...ids)', { ids: trips.map((t) => t.id) })
        .getRawMany<{ trip_id: string; status: string }>(),
      this.firstPings(trips.map((t) => t.id)),
      // A fleet truck verified in the vehicle master counts even if Create trip's check didn't run.
      this.mainData.vahanVerified(
        trips.map((t) => ({ id: t.id, vehicleId: t.vehicleId, ownFleet: t.ownFleet })),
      ),
    ]);
    // Route planning (RoutePlanner) covers created trips too: no_api_key, not_found, ok, ...
    const routeStatus = new Map(statusRows.map((r) => [r.trip_id, r.status]));
    const place = (
      refId: string | null,
      name: string,
      address: string,
      city: string | null,
      saved: { lat: number | null; lng: number | null },
    ): PlaceRow => {
      const master = refId ? masters.get(refId) : undefined;
      // The master's current pin wins; else where the trip saved the place (a geocoded address).
      const at =
        master?.lat != null && master.lng != null
          ? { lat: master.lat, lng: master.lng }
          : saved.lat !== null && saved.lng !== null
            ? { lat: Number(saved.lat), lng: Number(saved.lng) }
            : { lat: null, lng: null };
      return { id: refId ?? '', name, city: city ?? master?.city ?? null, address, ...at };
    };
    return trips.map((t) => ({
      id: t.id,
      tenant_id: t.tenantId,
      load_code: t.code,
      load_title: null,
      load_status: t.status,
      posting_type: 'tracking_only',
      route: null,
      vehicle_id: t.vehicleId,
      vehicle_number: t.vehicleNumber,
      driver_id: t.driverId,
      driver_name: t.driverName,
      driver_phone: t.driverPhone,
      customer_name: t.customerName,
      planned_tonnes: null,
      tracking_state: isRunningTrip(t.status) ? 'active' : 'ended',
      // Tracking starts with the first ping, not when the trip was saved.
      tracking_started_at: firstPings.get(t.id) ?? null,
      tracking_ended_at: t.endedAt,
      milestones: {},
      route_status: routeStatus.get(t.id) ?? null,
      promised_delivery_at:
        t.deliveryMode === 'appointment' ? t.appointmentTo : t.deliveryReportingAt,
      eway_bill_number: t.ewayBillNumber,
      eway_bill_expires_at: t.ewayBillValidTill,
      origin: place(t.originRefId, t.originName, t.originAddress, t.originCity, {
        lat: t.originLat,
        lng: t.originLng,
      }),
      destination: place(
        t.destinationRefId,
        t.destinationName,
        t.destinationAddress,
        t.destinationCity,
        { lat: t.destinationLat, lng: t.destinationLng },
      ),
      tracking_source: t.trackingSource,
      lr_number: t.lrNumber,
      // Create trip's own check when it ran, else the fleet vehicle's master record.
      vehicle_verified: t.vahanStatus ? t.vahanStatus === 'verified' : fleetVerified.has(t.id),
      first_ping_at: firstPings.get(t.id) ?? null,
      outcome: isRunningTrip(t.status)
        ? null
        : t.status === 'cancelled'
          ? 'cancelled'
          : 'completed',
      created: {
        direction: t.direction,
        status: t.status,
        customerId: t.customerId,
        transporterName: t.transporterName,
        transporterPhone: t.transporterPhone,
        driverLicenceNumber: t.driverLicenceNumber,
        driverDateOfBirth: t.driverDateOfBirth,
        dlStatus: t.dlStatus,
        loadingReportingAt: t.loadingReportingAt,
        appointment:
          t.deliveryMode === 'appointment'
            ? { ref: t.appointmentRef, from: t.appointmentFrom, to: t.appointmentTo }
            : null,
        arrivedPickupAt: t.arrivedPickupAt,
        departedPickupAt: t.departedPickupAt,
        arrivedDropAt: t.arrivedDropAt,
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
    const [firstPings, verified] = await Promise.all([
      this.firstPings(loads.map((l) => l.id)),
      this.mainData.vahanVerified(
        loads.map((l) => ({
          id: l.id,
          vehicleId: l.vehicleId,
          ownFleet: l.postingType === 'own_fleet',
        })),
      ),
    ]);
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
      // Tracking starts with the first ping, not when the truck was assigned.
      tracking_started_at: firstPings.get(load.id) ?? null,
      tracking_ended_at: load.endedAt,
      milestones: load.milestones,
      route_status: routeStatus.get(load.id) ?? null,
      promised_delivery_at: load.promisedDeliveryAt,
      eway_bill_number: load.ewayBillNumber ?? null,
      eway_bill_expires_at: load.ewayBillExpiresAt ?? null,
      origin: place(load.loadingPointId),
      destination: place(load.deliveryPointId),
      tracking_source: load.trackingSource,
      lr_number: load.lrNumber ?? null,
      vehicle_verified: verified.has(load.id),
      first_ping_at: firstPings.get(load.id) ?? null,
      outcome:
        load.status === 'cancelled'
          ? 'cancelled'
          : ENDED_STATUSES.includes(load.status)
            ? 'completed'
            : null,
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

  /**
   * The trip's driver number changes, oldest first, each with the truck's last accepted point at
   * or before the change (null when it had not reported yet).
   */
  driverChanges(tripId: string): Promise<DriverChangeRow[]> {
    return this.dataSource.query(
      `SELECT c.changed_at, c.from_phone, c.to_phone, c.from_name, c.to_name,
              p.lat, p.lng, p.recorded_at
       FROM tracking.trip_driver_changes c
       LEFT JOIN LATERAL (
         SELECT lat, lng, recorded_at FROM tracking.location_points
         WHERE trip_id = c.trip_id AND recorded_at <= c.changed_at
           AND NOT (coalesce(flags, '{}'::jsonb) ? 'rejected')
         ORDER BY recorded_at DESC LIMIT 1
       ) p ON true
       WHERE c.trip_id = $1
       ORDER BY c.changed_at`,
      [tripId],
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

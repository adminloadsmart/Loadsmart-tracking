import { DataSource, In, IsNull, Not } from 'typeorm';
import type { TenantScope } from '../../shared/auth/staff-token';
import { decodePolyline } from '../routes/route-geometry';
import { TrackingTripEntity } from '../tracking-api/trip.entity';
import {
  ACTIVE_STATUSES,
  AFTER_DELIVERY_STATUSES,
  createdTripLoadStatus,
  DELIVERED_FOLLOW_MS,
  INDEXED_STATUSES,
  initialTrackingSource,
  LoadStatus,
  marketVehicleId,
  normalizePlate,
} from '../trips/trip-state';

/**
 * The ONLY code in this service that knows the main loadsmart backend's tables. The tracking
 * service shares the main database and reads loads, vehicles and places directly — it never
 * copies them. Read-only, and it uses only columns present in every live schema version of main
 * (local and staging differ, e.g. driver tenancy), so a main migration has one place to land here.
 */

/** loads.loads_posting_type_enum in the main backend (replaced source_type). */
export const LOAD_POSTING_TYPES = ['market_fleet', 'indent', 'own_fleet'] as const;
export type LoadPostingType = (typeof LOAD_POSTING_TYPES)[number];
/** loads.loads_route_enum: who carries the load. */
export const LOAD_ROUTES = ['loadsmart', 'own_transporter', 'indent', 'own_fleet'] as const;
export type LoadRoute = (typeof LOAD_ROUTES)[number];

/** loads.loads_tracking_source_enum in the main backend. */
export const LOAD_TRACKING_SOURCES = ['gps', 'driver_app', 'sim', 'fastag'] as const;
export type LoadTrackingSource = (typeof LOAD_TRACKING_SOURCES)[number];

export interface MainLoad {
  id: string;
  tenantId: string;
  code: string;
  /** Optional title given when the load was posted; the code stands in when it is missing. */
  title?: string | null;
  status: LoadStatus;
  /** How the shipper posted the load (loads.posting_type in the main backend). */
  postingType: LoadPostingType;
  /** Who carries it; null until someone wins a market load (loads.route). */
  route: LoadRoute | null;
  /** Tracking's vehicle id: the fleet vehicle, or a stable id derived from a market truck's plate. */
  vehicleId: string | null;
  vehicleNumber: string | null;
  /** The fleet vehicle's GPS device IMEI (Roadcast), if one is on file. */
  deviceImei: string | null;
  driverId: string | null;
  driverName: string | null;
  driverNumber: string | null;
  loadingPointId: string | null;
  deliveryPointId: string | null;
  customerId: string | null;
  customerName: string | null;
  /** Load's planned capacity in tonnes (the "24 MT" on the tracking screen). */
  plannedTonnes: number | null;
  /** Requisition's expected delivery date, end of day India time. */
  promisedDeliveryAt: Date | null;
  /** The load's e-way bill and when it expires (loads.eway_bill_*), shown on the control tower. */
  ewayBillNumber?: string | null;
  ewayBillExpiresAt?: Date | null;
  /** Tracking runs from loading confirmation… */
  startedAt: Date | null;
  /** …to delivery (or close). */
  endedAt: Date | null;
  /** loads.loads.tracking_source — how the backend says this truck is tracked (null = unset). */
  trackingSource: LoadTrackingSource | null;
  /** E-POD uploaded; a delivered load stays indexed until its truck leaves the drop (isIndexed). */
  deliveredAt: Date | null;
  /** loads.pod_status: the E-POD's review (null until one is uploaded). SIM tracking stops at 'accepted'. */
  podStatus: 'pending' | 'accepted' | 'rejected' | null;
  /** When the truck left the delivery point's geofence (the main backend records trip.departed_drop). */
  departedDropAt: Date | null;
  milestones: Record<string, string | null>;
  updatedAt: Date;
  /** A trip created from the tracking screen (tracking.trips), not a load: it has no stages, POD
   *  or main-backend workflow, only a vehicle, a driver number and its two places. */
  createdTrip?: boolean;
}

/** How a truck entered on Create trip is tracked (see MainDataRepository.truckTracking). */
export interface TruckTracking {
  vehicleId: string;
  ownFleet: boolean;
  driverId: string | null;
  trackingSource: LoadTrackingSource | null;
}

export interface MainVehicle {
  id: string;
  tenantId: string;
  kind: 'fleet' | 'market';
  registrationNumber: string;
  /** Truck type's body type (e.g. 'tanker'), else the vehicle's own. */
  bodyType: string | null;
  gpsProvider: string | null;
  gpsEnabled: boolean;
}

export interface MainGpsDeviceBinding {
  imei: string;
  vehicleId: string;
  tenantId: string;
}

export interface MainGeofence {
  id: string;
  tenantId: string;
  name: string;
  /** yard | loading_point | unloading_point | fuel_pump | no_go_area */
  type: string;
  shape: 'circle' | 'polygon';
  lat: number;
  lng: number;
  radiusM: number | null;
  polygon: Array<{ lat: number; lng: number }> | null;
  appliesToAllVehicles: boolean;
  vehicleIds: string[];
  loadingPointId: string | null;
  customerDeliveryPointId: string | null;
}

interface GeofenceRow {
  id: string;
  tenant_id: string;
  name: string;
  type: string;
  shape: string;
  latitude: string;
  longitude: string;
  radius_m: number | null;
  polygon: Array<{ latitude: number; longitude: number }> | null;
  applies_to_all_vehicles: boolean;
  loading_point_id: string | null;
  customer_delivery_point_id: string | null;
  vehicle_ids: string[];
}

export interface MainTripPoints {
  vehicleNumber: string | null;
  pickupLoadingPointId: string | null;
  dropCustomerDeliveryPointId: string | null;
  /** A posted load with no customer drops at one of the shipper's own loading points. */
  dropLoadingPointId: string | null;
  /** Only an inbound trip created from the tracking screen starts at a customer address. */
  pickupCustomerDeliveryPointId?: string | null;
}

export interface MainPlace {
  id: string;
  kind: 'loading_point' | 'delivery_point';
  name: string;
  city: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

interface LoadRow {
  id: string;
  tenant_id: string;
  code: string;
  title: string | null;
  status: LoadStatus;
  posting_type: LoadPostingType;
  route: LoadRoute | null;
  vehicle_id: string | null;
  vehicle_number: string | null;
  device_imei: string | null;
  tracking_source: string | null;
  driver_id: string | null;
  driver_name: string | null;
  driver_number: string | null;
  loading_point_id: string | null;
  delivery_point_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  planned_tonnes: string | number | null;
  promised_delivery_at: Date | null;
  eway_bill_number: string | null;
  eway_bill_expires_at: Date | null;
  truck_assigned_at: Date | null;
  loading_confirmed_at: Date | null;
  at_plant_at: Date | null;
  in_transit_at: Date | null;
  reached_delivery_point_at: Date | null;
  delivered_at: Date | null;
  pod_status: string | null;
  departed_drop_at: Date | null;
  closed_at: Date | null;
  updated_at: Date;
}

/** Columns main adds by migration — absent on a main database that hasn't run them yet. */
interface LoadColumns {
  trackingSource: boolean;
  departedDrop: boolean;
}

const loadSelect = (columns: LoadColumns) => `
  SELECT l.id, l.tenant_id, l.code, NULLIF(btrim(l.title), '') AS title, l.status::text AS status, l.posting_type::text AS posting_type,
         l.route::text AS route,
         l.vehicle_id, l.vehicle_number, l.driver_id,
         COALESCE(NULLIF(btrim(l.driver_name), ''), d.full_name, dp.full_name) AS driver_name,
         l.driver_number,
         NULLIF(btrim(tm.gps_device_imei), '') AS device_imei,
         ${columns.trackingSource ? 'l.tracking_source::text' : 'NULL::text'} AS tracking_source,
         COALESCE(r.loading_point_id, p.pickup_loading_point_id) AS loading_point_id,
         COALESCE(r.customer_delivery_point_id, p.drop_customer_delivery_point_id)
           AS delivery_point_id,
         COALESCE(r.customer_id, p.customer_id) AS customer_id,
         c.name AS customer_name, l.planned_capacity_tonnes AS planned_tonnes,
         COALESCE(
           ((r.expected_delivery_date::timestamp + time '23:59') AT TIME ZONE 'Asia/Kolkata'),
           p.deliver_by_at
         ) AS promised_delivery_at,
         NULLIF(btrim(l.eway_bill_number), '') AS eway_bill_number, l.eway_bill_expires_at,
         l.truck_assigned_at, l.loading_confirmed_at, l.at_plant_at, l.in_transit_at,
         l.reached_delivery_point_at,
         l.delivered_at, l.pod_status::text AS pod_status, ${columns.departedDrop ? 'l.departed_drop_at' : 'NULL::timestamptz'} AS departed_drop_at,
         l.closed_at, l.updated_at
  FROM loads.loads l
  LEFT JOIN loads.requisitions r ON r.id = l.requisition_id
  LEFT JOIN loads.load_postings p ON p.id = l.posting_id
  LEFT JOIN customers.customers c ON c.id = COALESCE(r.customer_id, p.customer_id)
  -- The load's own driver name can be blank (e.g. a market truck entered by phone only): fall back
  -- to the driver profile, by id, else by the phone number on the load.
  LEFT JOIN masters.drivers d ON d.id = l.driver_id AND d.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT dr.full_name FROM masters.drivers dr
    WHERE l.driver_id IS NULL AND dr.deleted_at IS NULL
      AND dr.phone_number = right(regexp_replace(l.driver_number, '\\D', '', 'g'), 10)
    ORDER BY dr.created_at LIMIT 1
  ) dp ON true
  LEFT JOIN masters.vehicle_telemetry_meta tm
    ON tm.vehicle_id = l.vehicle_id AND tm.deleted_at IS NULL AND l.posting_type = 'own_fleet'`;

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

function toTrackingSource(value: string | null): LoadTrackingSource | null {
  return (LOAD_TRACKING_SOURCES as readonly string[]).includes(value ?? '')
    ? (value as LoadTrackingSource)
    : null;
}

function toLoad(row: LoadRow): MainLoad {
  const vehicleId =
    row.posting_type === 'own_fleet'
      ? row.vehicle_id
      : row.vehicle_number?.trim()
        ? marketVehicleId(row.tenant_id, row.vehicle_number)
        : null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    title: row.title,
    status: row.status,
    postingType: row.posting_type,
    route: row.route,
    vehicleId,
    vehicleNumber: row.vehicle_number ? normalizePlate(row.vehicle_number) : null,
    deviceImei: row.device_imei,
    trackingSource: toTrackingSource(row.tracking_source),
    driverId: row.driver_id,
    driverName: row.driver_name,
    driverNumber: row.driver_number,
    loadingPointId: row.loading_point_id,
    deliveryPointId: row.delivery_point_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    plannedTonnes: row.planned_tonnes === null ? null : Number(row.planned_tonnes),
    promisedDeliveryAt: row.promised_delivery_at,
    ewayBillNumber: row.eway_bill_number,
    ewayBillExpiresAt: row.eway_bill_expires_at,
    startedAt: row.truck_assigned_at ?? row.at_plant_at ?? row.loading_confirmed_at,
    endedAt: row.delivered_at ?? row.closed_at,
    deliveredAt: row.delivered_at,
    podStatus:
      row.pod_status === 'pending' || row.pod_status === 'accepted' || row.pod_status === 'rejected'
        ? row.pod_status
        : null,
    departedDropAt: row.departed_drop_at,
    milestones: {
      loadingConfirmedAt: iso(row.loading_confirmed_at),
      atPlantAt: iso(row.at_plant_at),
      inTransitAt: iso(row.in_transit_at),
      reachedDeliveryPointAt: iso(row.reached_delivery_point_at),
      deliveredAt: iso(row.delivered_at),
    },
    updatedAt: row.updated_at,
  };
}

/** A 10-digit Indian mobile number (a leading 91 / 0 dropped), else null — what Intugine takes. */
function nationalMobile(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  const national = digits.length > 10 ? digits.replace(/^(91|0)/, '') : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

/** A trip created from the tracking screen, in the load shape the trip watcher, the SIM
 *  lifecycle and the rules read. `deviceImei` is the fleet vehicle's GPS device, when it has one. */
function createdTripToLoad(trip: TrackingTripEntity, deviceImei: string | null): MainLoad {
  const ref = (kind: TrackingTripEntity['originKind'], wanted: TrackingTripEntity['originKind'], id: string | null) =>
    kind === wanted ? id : null;
  return {
    id: trip.id,
    tenantId: trip.tenantId,
    code: trip.code,
    title: null,
    status: createdTripLoadStatus(trip.status),
    // A truck that isn't in the fleet is tracked like a market truck (its plate's vehicle id).
    postingType: trip.ownFleet ? 'own_fleet' : 'market_fleet',
    route: null,
    vehicleId: trip.vehicleId,
    vehicleNumber: normalizePlate(trip.vehicleNumber),
    deviceImei,
    driverId: trip.driverId,
    driverName: trip.driverName,
    driverNumber: trip.driverPhone,
    loadingPointId: ref(trip.originKind, 'loading_point', trip.originRefId),
    deliveryPointId: ref(trip.destinationKind, 'customer_address', trip.destinationRefId),
    customerId: trip.customerId,
    customerName: trip.customerName,
    plannedTonnes: null,
    promisedDeliveryAt:
      trip.deliveryMode === 'appointment' ? trip.appointmentTo : trip.deliveryReportingAt,
    ewayBillNumber: trip.ewayBillNumber,
    ewayBillExpiresAt: trip.ewayBillValidTill,
    // Tracked from the moment it is created until it is ended or cancelled.
    startedAt: trip.createdAt,
    endedAt: trip.endedAt,
    trackingSource: trip.trackingSource,
    deliveredAt: null,
    podStatus: null,
    departedDropAt: null,
    milestones: {},
    updatedAt: trip.updatedAt,
    createdTrip: true,
  };
}

/** `AND <column> = $n` for a tenant-scoped caller, nothing for platform admins. */
function scoped(scope: TenantScope | null, column: string, params: unknown[]): string {
  if (!scope || 'allTenants' in scope) return '';
  params.push(scope.tenantId);
  return ` AND ${column} = $${params.length}`;
}

export class MainDataRepository {
  private loadColumns?: Promise<LoadColumns>;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * The loads SELECT. loads.tracking_source and loads.departed_drop_at arrive with main
   * migrations — until they have run, select NULL instead, so tracking keeps working (it picks
   * its own source order, and a delivered load isn't followed to the drop's exit).
   */
  private async select(): Promise<string> {
    return loadSelect(await this.columns());
  }

  private async columns(): Promise<LoadColumns> {
    this.loadColumns ??= this.dataSource
      .query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'loads' AND table_name = 'loads'
           AND column_name IN ('tracking_source', 'departed_drop_at')`,
      )
      .then((rows: Array<{ column_name: string }>) => {
        const names = new Set(rows.map((row) => row.column_name));
        return {
          trackingSource: names.has('tracking_source'),
          departedDrop: names.has('departed_drop_at'),
        };
      });
    try {
      const columns = await this.loadColumns;
      // look again once main migrates
      if (!columns.trackingSource || !columns.departedDrop) this.loadColumns = undefined;
      return columns;
    } catch (err) {
      this.loadColumns = undefined;
      throw err;
    }
  }

  // ---- loads (= trips) ---------------------------------------------------------------------

  /**
   * Loads changed since `since` (any status), oldest first — the trip watcher's feed. Pass the
   * last row of the previous page as `after` to page on (updated_at, id): many loads can share
   * one updated_at (a bulk update), so paging on updated_at alone could repeat a page forever.
   * The page key is truncated to milliseconds — the precision `after.updatedAt` (a JS Date)
   * carries back; comparing against microsecond values would re-match the same rows.
   */
  async loadsChangedSince(
    since: Date,
    limit: number,
    after?: { updatedAt: Date; id: string },
  ): Promise<MainLoad[]> {
    const pageKey = `date_trunc('milliseconds', l.updated_at)`;
    const rows: LoadRow[] = after
      ? await this.dataSource.query(
          `${await this.select()} WHERE (${pageKey}, l.id) > ($1::timestamptz, $2::uuid)
           ORDER BY ${pageKey}, l.id LIMIT $3`,
          [after.updatedAt, after.id, limit],
        )
      : await this.dataSource.query(
          `${await this.select()} WHERE l.updated_at > $1 ORDER BY ${pageKey}, l.id LIMIT $2`,
          [since, limit],
        );
    return rows.map(toLoad);
  }

  async loadsByStatus(
    scope: TenantScope | null,
    statuses: readonly LoadStatus[],
    limit: number,
  ): Promise<MainLoad[]> {
    const params: unknown[] = [statuses, limit];
    const rows: LoadRow[] = await this.dataSource.query(
      `${await this.select()} WHERE l.status::text = ANY($1::text[])${scoped(scope, 'l.tenant_id', params)}
       ORDER BY COALESCE(l.at_plant_at, l.loading_confirmed_at) DESC NULLS LAST, l.code DESC LIMIT $2`,
      params,
    );
    return rows.map(toLoad);
  }

  activeLoads(scope: TenantScope | null = null, limit = 50_000): Promise<MainLoad[]> {
    return this.loadsByStatus(scope, ACTIVE_STATUSES, limit);
  }

  /** What the active-trip index holds (isIndexed): active loads, approach ones, and delivered
   *  ones whose truck hasn't been seen leaving the delivery point yet (within DELIVERED_FOLLOW_MS
   *  of the E-POD). */
  async indexedLoads(limit = 50_000): Promise<MainLoad[]> {
    const { departedDrop } = await this.columns();
    const rows: LoadRow[] = await this.dataSource.query(
      `${await this.select()}
       WHERE l.status::text = ANY($1::text[])
          OR (l.status::text = ANY($2::text[])${departedDrop ? ' AND l.departed_drop_at IS NULL' : ''}
              AND l.delivered_at > now() - make_interval(secs => $3))
       ORDER BY COALESCE(l.at_plant_at, l.loading_confirmed_at) DESC NULLS LAST, l.code DESC
       LIMIT $4`,
      [INDEXED_STATUSES, AFTER_DELIVERY_STATUSES, DELIVERED_FOLLOW_MS / 1000, limit],
    );
    return rows.map(toLoad);
  }

  async load(scope: TenantScope | null, id: string): Promise<MainLoad | null> {
    const params: unknown[] = [id];
    const rows: LoadRow[] = await this.dataSource.query(
      `${await this.select()} WHERE l.id = $1${scoped(scope, 'l.tenant_id', params)}`,
      params,
    );
    return rows[0] ? toLoad(rows[0]) : null;
  }

  /** A trip by id: a load, else a trip created from the tracking screen (in the load shape). */
  async trip(scope: TenantScope | null, id: string): Promise<MainLoad | null> {
    const load = await this.load(scope, id);
    if (load) return load;
    const created = await this.createdTrips().findOne({
      where: {
        id,
        ...(scope && !('allTenants' in scope) ? { tenantId: scope.tenantId } : {}),
      },
    });
    return created ? (await this.createdTripsToLoads([created]))[0] : null;
  }

  /**
   * For each timestamp, the driver's load (in these tenants, or any market / indent load naming
   * them) whose window covers it — from the
   * truck being assigned (the drive to the plant) to delivery. Places an offline batch flushed
   * after its trip ended. One round trip per batch.
   */
  async driverLoadsAt(
    driverId: string,
    tenantIds: string[],
    recordedAts: string[],
    graceMinutes: number,
  ): Promise<Array<{ recordedAt: string; load: MainLoad }>> {
    if (recordedAts.length === 0) return [];
    const rows: Array<LoadRow & { recorded_at: string }> = await this.dataSource.query(
      `SELECT pt.recorded_at, t.*
       FROM unnest($3::text[]) AS pt(recorded_at)
       JOIN LATERAL (
         ${await this.select()}
         WHERE l.driver_id = $1
           -- A market / indent driver is outside the shipper's tenant; the load naming them is enough.
           AND (l.tenant_id = ANY($2::uuid[]) OR l.posting_type::text <> 'own_fleet')
           AND COALESCE(l.truck_assigned_at, l.in_transit_loading_at, l.at_plant_at,
                        l.loading_confirmed_at) - make_interval(mins => $4)
                 <= pt.recorded_at::timestamptz
           AND COALESCE(l.delivered_at, l.closed_at, 'infinity') >= pt.recorded_at::timestamptz
         ORDER BY COALESCE(l.truck_assigned_at, l.in_transit_loading_at, l.at_plant_at,
                           l.loading_confirmed_at) DESC
         LIMIT 1
       ) t ON true`,
      [driverId, tenantIds, recordedAts, graceMinutes],
    );
    return rows.map((row) => ({ recordedAt: row.recorded_at, load: toLoad(row) }));
  }

  // ---- vehicles ----------------------------------------------------------------------------

  private vehicleSelect(): string {
    return `SELECT v.id, v.tenant_id, v.registration_number,
                   COALESCE(tt.body_type::text, v.body_type::text) AS body_type,
                   m.gps_provider, COALESCE(m.gps_enabled, false) AS gps_enabled
            FROM masters.vehicles v
            LEFT JOIN masters.truck_types tt ON tt.id = v.truck_type_id
            LEFT JOIN masters.vehicle_telemetry_meta m ON m.vehicle_id = v.id AND m.deleted_at IS NULL`;
  }

  private toVehicle(row: Record<string, unknown>): MainVehicle {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      kind: 'fleet',
      registrationNumber: String(row.registration_number),
      bodyType: (row.body_type as string | null) ?? null,
      gpsProvider: (row.gps_provider as string | null) ?? null,
      gpsEnabled: Boolean(row.gps_enabled),
    };
  }

  /** Fleet vehicles plus market trucks currently on an active load. */
  async vehicles(scope: TenantScope, limit: number): Promise<MainVehicle[]> {
    const params: unknown[] = [limit];
    const rows = await this.dataSource.query(
      `${this.vehicleSelect()} WHERE v.deleted_at IS NULL${scoped(scope, 'v.tenant_id', params)}
       ORDER BY v.registration_number LIMIT $1`,
      params,
    );
    const fleet = rows.map((row: Record<string, unknown>) => this.toVehicle(row));
    return [...fleet, ...(await this.marketTrucks(scope))];
  }

  async vehicle(scope: TenantScope, id: string): Promise<MainVehicle | null> {
    const params: unknown[] = [id];
    const rows = await this.dataSource.query(
      `${this.vehicleSelect()} WHERE v.id = $1 AND v.deleted_at IS NULL${scoped(scope, 'v.tenant_id', params)}`,
      params,
    );
    if (rows[0]) return this.toVehicle(rows[0]);
    return (await this.marketTrucks(scope)).find((truck) => truck.id === id) ?? null;
  }

  /** Body type per fleet vehicle (tanker → lower speed limit, stricter inactivity rule). */
  async bodyTypes(vehicleIds: string[]): Promise<Map<string, string | null>> {
    if (vehicleIds.length === 0) return new Map();
    const rows: Array<{ id: string; body_type: string | null }> = await this.dataSource.query(
      `SELECT v.id, COALESCE(tt.body_type::text, v.body_type::text) AS body_type
       FROM masters.vehicles v LEFT JOIN masters.truck_types tt ON tt.id = v.truck_type_id
       WHERE v.id = ANY($1::uuid[])`,
      [vehicleIds],
    );
    return new Map(rows.map((row) => [row.id, row.body_type]));
  }

  /**
   * Every fleet vehicle with a GPS device IMEI on file — the devices the Roadcast poller pulls.
   * An IMEI entered on two vehicles goes to the most recently edited one — decided across all
   * orgs before `slot` narrows the result, so an org never gets another org's device.
   *
   * `slot` returns only the orgs in one of `slots` fixed buckets (by tenant id hash), so a caller
   * can visit every org once per `slots` calls without reading every org's devices each time.
   */
  async gpsDeviceBindings(slot?: { slot: number; slots: number }): Promise<MainGpsDeviceBinding[]> {
    const rows: Array<{ imei: string; vehicle_id: string; tenant_id: string }> =
      await this.dataSource.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (btrim(m.gps_device_imei))
                  btrim(m.gps_device_imei) AS imei, v.id AS vehicle_id, v.tenant_id
           FROM masters.vehicle_telemetry_meta m
           JOIN masters.vehicles v ON v.id = m.vehicle_id
           WHERE m.deleted_at IS NULL AND v.deleted_at IS NULL
             AND btrim(COALESCE(m.gps_device_imei, '')) <> ''
           ORDER BY btrim(m.gps_device_imei), m.updated_at DESC
         ) b
         WHERE $1::int IS NULL
            OR mod(hashtext(b.tenant_id::text)::bigint + 2147483648, $2::int) = $1::int`,
        [slot?.slot ?? null, slot?.slots ?? 1],
      );
    return rows.map((row) => ({
      imei: row.imei,
      vehicleId: row.vehicle_id,
      tenantId: row.tenant_id,
    }));
  }

  /** Market trucks aren't in the vehicle master; they exist for tracking only while on a load. */
  private async marketTrucks(scope: TenantScope): Promise<MainVehicle[]> {
    const loads = (await this.activeLoads(scope)).filter(
      (l) => l.postingType !== 'own_fleet' && l.vehicleId,
    );
    const unique = new Map(loads.map((l) => [l.vehicleId!, l]));
    return [...unique.values()].map((l) => ({
      id: l.vehicleId!,
      tenantId: l.tenantId,
      kind: 'market' as const,
      registrationNumber: l.vehicleNumber!,
      bodyType: null,
      gpsProvider: null,
      gpsEnabled: false,
    }));
  }

  // ---- organizations ------------------------------------------------------------------------

  /**
   * The company's LS_N_0030 limit — "late by more than this many minutes" — set by its org admin
   * in main (auth.organizations.late_delivery_threshold_minutes); null when never set — or when
   * main hasn't run the migration that adds the column yet (the caller then uses its default).
   */
  async lateDeliveryThresholdMin(tenantId: string): Promise<number | null> {
    try {
      const rows: Array<{ minutes: number | null }> = await this.dataSource.query(
        `SELECT late_delivery_threshold_minutes AS minutes FROM auth.organizations WHERE id = $1`,
        [tenantId],
      );
      return rows[0]?.minutes ?? null;
    } catch (err) {
      const code = (err as { driverError?: { code?: string } }).driverError?.code;
      if (code === '42703' || code === '42P01') return null; // undefined column / table
      throw err;
    }
  }

  // ---- geofences ---------------------------------------------------------------------------

  /**
   * The tenant's live geofences — created and edited in main (tracking.geofences, its migration
   * CreateGeofences), only read here — with the trucks each one is limited to.
   */
  async geofences(tenantId: string): Promise<MainGeofence[]> {
    const rows: GeofenceRow[] = await this.dataSource.query(
      `SELECT g.id, g.tenant_id, g.name, g.type::text AS type, g.shape::text AS shape,
              g.latitude, g.longitude, g.radius_m, g.polygon, g.applies_to_all_vehicles,
              g.loading_point_id, g.customer_delivery_point_id,
              COALESCE(array_agg(v.vehicle_id) FILTER (WHERE v.vehicle_id IS NOT NULL), '{}')
                AS vehicle_ids
       FROM tracking.geofences g
       LEFT JOIN tracking.geofence_vehicles v ON v.geofence_id = g.id
       WHERE g.tenant_id = $1 AND g.is_active AND g.deleted_at IS NULL
       GROUP BY g.id`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      type: r.type,
      shape: r.shape === 'polygon' ? 'polygon' : 'circle',
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      radiusM: r.radius_m,
      polygon: Array.isArray(r.polygon)
        ? r.polygon.map((p) => ({ lat: Number(p.latitude), lng: Number(p.longitude) }))
        : null,
      appliesToAllVehicles: r.applies_to_all_vehicles,
      vehicleIds: r.vehicle_ids,
      loadingPointId: r.loading_point_id,
      customerDeliveryPointId: r.customer_delivery_point_id,
    }));
  }

  /**
   * Each trip's pickup and drop master points — from its requisition, or from its posting for a
   * posted load — plus the truck's plate. What a geofence's linked point is matched against.
   */
  async tripPoints(loadIds: string[]): Promise<Map<string, MainTripPoints>> {
    if (loadIds.length === 0) return new Map();
    const rows: Array<{
      id: string;
      vehicle_number: string | null;
      pickup_loading_point_id: string | null;
      drop_customer_delivery_point_id: string | null;
      drop_loading_point_id: string | null;
    }> = await this.dataSource.query(
      `SELECT l.id, l.vehicle_number,
              COALESCE(r.loading_point_id, p.pickup_loading_point_id) AS pickup_loading_point_id,
              COALESCE(r.customer_delivery_point_id, p.drop_customer_delivery_point_id)
                AS drop_customer_delivery_point_id,
              p.drop_loading_point_id
       FROM loads.loads l
       LEFT JOIN loads.requisitions r ON r.id = l.requisition_id
       LEFT JOIN loads.load_postings p ON p.id = l.posting_id
       WHERE l.id = ANY($1::uuid[])`,
      [loadIds],
    );
    const points = new Map<string, MainTripPoints>(
      rows.map((r) => [
        r.id,
        {
          vehicleNumber: r.vehicle_number ? normalizePlate(r.vehicle_number) : null,
          pickupLoadingPointId: r.pickup_loading_point_id,
          dropCustomerDeliveryPointId: r.drop_customer_delivery_point_id,
          dropLoadingPointId: r.drop_loading_point_id,
        },
      ]),
    );
    // The rest may be trips created from the tracking screen: their picked master places.
    const missing = loadIds.filter((id) => !points.has(id));
    if (missing.length > 0) {
      for (const t of await this.createdTrips().find({ where: { id: In(missing) } })) {
        points.set(t.id, {
          vehicleNumber: normalizePlate(t.vehicleNumber),
          pickupLoadingPointId: t.originKind === 'loading_point' ? t.originRefId : null,
          pickupCustomerDeliveryPointId:
            t.originKind === 'customer_address' ? t.originRefId : null,
          dropCustomerDeliveryPointId:
            t.destinationKind === 'customer_address' ? t.destinationRefId : null,
          dropLoadingPointId: t.destinationKind === 'loading_point' ? t.destinationRefId : null,
        });
      }
    }
    return points;
  }

  // ---- places ------------------------------------------------------------------------------

  /**
   * Loading points (with coordinates) and customer delivery points (address only in main —
   * coordinates come from tracking's own geocode cache, tracking.place_geocodes).
   */
  async places(
    loadingPointIds: string[],
    deliveryPointIds: string[],
  ): Promise<Map<string, MainPlace>> {
    const places = new Map<string, MainPlace>();
    if (loadingPointIds.length > 0) {
      const rows = await this.dataSource.query(
        `SELECT id, title, city, address_line_1, latitude, longitude
         FROM masters.loading_points WHERE id = ANY($1::uuid[])`,
        [loadingPointIds],
      );
      for (const r of rows) {
        places.set(r.id, {
          id: r.id,
          kind: 'loading_point',
          name: r.title,
          city: r.city,
          address: r.address_line_1,
          lat: r.latitude === null ? null : Number(r.latitude),
          lng: r.longitude === null ? null : Number(r.longitude),
        });
      }
    }
    if (deliveryPointIds.length > 0) {
      const rows = await this.dataSource.query(
        `SELECT d.id, d.location, d.city, d.state, d.pin_code, d.address_line_1, d.address_line_2,
                COALESCE(d.latitude, g.lat) AS lat, COALESCE(d.longitude, g.lng) AS lng
         FROM customers.customer_delivery_points d
         LEFT JOIN tracking.place_geocodes g ON g.place_id = d.id
         WHERE d.id = ANY($1::uuid[])`,
        [deliveryPointIds],
      );
      for (const r of rows) {
        places.set(r.id, {
          id: r.id,
          kind: 'delivery_point',
          name: r.location,
          city: r.city,
          address:
            [r.address_line_1, r.address_line_2, r.city, r.state, r.pin_code]
              .filter(Boolean)
              .join(', ') || null,
          // The point's own coordinates (numeric columns arrive as strings) win over the geocode cache.
          lat: r.lat === null ? null : Number(r.lat),
          lng: r.lng === null ? null : Number(r.lng),
        });
      }
    }
    return places;
  }

  // ---- trips created from the tracking screen ---------------------------------------------
  // tracking.trips is this service's own table; these read it next to main's loads so the trip
  // watcher and the SIM lifecycle treat a created trip like a load. Only trips with a vehicle id
  // (created after migration 1759780000000) are trackable.

  private createdTrips() {
    return this.dataSource.getRepository(TrackingTripEntity);
  }

  private async createdTripsToLoads(trips: TrackingTripEntity[]): Promise<MainLoad[]> {
    const fleetIds = [
      ...new Set(trips.filter((t) => t.ownFleet && t.vehicleId).map((t) => t.vehicleId!)),
    ];
    const devices = fleetIds.length
      ? await this.dataSource
          .createQueryBuilder()
          .select(['m.vehicle_id AS vehicle_id', 'm.gps_device_imei AS imei'])
          .from('masters.vehicle_telemetry_meta', 'm')
          .where('m.vehicle_id IN (:...ids)', { ids: fleetIds })
          .andWhere('m.deleted_at IS NULL')
          .andWhere("NULLIF(btrim(m.gps_device_imei), '') IS NOT NULL")
          .getRawMany<{ vehicle_id: string; imei: string }>()
      : [];
    const imeiOf = new Map(devices.map((d) => [d.vehicle_id, d.imei.trim()]));
    return trips.map((t) =>
      createdTripToLoad(t, t.vehicleId ? (imeiOf.get(t.vehicleId) ?? null) : null),
    );
  }

  /** Trackable created trips changed since `since`, oldest first, paged on (updated_at, id) like
   *  loadsChangedSince — the trip watcher's feed for them (an ended trip leaves the index). */
  async createdTripsChangedSince(
    since: Date,
    limit: number,
    after?: { updatedAt: Date; id: string },
  ): Promise<MainLoad[]> {
    const pageKey = `date_trunc('milliseconds', t.updated_at)`;
    const query = this.createdTrips()
      .createQueryBuilder('t')
      .where('t.vehicle_id IS NOT NULL')
      .orderBy(pageKey)
      .addOrderBy('t.id')
      .take(limit);
    if (after) {
      query.andWhere(`(${pageKey}, t.id) > (:afterAt::timestamptz, :afterId::uuid)`, {
        afterAt: after.updatedAt,
        afterId: after.id,
      });
    } else {
      query.andWhere('t.updated_at > :since', { since });
    }
    return this.createdTripsToLoads(await query.getMany());
  }

  /** Active trackable created trips — what the active-trip index and the SIM lifecycle hold. */
  async activeCreatedTrips(limit = 50_000): Promise<MainLoad[]> {
    const trips = await this.createdTrips().find({
      where: { status: 'active', vehicleId: Not(IsNull()) },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return this.createdTripsToLoads(trips);
  }

  /** A created trip's places as typed, with the first and last point of its newest planned road
   *  route — the coordinates of a place typed as an address (RoutePlanner geocoded it). */
  async createdTripEnds(tripId: string): Promise<{
    start: [number, number] | null;
    end: [number, number] | null;
    startName: string;
    endName: string;
    endAddress: string;
  } | null> {
    const trip = await this.createdTrips().findOne({ where: { id: tripId } });
    if (!trip) return null;
    const route = await this.dataSource
      .createQueryBuilder()
      .select('r.polyline', 'polyline')
      .from('tracking.trip_routes', 'r')
      .where('r.trip_id = :tripId', { tripId })
      .orderBy('r.version', 'DESC')
      .limit(1)
      .getRawOne<{ polyline: string | null }>();
    const line = route?.polyline ? decodePolyline(route.polyline) : [];
    const first = line[0];
    const last = line.at(-1);
    return {
      start: first ? [first.lat, first.lng] : null,
      end: last ? [last.lat, last.lng] : null,
      startName: trip.originName,
      endName: trip.destinationName,
      endAddress: trip.destinationAddress,
    };
  }

  /**
   * How a truck entered on Create trip will be tracked, decided once when the trip is created (a
   * load decides on truck assignment, in the main backend's createTrackingSourceResolver):
   *  - the vehicle: the tenant's fleet vehicle with this plate, else the plate's market id;
   *  - the driver: the one account with this mobile number (none when several share it);
   *  - the source: gps > driver_app > sim > fastag (initialTrackingSource).
   */
  async truckTracking(
    tenantId: string,
    vehicleNumber: string,
    driverPhone: string | null,
  ): Promise<TruckTracking> {
    const plate = normalizePlate(vehicleNumber);
    const fleet = await this.dataSource
      .createQueryBuilder()
      .select('v.id', 'id')
      .from('masters.vehicles', 'v')
      .where('v.tenant_id = :tenantId', { tenantId })
      .andWhere('v.deleted_at IS NULL')
      .andWhere("upper(regexp_replace(v.registration_number, '[\\s-]', '', 'g')) = :plate", {
        plate,
      })
      .orderBy('v.updated_at', 'DESC')
      .limit(1)
      .getRawOne<{ id: string }>();
    const telemetry = fleet
      ? await this.dataSource
          .createQueryBuilder()
          .select(['m.has_gps AS has_gps', 'm.gps_enabled AS gps_enabled'])
          .from('masters.vehicle_telemetry_meta', 'm')
          .where('m.vehicle_id = :vehicleId', { vehicleId: fleet.id })
          .andWhere('m.deleted_at IS NULL')
          .limit(1)
          .getRawOne<{ has_gps: boolean | null; gps_enabled: boolean | null }>()
      : undefined;

    const national = nationalMobile(driverPhone);
    let driverId: string | null = null;
    let hasDriverApp = false;
    if (national) {
      const drivers = await this.dataSource
        .createQueryBuilder()
        .select('d.id', 'id')
        .from('masters.drivers', 'd')
        .where('d.phone_number IN (:...forms)', { forms: [national, `91${national}`] })
        .andWhere('d.deleted_at IS NULL')
        .limit(2)
        .getRawMany<{ id: string }>();
      driverId = drivers.length === 1 ? drivers[0].id : null;
      // "Has logged into the app at least once" — any session row, revoked or expired too.
      hasDriverApp = driverId
        ? !!(await this.dataSource
            .createQueryBuilder()
            .select('1', 'one')
            .from('masters.driver_sessions', 's')
            .where('s.driver_id = :driverId', { driverId })
            .limit(1)
            .getRawOne())
        : false;
    }
    const hasGps = Boolean(telemetry?.has_gps && telemetry.gps_enabled);
    return {
      vehicleId: fleet?.id ?? marketVehicleId(tenantId, plate),
      ownFleet: !!fleet,
      driverId,
      trackingSource: initialTrackingSource({
        hasGps,
        hasDriverApp,
        hasDriverNumber: !!national,
        hasVehicleNumber: !!plate,
      }),
    };
  }
}

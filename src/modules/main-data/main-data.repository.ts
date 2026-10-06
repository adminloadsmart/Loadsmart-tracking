import { DataSource } from 'typeorm';
import type { TenantScope } from '../../shared/auth/staff-token';
import { ACTIVE_STATUSES, LoadStatus, marketVehicleId, normalizePlate } from '../trips/trip-state';

/**
 * The ONLY code in this service that knows the main loadsmart backend's tables. The tracking
 * service shares the main database and reads loads, vehicles and places directly — it never
 * copies them. Read-only, and it uses only columns present in every live schema version of main
 * (local and staging differ, e.g. driver tenancy), so a main migration has one place to land here.
 */

export interface MainLoad {
  id: string;
  tenantId: string;
  code: string;
  status: LoadStatus;
  sourceType: 'own_fleet' | 'market';
  /** Tracking's vehicle id: the fleet vehicle, or a stable id derived from a market truck's plate. */
  vehicleId: string | null;
  vehicleNumber: string | null;
  driverId: string | null;
  driverName: string | null;
  driverNumber: string | null;
  loadingPointId: string | null;
  deliveryPointId: string | null;
  customerId: string | null;
  /** Requisition's expected delivery date, end of day India time. */
  promisedDeliveryAt: Date | null;
  /** Tracking runs from loading confirmation… */
  startedAt: Date | null;
  /** …to delivery (or close). */
  endedAt: Date | null;
  milestones: Record<string, string | null>;
  updatedAt: Date;
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
  status: LoadStatus;
  source_type: 'own_fleet' | 'market';
  vehicle_id: string | null;
  vehicle_number: string | null;
  driver_id: string | null;
  driver_name: string | null;
  driver_number: string | null;
  loading_point_id: string | null;
  delivery_point_id: string | null;
  customer_id: string | null;
  promised_delivery_at: Date | null;
  loading_confirmed_at: Date | null;
  at_plant_at: Date | null;
  in_transit_at: Date | null;
  reached_delivery_point_at: Date | null;
  delivered_at: Date | null;
  closed_at: Date | null;
  updated_at: Date;
}

const LOAD_SELECT = `
  SELECT l.id, l.tenant_id, l.code, l.status::text AS status, l.source_type::text AS source_type,
         l.vehicle_id, l.vehicle_number, l.driver_id, l.driver_name, l.driver_number,
         r.loading_point_id, r.customer_delivery_point_id AS delivery_point_id, r.customer_id,
         ((r.expected_delivery_date::timestamp + time '23:59') AT TIME ZONE 'Asia/Kolkata')
           AS promised_delivery_at,
         l.loading_confirmed_at, l.at_plant_at, l.in_transit_at, l.reached_delivery_point_at,
         l.delivered_at, l.closed_at, l.updated_at
  FROM loads.loads l
  LEFT JOIN loads.requisitions r ON r.id = l.requisition_id`;

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

function toLoad(row: LoadRow): MainLoad {
  const vehicleId =
    row.source_type === 'own_fleet'
      ? row.vehicle_id
      : row.vehicle_number?.trim()
        ? marketVehicleId(row.tenant_id, row.vehicle_number)
        : null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    status: row.status,
    sourceType: row.source_type,
    vehicleId,
    vehicleNumber: row.vehicle_number ? normalizePlate(row.vehicle_number) : null,
    driverId: row.driver_id,
    driverName: row.driver_name,
    driverNumber: row.driver_number,
    loadingPointId: row.loading_point_id,
    deliveryPointId: row.delivery_point_id,
    customerId: row.customer_id,
    promisedDeliveryAt: row.promised_delivery_at,
    startedAt: row.loading_confirmed_at,
    endedAt: row.delivered_at ?? row.closed_at,
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

/** `AND <column> = $n` for a tenant-scoped caller, nothing for platform admins. */
function scoped(scope: TenantScope | null, column: string, params: unknown[]): string {
  if (!scope || 'allTenants' in scope) return '';
  params.push(scope.tenantId);
  return ` AND ${column} = $${params.length}`;
}

export class MainDataRepository {
  constructor(private readonly dataSource: DataSource) {}

  // ---- loads (= trips) ---------------------------------------------------------------------

  /** Loads changed since `since` (any status), oldest first — the trip watcher's feed. */
  async loadsChangedSince(since: Date, limit: number): Promise<MainLoad[]> {
    const rows: LoadRow[] = await this.dataSource.query(
      `${LOAD_SELECT} WHERE l.updated_at > $1 ORDER BY l.updated_at, l.id LIMIT $2`,
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
      `${LOAD_SELECT} WHERE l.status::text = ANY($1::text[])${scoped(scope, 'l.tenant_id', params)}
       ORDER BY l.loading_confirmed_at DESC NULLS LAST, l.code DESC LIMIT $2`,
      params,
    );
    return rows.map(toLoad);
  }

  activeLoads(scope: TenantScope | null = null, limit = 50_000): Promise<MainLoad[]> {
    return this.loadsByStatus(scope, ACTIVE_STATUSES, limit);
  }

  async load(scope: TenantScope | null, id: string): Promise<MainLoad | null> {
    const params: unknown[] = [id];
    const rows: LoadRow[] = await this.dataSource.query(
      `${LOAD_SELECT} WHERE l.id = $1${scoped(scope, 'l.tenant_id', params)}`,
      params,
    );
    return rows[0] ? toLoad(rows[0]) : null;
  }

  /**
   * For each timestamp, the driver's load (in this tenant) whose tracking window covers it —
   * places an offline batch flushed after its trip ended. One round trip per batch.
   */
  async driverLoadsAt(
    driverId: string,
    tenantId: string,
    recordedAts: string[],
    graceMinutes: number,
  ): Promise<Array<{ recordedAt: string; load: MainLoad }>> {
    if (recordedAts.length === 0) return [];
    const rows: Array<LoadRow & { recorded_at: string }> = await this.dataSource.query(
      `SELECT p.recorded_at, t.*
       FROM unnest($3::text[]) AS p(recorded_at)
       JOIN LATERAL (
         ${LOAD_SELECT}
         WHERE l.driver_id = $1 AND l.tenant_id = $2
           AND l.loading_confirmed_at IS NOT NULL
           AND l.loading_confirmed_at - make_interval(mins => $4) <= p.recorded_at::timestamptz
           AND COALESCE(l.delivered_at, l.closed_at, 'infinity') >= p.recorded_at::timestamptz
         ORDER BY l.loading_confirmed_at DESC
         LIMIT 1
       ) t ON true`,
      [driverId, tenantId, recordedAts, graceMinutes],
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

  /** Market trucks aren't in the vehicle master; they exist for tracking only while on a load. */
  private async marketTrucks(scope: TenantScope): Promise<MainVehicle[]> {
    const loads = (await this.activeLoads(scope)).filter(
      (l) => l.sourceType === 'market' && l.vehicleId,
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
                g.lat, g.lng
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
          lat: r.lat ?? null,
          lng: r.lng ?? null,
        });
      }
    }
    return places;
  }
}

import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';

/**
 * The slice of the MAIN backend's schema the tracking service reads (modules/main-data), for
 * integration tests — only the columns tracking uses. Main's real tables have many more columns
 * and enums; this mirrors their names and types closely enough for main-data's queries. The
 * geofence tables are main's too: its CreateGeofences migration puts them in the tracking schema.
 */
export const MAIN_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS loads;
  CREATE SCHEMA IF NOT EXISTS masters;
  CREATE SCHEMA IF NOT EXISTS customers;
  CREATE TABLE IF NOT EXISTS customers.customers (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL);
  CREATE TABLE IF NOT EXISTS masters.truck_types (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL, body_type text,
    deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS masters.vehicles (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, registration_number text NOT NULL,
    truck_type_id uuid, body_type text, deleted_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS masters.vehicle_telemetry_meta (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, vehicle_id uuid NOT NULL,
    gps_provider text, gps_enabled boolean NOT NULL DEFAULT false, deleted_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS masters.loading_points (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, title text NOT NULL, address_line_1 text,
    city text, state text, pin_code text, latitude numeric(10,6), longitude numeric(10,6),
    deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS customers.customer_delivery_points (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, customer_id uuid NOT NULL, location text NOT NULL,
    address_line_1 text, address_line_2 text, city text, state text, pin_code text,
    deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS loads.requisitions (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, customer_id uuid NOT NULL,
    loading_point_id uuid NOT NULL, customer_delivery_point_id uuid NOT NULL,
    expected_delivery_date date NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS loads.loads (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text NOT NULL, status text NOT NULL,
    source_type text NOT NULL, requisition_id uuid NOT NULL, vehicle_id uuid, vehicle_number text,
    driver_id uuid, driver_name text, driver_number text, planned_capacity_tonnes numeric,
    loading_confirmed_at timestamptz,
    at_plant_at timestamptz, in_transit_at timestamptz, reached_delivery_point_at timestamptz,
    delivered_at timestamptz, closed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS planned_capacity_tonnes numeric;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS posting_id uuid;
  CREATE TABLE IF NOT EXISTS loads.load_postings (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, pickup_loading_point_id uuid,
    drop_customer_delivery_point_id uuid, drop_loading_point_id uuid);
  CREATE SCHEMA IF NOT EXISTS tracking;
  CREATE TABLE IF NOT EXISTS tracking.geofences (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL, type text NOT NULL,
    latitude numeric(10,6) NOT NULL, longitude numeric(10,6) NOT NULL,
    shape text NOT NULL DEFAULT 'circle', radius_m integer, polygon jsonb,
    applies_to_all_vehicles boolean NOT NULL DEFAULT true, loading_point_id uuid,
    customer_delivery_point_id uuid, is_active boolean NOT NULL DEFAULT true,
    deleted_at timestamptz);
  CREATE TABLE IF NOT EXISTS tracking.geofence_vehicles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), geofence_id uuid NOT NULL, vehicle_id uuid NOT NULL);
  CREATE TABLE IF NOT EXISTS tracking.geofence_events (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, geofence_id uuid NOT NULL, vehicle_id uuid NOT NULL,
    load_id uuid, event text NOT NULL, latitude numeric(10,6) NOT NULL,
    longitude numeric(10,6) NOT NULL, occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now());
`;

export const MAIN_TABLES =
  'loads.loads, loads.requisitions, loads.load_postings, customers.customer_delivery_points, ' +
  'masters.loading_points, masters.vehicle_telemetry_meta, masters.vehicles, masters.truck_types, ' +
  'customers.customers, tracking.geofences, tracking.geofence_vehicles, tracking.geofence_events';

export interface SeedLoadInput {
  tenantId: string;
  status?: string;
  sourceType?: 'own_fleet' | 'market';
  vehicleId?: string;
  /** Market trucks: no vehicle row, only the plate on the load. */
  vehicleNumber?: string;
  registrationNumber?: string;
  bodyType?: string | null;
  driverId?: string | null;
  driverName?: string | null;
  driverNumber?: string | null;
  customerName?: string;
  plannedTonnes?: number | null;
  startedAt?: Date | null;
  deliveredAt?: Date | null;
  expectedDeliveryDate?: string; // YYYY-MM-DD
  origin?: { lat: number; lng: number } | null;
  destination?: {
    location: string;
    address?: string;
    city?: string;
    state?: string;
    pinCode?: string;
  };
  code?: string;
}

export interface SeededLoad {
  loadId: string;
  vehicleId: string | null;
  driverId: string | null;
  loadingPointId: string;
  deliveryPointId: string;
}

/** Inserts a load (with vehicle, truck type, places and requisition) as the main backend would. */
export async function seedLoad(ds: DataSource, input: SeedLoadInput): Promise<SeededLoad> {
  const t = input.tenantId;
  const sourceType = input.sourceType ?? 'own_fleet';
  const [loadId, loadingPointId, deliveryPointId, requisitionId, customerId] = [1, 2, 3, 4, 5].map(
    () => randomUUID(),
  );
  let vehicleId: string | null = null;
  if (sourceType === 'own_fleet') {
    vehicleId = input.vehicleId ?? randomUUID();
    let truckTypeId: string | null = null;
    if (input.bodyType) {
      truckTypeId = randomUUID();
      await ds.query(
        `INSERT INTO masters.truck_types (id, tenant_id, name, body_type) VALUES ($1, $2, $3, $4)`,
        [truckTypeId, t, `${input.bodyType} truck`, input.bodyType],
      );
    }
    await ds.query(
      `INSERT INTO masters.vehicles (id, tenant_id, registration_number, truck_type_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [vehicleId, t, input.registrationNumber ?? 'MH12AB0001', truckTypeId],
    );
  }
  const origin = input.origin === undefined ? { lat: 28.6, lng: 77.2 } : input.origin;
  await ds.query(
    `INSERT INTO masters.loading_points (id, tenant_id, title, address_line_1, city, state, pin_code, latitude, longitude)
     VALUES ($1, $2, 'Plant', 'Plot 1', 'Delhi', 'DL', '110001', $3, $4)`,
    [loadingPointId, t, origin?.lat ?? null, origin?.lng ?? null],
  );
  await ds.query(`INSERT INTO customers.customers (id, tenant_id, name) VALUES ($1, $2, $3)`, [
    customerId,
    t,
    input.customerName ?? 'ACME Ltd',
  ]);
  const d = input.destination ?? { location: 'ACME DC' };
  await ds.query(
    `INSERT INTO customers.customer_delivery_points (id, tenant_id, customer_id, location, address_line_1, city, state, pin_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      deliveryPointId,
      t,
      customerId,
      d.location,
      d.address ?? null,
      d.city ?? null,
      d.state ?? null,
      d.pinCode ?? null,
    ],
  );
  await ds.query(
    `INSERT INTO loads.requisitions (id, tenant_id, customer_id, loading_point_id, customer_delivery_point_id, expected_delivery_date)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      requisitionId,
      t,
      customerId,
      loadingPointId,
      deliveryPointId,
      input.expectedDeliveryDate ?? '2099-01-01',
    ],
  );
  const driverId = input.driverId === undefined ? randomUUID() : input.driverId;
  const started =
    input.startedAt === undefined ? new Date(Date.now() - 3_600_000) : input.startedAt;
  await ds.query(
    `INSERT INTO loads.loads (id, tenant_id, code, status, source_type, requisition_id, vehicle_id, vehicle_number,
       driver_id, driver_name, driver_number, planned_capacity_tonnes, loading_confirmed_at,
       delivered_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp())`,
    [
      loadId,
      t,
      input.code ?? 'LOAD-T1',
      input.status ?? 'in_transit',
      sourceType,
      requisitionId,
      vehicleId,
      input.vehicleNumber ?? input.registrationNumber ?? 'MH12AB0001',
      driverId,
      input.driverName ?? null,
      input.driverNumber ?? null,
      input.plannedTonnes ?? null,
      started,
      input.deliveredAt ?? null,
    ],
  );
  return { loadId, vehicleId, driverId, loadingPointId, deliveryPointId };
}

/** Updates a load the way main's TypeORM would (bumping updated_at). */
export async function updateLoad(
  ds: DataSource,
  loadId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  await ds.query(`UPDATE loads.loads SET ${sets}, updated_at = clock_timestamp() WHERE id = $1`, [
    loadId,
    ...keys.map((k) => fields[k]),
  ]);
}

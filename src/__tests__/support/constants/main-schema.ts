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

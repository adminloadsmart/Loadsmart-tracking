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
  ALTER TABLE masters.vehicle_telemetry_meta ADD COLUMN IF NOT EXISTS gps_device_imei varchar(15);
  ALTER TABLE masters.vehicle_telemetry_meta ADD COLUMN IF NOT EXISTS has_gps boolean NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS masters.driver_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL);
  CREATE TABLE IF NOT EXISTS masters.drivers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL,
    phone_number text NOT NULL, deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS masters.driver_tenant_relations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, driver_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'active', deleted_at timestamptz);
  CREATE TABLE IF NOT EXISTS masters.loading_points (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, title text NOT NULL, address_line_1 text,
    city text, state text, pin_code text, latitude numeric(10,6), longitude numeric(10,6),
    deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS customers.customer_delivery_points (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, customer_id uuid NOT NULL, location text NOT NULL,
    address_line_1 text, address_line_2 text, city text, state text, pin_code text,
    deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE customers.customer_delivery_points ADD COLUMN IF NOT EXISTS latitude numeric(10,6);
  ALTER TABLE customers.customer_delivery_points ADD COLUMN IF NOT EXISTS longitude numeric(10,6);
  CREATE TABLE IF NOT EXISTS loads.requisitions (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, customer_id uuid NOT NULL,
    loading_point_id uuid NOT NULL, customer_delivery_point_id uuid NOT NULL,
    expected_delivery_date date NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS loads.loads (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text NOT NULL, status text NOT NULL,
    posting_type text NOT NULL, route text, requisition_id uuid NOT NULL, vehicle_id uuid, vehicle_number text,
    driver_id uuid, driver_name text, driver_number text, planned_capacity_tonnes numeric,
    loading_confirmed_at timestamptz,
    truck_assigned_at timestamptz, in_transit_loading_at timestamptz,
    at_plant_at timestamptz, in_transit_at timestamptz, reached_delivery_point_at timestamptz,
    delivered_at timestamptz, closed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  -- A test database made before main's load-module change still has the dropped source_type.
  ALTER TABLE loads.loads DROP COLUMN IF EXISTS source_type;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS posting_type text NOT NULL DEFAULT 'own_fleet';
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS route text;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS pod_status text;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS planned_capacity_tonnes numeric;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS posting_id uuid;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS truck_assigned_at timestamptz;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS in_transit_loading_at timestamptz;
  DO $$ BEGIN
    CREATE TYPE loads.loads_tracking_source_enum AS ENUM ('gps', 'driver_app', 'sim', 'fastag');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS tracking_source loads.loads_tracking_source_enum;
  CREATE TABLE IF NOT EXISTS loads.load_postings (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, pickup_loading_point_id uuid,
    drop_customer_delivery_point_id uuid, drop_loading_point_id uuid);
  ALTER TABLE loads.load_postings ADD COLUMN IF NOT EXISTS customer_id uuid;
  ALTER TABLE loads.load_postings ADD COLUMN IF NOT EXISTS deliver_by_at timestamptz;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS departed_drop_at timestamptz;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS title text;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS eway_bill_number varchar(50);
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS eway_bill_expires_at timestamptz;
  ALTER TABLE loads.loads ADD COLUMN IF NOT EXISTS elr_number varchar(50);
  ALTER TABLE masters.vehicles ADD COLUMN IF NOT EXISTS vahan_verification_status text NOT NULL DEFAULT 'unverified';
  CREATE TABLE IF NOT EXISTS masters.vehicle_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_id uuid NOT NULL,
    expiry_date date, deleted_at timestamptz);
  CREATE TABLE IF NOT EXISTS loads.load_verifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, load_id uuid NOT NULL,
    subject text NOT NULL, subject_ref varchar(30) NOT NULL, status text NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now());
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.organizations (
    id uuid PRIMARY KEY, late_delivery_threshold_minutes integer);
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
  'masters.driver_tenant_relations, masters.driver_sessions, masters.loading_points, masters.vehicle_telemetry_meta, masters.vehicles, masters.truck_types, ' +
  'customers.customers, tracking.geofences, tracking.geofence_vehicles, tracking.geofence_events, ' +
  'auth.organizations';

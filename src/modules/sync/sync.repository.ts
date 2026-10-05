import { DataSource, EntityManager } from 'typeorm';
import { DriverPayload, PlacePayload, VehiclePayload } from './sync.contract';
import { TrackingState } from './trip-state';

export interface TripRow {
  id: string;
  vehicle_id: string | null;
  driver_id: string | null;
  tracking_state: TrackingState;
  tracking_started_at: Date | null;
  tracking_ended_at: Date | null;
}

export interface TripUpsert {
  id: string;
  tenantId: string;
  loadCode: string;
  loadStatus: string;
  sourceType: string;
  vehicleId: string | null;
  vehicleNumber: string | null;
  driverId: string | null;
  driverPhone: string | null;
  driverName: string | null;
  transporterId: string | null;
  originPlaceId: string | null;
  destinationPlaceId: string | null;
  trackingState: TrackingState;
  trackingStartedAt: Date | null;
  trackingEndedAt: Date | null;
  milestones: Record<string, string | null>;
  deleted: boolean;
  version: number;
}

/**
 * Version-guarded upserts into the read models: a snapshot is written only if its version is
 * >= the stored one (>= rather than > so a retried entry re-runs its side effects). Each method
 * returns whether the snapshot was applied.
 */
export class SyncRepository {
  constructor(private readonly dataSource: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  async upsertVehicle(
    id: string,
    tenantId: string,
    version: number,
    payload: VehiclePayload | null,
  ): Promise<boolean> {
    const rows = await this.dataSource.query(
      `INSERT INTO tracking.vehicles AS v
         (id, tenant_id, kind, registration_number, status, gps_provider, gps_enabled, deleted_at, source_version)
       VALUES ($1, $2, 'fleet', $3, $4, $5, $6, CASE WHEN $7 THEN now() END, $8)
       ON CONFLICT (id) DO UPDATE SET
         registration_number = CASE WHEN $7 THEN v.registration_number ELSE EXCLUDED.registration_number END,
         status = CASE WHEN $7 THEN v.status ELSE EXCLUDED.status END,
         gps_provider = CASE WHEN $7 THEN v.gps_provider ELSE EXCLUDED.gps_provider END,
         gps_enabled = CASE WHEN $7 THEN v.gps_enabled ELSE EXCLUDED.gps_enabled END,
         deleted_at = CASE WHEN $7 THEN COALESCE(v.deleted_at, now()) END,
         source_version = EXCLUDED.source_version,
         synced_at = now()
       WHERE v.source_version <= EXCLUDED.source_version
       RETURNING id`,
      [
        id,
        tenantId,
        // A tombstone for a vehicle we never saw still needs a non-null plate to insert.
        payload?.registrationNumber ?? '(deleted)',
        payload?.status ?? null,
        payload?.gpsProvider ?? null,
        payload?.gpsEnabled ?? false,
        payload === null,
        version,
      ],
    );
    return rows.length > 0;
  }

  /** Creates the market-truck vehicle on first sight; never overwrites an existing row. */
  async ensureMarketVehicle(
    manager: EntityManager,
    id: string,
    tenantId: string,
    plate: string,
    version: number,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO tracking.vehicles (id, tenant_id, kind, registration_number, source_version)
       VALUES ($1, $2, 'market', $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, tenantId, plate, version],
    );
  }

  async upsertDriver(
    id: string,
    tenantId: string,
    version: number,
    payload: DriverPayload | null,
  ): Promise<boolean> {
    const rows = await this.dataSource.query(
      `INSERT INTO tracking.drivers AS d
         (id, tenant_id, full_name, phone_number, status, deleted_at, source_version)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END, $7)
       ON CONFLICT (id) DO UPDATE SET
         full_name = CASE WHEN $6 THEN d.full_name ELSE EXCLUDED.full_name END,
         phone_number = CASE WHEN $6 THEN d.phone_number ELSE EXCLUDED.phone_number END,
         status = CASE WHEN $6 THEN d.status ELSE EXCLUDED.status END,
         deleted_at = CASE WHEN $6 THEN COALESCE(d.deleted_at, now()) END,
         source_version = EXCLUDED.source_version,
         synced_at = now()
       WHERE d.source_version <= EXCLUDED.source_version
       RETURNING id`,
      [
        id,
        tenantId,
        payload?.fullName ?? '',
        payload?.phoneNumber ?? '',
        payload?.status ?? null,
        payload === null,
        version,
      ],
    );
    return rows.length > 0;
  }

  async upsertPlace(
    id: string,
    tenantId: string,
    kind: 'loading_point' | 'delivery_point',
    version: number,
    payload: PlacePayload | null,
  ): Promise<boolean> {
    const rows = await this.dataSource.query(
      `INSERT INTO tracking.places AS p
         (id, tenant_id, kind, name, address, city, state, pin_code, lat, lng, deleted_at, source_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN now() END, $12)
       ON CONFLICT (id) DO UPDATE SET
         name = CASE WHEN $11 THEN p.name ELSE EXCLUDED.name END,
         address = CASE WHEN $11 THEN p.address ELSE EXCLUDED.address END,
         city = CASE WHEN $11 THEN p.city ELSE EXCLUDED.city END,
         state = CASE WHEN $11 THEN p.state ELSE EXCLUDED.state END,
         pin_code = CASE WHEN $11 THEN p.pin_code ELSE EXCLUDED.pin_code END,
         lat = CASE WHEN $11 THEN p.lat ELSE EXCLUDED.lat END,
         lng = CASE WHEN $11 THEN p.lng ELSE EXCLUDED.lng END,
         deleted_at = CASE WHEN $11 THEN COALESCE(p.deleted_at, now()) END,
         source_version = EXCLUDED.source_version,
         synced_at = now()
       WHERE p.source_version <= EXCLUDED.source_version
       RETURNING id`,
      [
        id,
        tenantId,
        kind,
        payload?.name ?? '',
        payload?.address ?? null,
        payload?.city ?? null,
        payload?.state ?? null,
        payload?.pinCode ?? null,
        payload?.lat ?? null,
        payload?.lng ?? null,
        payload === null,
        version,
      ],
    );
    return rows.length > 0;
  }

  async lockTrip(manager: EntityManager, id: string): Promise<TripRow | null> {
    const rows: TripRow[] = await manager.query(
      `SELECT id, vehicle_id, driver_id, tracking_state, tracking_started_at, tracking_ended_at
       FROM tracking.trips WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async upsertTrip(manager: EntityManager, trip: TripUpsert): Promise<boolean> {
    const rows = await manager.query(
      `INSERT INTO tracking.trips AS t
         (id, tenant_id, load_code, load_status, source_type, vehicle_id, vehicle_number,
          driver_id, driver_phone, driver_name, transporter_id, origin_place_id,
          destination_place_id, tracking_state, tracking_started_at, tracking_ended_at,
          milestones, deleted_at, source_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               CASE WHEN $18 THEN now() END, $19)
       ON CONFLICT (id) DO UPDATE SET
         load_code = EXCLUDED.load_code,
         load_status = EXCLUDED.load_status,
         source_type = EXCLUDED.source_type,
         vehicle_id = EXCLUDED.vehicle_id,
         vehicle_number = EXCLUDED.vehicle_number,
         driver_id = EXCLUDED.driver_id,
         driver_phone = EXCLUDED.driver_phone,
         driver_name = EXCLUDED.driver_name,
         transporter_id = EXCLUDED.transporter_id,
         origin_place_id = EXCLUDED.origin_place_id,
         destination_place_id = EXCLUDED.destination_place_id,
         tracking_state = EXCLUDED.tracking_state,
         tracking_started_at = EXCLUDED.tracking_started_at,
         tracking_ended_at = EXCLUDED.tracking_ended_at,
         milestones = EXCLUDED.milestones,
         deleted_at = CASE WHEN $18 THEN COALESCE(t.deleted_at, now()) END,
         source_version = EXCLUDED.source_version,
         synced_at = now()
       WHERE t.source_version <= EXCLUDED.source_version
       RETURNING id`,
      [
        trip.id,
        trip.tenantId,
        trip.loadCode,
        trip.loadStatus,
        trip.sourceType,
        trip.vehicleId,
        trip.vehicleNumber,
        trip.driverId,
        trip.driverPhone,
        trip.driverName,
        trip.transporterId,
        trip.originPlaceId,
        trip.destinationPlaceId,
        trip.trackingState,
        trip.trackingStartedAt,
        trip.trackingEndedAt,
        JSON.stringify(trip.milestones),
        trip.deleted,
        trip.version,
      ],
    );
    return rows.length > 0;
  }

  /** Load hard-deleted upstream: end its tracking but keep the row for history. */
  async endDeletedTrip(
    manager: EntityManager,
    id: string,
    version: number,
    endedAt: Date,
  ): Promise<boolean> {
    const rows = await manager.query(
      `UPDATE tracking.trips
         SET tracking_state = 'ended', tracking_ended_at = COALESCE(tracking_ended_at, $2),
             deleted_at = COALESCE(deleted_at, now()), source_version = $3, synced_at = now()
       WHERE id = $1 AND source_version <= $3
       RETURNING id`,
      [id, endedAt, version],
    );
    return rows.length > 0;
  }

  async findActiveTrips(): Promise<
    Array<{ id: string; vehicle_id: string | null; driver_id: string | null }>
  > {
    return this.dataSource.query(
      `SELECT id, vehicle_id, driver_id FROM tracking.trips WHERE tracking_state = 'active'`,
    );
  }
}

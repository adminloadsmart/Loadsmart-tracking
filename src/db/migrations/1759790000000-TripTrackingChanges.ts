import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tracking changes of 25 Nov for trips created from the tracking screen (tracking.trips):
 *  - lr_number            the trip's LR number, typed on Create trip
 *  - origin_/destination_ lat/lng  where each end is, fixed when the trip is saved or edited (the
 *                         picked master's pin, else its address geocoded). Planned road routes
 *                         are no longer drawn, so these replace the route's ends
 *  - status               the trip's stage instead of active / ended: waiting_first_ping →
 *                         heading_to_pickup → at_pickup → in_transit → at_drop → completed, or
 *                         cancelled. Moved on automatically by pings and geofences (a second
 *                         point inside the drop geofence completes it); Stop tracking cancels.
 *                         Existing rows: ended (stopped by hand) → cancelled; active →
 *                         in_transit / heading_to_pickup / waiting_first_ping
 *  - arrived_pickup_at, departed_pickup_at, arrived_drop_at  when each geofence step happened
 *  - vahan_status         the VAHAN check Create trip ran on the truck: 'verified' (found, every
 *                         paper valid), 'non_compliant' (a paper expired), 'not_found', ...
 *  - dl_status, dl_front_key, dl_back_key  the Sarathi check Create trip ran on the driver's
 *                         licence, and — when Sarathi couldn't confirm it (manual_review) — the
 *                         storage keys of the licence's front and back photos, for a manual check
 *  - rc_key               the truck's RC photo, uploaded when the VAHAN check failed
 *  - one active trip per truck, and one per driver number, in a tenant (partial unique indexes);
 *    existing clashes stop the migration and are listed, so the extra trips can be ended first
 */
/** A running trip's stages, as SQL (trip.entity.ts RUNNING_TRIP_STATUSES at the time). */
const RUNNING = `'waiting_first_ping', 'heading_to_pickup', 'at_pickup', 'in_transit', 'at_drop'`;

export class TripTrackingChanges1759790000000 implements MigrationInterface {
  name = 'TripTrackingChanges1759790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tracking.trips
        ADD COLUMN lr_number          text,
        ADD COLUMN origin_lat         double precision,
        ADD COLUMN origin_lng         double precision,
        ADD COLUMN destination_lat    double precision,
        ADD COLUMN destination_lng    double precision,
        ADD COLUMN arrived_pickup_at  timestamptz,
        ADD COLUMN departed_pickup_at timestamptz,
        ADD COLUMN arrived_drop_at    timestamptz,
        ADD COLUMN vahan_status       text,
        ADD COLUMN rc_key             text,
        ADD COLUMN dl_status          text,
        ADD COLUMN dl_front_key       text,
        ADD COLUMN dl_back_key        text`);

    const clashes: Array<{ tenant_id: string; what: string; value: string; codes: string[] }> =
      await queryRunner.query(`
        SELECT tenant_id, 'truck' AS what, vehicle_number AS value,
               array_agg(code ORDER BY created_at) AS codes
        FROM tracking.trips WHERE status = 'active'
        GROUP BY tenant_id, vehicle_number HAVING count(*) > 1
        UNION ALL
        SELECT tenant_id, 'driver' AS what, driver_phone AS value,
               array_agg(code ORDER BY created_at) AS codes
        FROM tracking.trips WHERE status = 'active'
        GROUP BY tenant_id, driver_phone HAVING count(*) > 1`);
    if (clashes.length > 0) {
      const list = clashes
        .map((c) => `${c.what} ${c.value} (${c.codes.join(', ')}) in tenant ${c.tenant_id}`)
        .join('; ');
      throw new Error(
        `Active trips share a truck or a driver number: ${list}. End or cancel the extra ones, then run this migration again.`,
      );
    }
    // Stages instead of active / ended. A running trip that has had a point is past its first ping.
    await queryRunner.query(
      `ALTER TABLE tracking.trips DROP CONSTRAINT IF EXISTS trips_status_check`,
    );
    await queryRunner.query(`
      UPDATE tracking.trips t SET status = CASE
        -- Before this, trips only ended by Stop tracking, i.e. called off part-way.
        WHEN t.status IN ('ended', 'cancelled') THEN 'cancelled'
        WHEN NOT EXISTS (SELECT 1 FROM tracking.location_points p WHERE p.trip_id = t.id)
          THEN 'waiting_first_ping'
        WHEN t.origin_lat IS NULL THEN 'in_transit'
        ELSE 'heading_to_pickup'
      END`);
    await queryRunner.query(`
      ALTER TABLE tracking.trips
        ALTER COLUMN status SET DEFAULT 'waiting_first_ping',
        ADD CONSTRAINT trips_status_check CHECK (status IN (${RUNNING}, 'completed', 'cancelled'))`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX trips_active_truck_uq
        ON tracking.trips (tenant_id, vehicle_number) WHERE status IN (${RUNNING})`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX trips_active_driver_uq
        ON tracking.trips (tenant_id, driver_phone) WHERE status IN (${RUNNING})`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS tracking.trips_active_driver_uq`);
    await queryRunner.query(`DROP INDEX IF EXISTS tracking.trips_active_truck_uq`);
    await queryRunner.query(
      `ALTER TABLE tracking.trips DROP CONSTRAINT IF EXISTS trips_status_check`,
    );
    await queryRunner.query(`
      UPDATE tracking.trips SET status = CASE
        WHEN status = 'completed' THEN 'ended'
        WHEN status = 'cancelled' THEN 'cancelled'
        ELSE 'active'
      END`);
    await queryRunner.query(`
      ALTER TABLE tracking.trips
        ALTER COLUMN status SET DEFAULT 'active',
        ADD CONSTRAINT trips_status_check CHECK (status IN ('active', 'ended', 'cancelled'))`);
    await queryRunner.query(`
      ALTER TABLE tracking.trips
        DROP COLUMN dl_back_key,
        DROP COLUMN dl_front_key,
        DROP COLUMN dl_status,
        DROP COLUMN rc_key,
        DROP COLUMN vahan_status,
        DROP COLUMN arrived_drop_at,
        DROP COLUMN departed_pickup_at,
        DROP COLUMN arrived_pickup_at,
        DROP COLUMN destination_lng,
        DROP COLUMN destination_lat,
        DROP COLUMN origin_lng,
        DROP COLUMN origin_lat,
        DROP COLUMN lr_number`);
  }
}

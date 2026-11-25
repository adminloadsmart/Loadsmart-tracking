import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Live tracking for trips created from the tracking screen (tracking.trips). Until now they were
 * stored and shown only; now they enter the active-trip index like a load, so GPS, driver-app and
 * SIM points attach to them, and the SIM lifecycle asks the driver's consent.
 *
 * Decided once, when the trip is created (as a load decides on truck assignment):
 *  - vehicle_id       the fleet vehicle with that plate in the tenant, else the stable market id
 *                     derived from tenant + plate (marketVehicleId) — what points are keyed by
 *  - own_fleet        whether vehicle_id is a fleet vehicle (its GPS device is then looked up)
 *  - driver_id        the one driver account with that mobile number, if exactly one has it
 *  - tracking_source  gps > driver_app > sim > fastag, the loads' order (initialTrackingSource)
 *
 * Trips created before this migration keep NULLs and stay display-only.
 */
export class CreatedTripTracking1759780000000 implements MigrationInterface {
  name = 'CreatedTripTracking1759780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tracking.trips
        ADD COLUMN vehicle_id      uuid,
        ADD COLUMN own_fleet       boolean NOT NULL DEFAULT false,
        ADD COLUMN driver_id       uuid,
        ADD COLUMN tracking_source text
          CHECK (tracking_source IN ('gps', 'driver_app', 'sim', 'fastag'))`);
    // The trip watcher pages created trips on (updated_at, id), like loads.
    await queryRunner.query(`CREATE INDEX trips_updated_idx ON tracking.trips (updated_at, id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS tracking.trips_updated_idx`);
    await queryRunner.query(`
      ALTER TABLE tracking.trips
        DROP COLUMN tracking_source,
        DROP COLUMN driver_id,
        DROP COLUMN own_fleet,
        DROP COLUMN vehicle_id`);
  }
}

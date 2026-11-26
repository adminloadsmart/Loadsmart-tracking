import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * tracking.trip_driver_changes: each time Edit tracking gives a created trip a new driver number,
 * the number (and name) before and after, who changed it and when. tracking.trips only keeps the
 * current driver; this is the history the trip page shows (a marker on the map where the truck was
 * at the change, and an entry in the journey). A SIM trip moves its Intugine trip to the new
 * number from this moment (see sim_trips.carried_intugine_trip_id).
 */
export class TripDriverChanges1759810000000 implements MigrationInterface {
  name = 'TripDriverChanges1759810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.trip_driver_changes (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid        NOT NULL,
        trip_id     uuid        NOT NULL REFERENCES tracking.trips (id) ON DELETE CASCADE,
        from_phone  text        NOT NULL,
        to_phone    text        NOT NULL,
        from_name   text,
        to_name     text,
        changed_by  uuid,
        changed_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX trip_driver_changes_trip_idx ON tracking.trip_driver_changes (trip_id, changed_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tracking.trip_driver_changes`);
  }
}

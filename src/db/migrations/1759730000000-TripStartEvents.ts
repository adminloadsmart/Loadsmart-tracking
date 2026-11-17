import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per truck assignment whose trip has started (the truck moved the trip-start distance
 * from where it was). The primary key is what makes `trip.started` once-only: a redelivered batch
 * finds the row and sends nothing. A new assignment (a different `assignment_ms`, the load's
 * truck_assigned_at) is a new row, so a cancelled and re-assigned load can start again.
 */
export class TripStartEvents1759730000000 implements MigrationInterface {
  name = 'TripStartEvents1759730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.trip_start_events (
        trip_id        uuid        NOT NULL,
        assignment_ms  bigint      NOT NULL,
        tenant_id      uuid        NOT NULL,
        vehicle_id     uuid        NOT NULL,
        -- When the truck was first seen the start distance away (the trip's start time).
        started_at     timestamptz NOT NULL,
        -- Where it was when assigned, and where the confirming ping put it.
        from_lat       double precision NOT NULL,
        from_lng       double precision NOT NULL,
        lat            double precision NOT NULL,
        lng            double precision NOT NULL,
        distance_m     real        NOT NULL,
        source         text        NOT NULL,
        pings          smallint    NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (trip_id, assignment_ms)
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tracking.trip_start_events`);
  }
}

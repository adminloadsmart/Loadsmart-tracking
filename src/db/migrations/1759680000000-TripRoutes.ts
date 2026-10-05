import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Planned road routes for DELAY-GPS / DEV-GPS (docs/rules.md). Computed once per trip by the
 * Google Routes API from the loading point to the (geocoded) delivery point; ops can approve an
 * alternate route, which also counts as on-route and becomes the basis for the ETA.
 */
export class TripRoutes1759680000000 implements MigrationInterface {
  name = 'TripRoutes1759680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.trip_routes (
        id           uuid PRIMARY KEY,
        trip_id      uuid        NOT NULL,
        version      int         NOT NULL,
        kind         text        NOT NULL CHECK (kind IN ('planned', 'approved_alternate')),
        polyline     text        NOT NULL,
        geom         geometry(LineString, 4326) NOT NULL,
        distance_m   double precision NOT NULL,
        duration_s   double precision,
        provider     text        NOT NULL,
        promised_at  timestamptz,
        created_by   uuid,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (trip_id, version)
      )`);

    // Route-planning status per trip, so the planner retries with back-off and the API can say
    // why a trip has no ETA (no API key, delivery point not geocodable, …).
    await queryRunner.query(`ALTER TABLE tracking.trips ADD COLUMN route_status text`);
    await queryRunner.query(
      `ALTER TABLE tracking.trips ADD COLUMN route_attempts int NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`ALTER TABLE tracking.trips ADD COLUMN route_checked_at timestamptz`);

    await queryRunner.query(`ALTER TABLE tracking.places ADD COLUMN geocoded_at timestamptz`);
    await queryRunner.query(`ALTER TABLE tracking.places ADD COLUMN geocode_source text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tracking.places DROP COLUMN geocode_source`);
    await queryRunner.query(`ALTER TABLE tracking.places DROP COLUMN geocoded_at`);
    await queryRunner.query(`ALTER TABLE tracking.trips DROP COLUMN route_checked_at`);
    await queryRunner.query(`ALTER TABLE tracking.trips DROP COLUMN route_attempts`);
    await queryRunner.query(`ALTER TABLE tracking.trips DROP COLUMN route_status`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.trip_routes`);
  }
}

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
        -- Google encoded polyline (precision 5); geometry is computed in-process (RouteGeometry),
        -- so no PostGIS is required.
        polyline     text        NOT NULL,
        distance_m   double precision NOT NULL,
        duration_s   double precision,
        provider     text        NOT NULL,
        promised_at  timestamptz,
        created_by   uuid,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (trip_id, version)
      )`);

    // Route-planning status per trip (trip id = the main backend's load id), so the planner
    // retries with back-off and the API can say why a trip has no ETA (no API key, delivery point
    // not geocodable, …).
    await queryRunner.query(`
      CREATE TABLE tracking.trip_route_status (
        trip_id     uuid PRIMARY KEY,
        status      text        NOT NULL,
        attempts    int         NOT NULL DEFAULT 0,
        checked_at  timestamptz NOT NULL DEFAULT now()
      )`);

    // The main backend stores delivery points as addresses only: geocoded coordinates are
    // tracking's own cache, one row per place, filled once.
    await queryRunner.query(`
      CREATE TABLE tracking.place_geocodes (
        place_id     uuid PRIMARY KEY,
        lat          double precision NOT NULL,
        lng          double precision NOT NULL,
        source       text        NOT NULL,
        geocoded_at  timestamptz NOT NULL DEFAULT now()
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.place_geocodes`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.trip_route_status`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.trip_routes`);
  }
}

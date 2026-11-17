import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The "approach" leg of a trip: the road route from the truck's first tracked point to the
 * loading point. Display-only — kept out of tracking.trip_routes so DELAY-GPS / DEV-GPS and the
 * ETA keep measuring against the loading → delivery route only. One row per trip, planned once;
 * a row with a null polyline means "checked, nothing to draw" (first point already at the plant,
 * or no route found), so the planner does not retry it.
 */
export class TripApproachRoutes1759710000000 implements MigrationInterface {
  name = 'TripApproachRoutes1759710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.trip_approach_routes (
        trip_id     uuid PRIMARY KEY,
        origin_lat  double precision NOT NULL,
        origin_lng  double precision NOT NULL,
        polyline    text,
        distance_m  double precision,
        duration_s  double precision,
        provider    text,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.trip_approach_routes`);
  }
}

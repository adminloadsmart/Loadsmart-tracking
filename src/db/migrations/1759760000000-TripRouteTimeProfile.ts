import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * trip_routes.time_profile: Google's per-step time along the route as cumulative
 * [metres, seconds] pairs, so the ETA knows a highway km is faster than a city or ghat km.
 * Null for ops-drawn polylines and routes planned before this column (uniform time then).
 */
export class TripRouteTimeProfile1759760000000 implements MigrationInterface {
  name = 'TripRouteTimeProfile1759760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tracking.trip_routes ADD COLUMN time_profile jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tracking.trip_routes DROP COLUMN time_profile`);
  }
}

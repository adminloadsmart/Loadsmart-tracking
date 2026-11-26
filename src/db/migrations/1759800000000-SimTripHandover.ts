import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Driver number changed mid-trip: the running Intugine trip is kept and moved to the new number.
 *
 * - sim_trips.carried_intugine_trip_id: the Intugine trip a row took over. The old row ends
 *   (`driver_changed`), the new row asks the new number for consent, and once allowed the trip's
 *   `tel` is updated in place (no second billed trip). Cleared when the row starts on it, or when
 *   that trip is ended because the new number never consented.
 * - sim_trips_intugine_trip_idx becomes unique among LIVE rows only: the ended row keeps its
 *   Intugine id (history), the new row takes the same id. One live owner per Intugine trip still
 *   holds.
 */
export class SimTripHandover1759800000000 implements MigrationInterface {
  name = 'SimTripHandover1759800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE tracking.sim_trips ADD COLUMN carried_intugine_trip_id text NULL`,
    );
    await queryRunner.query(`DROP INDEX tracking.sim_trips_intugine_trip_idx`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX sim_trips_intugine_trip_idx ON tracking.sim_trips (intugine_trip_id)
      WHERE intugine_trip_id IS NOT NULL
        AND state IN ('awaiting_consent', 'consented', 'active', 'paused')`);
  }

  /** Fails if a hand-over already left two rows on one Intugine trip (clear the ended row's id). */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX tracking.sim_trips_intugine_trip_idx`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX sim_trips_intugine_trip_idx ON tracking.sim_trips (intugine_trip_id)
      WHERE intugine_trip_id IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE tracking.sim_trips DROP COLUMN carried_intugine_trip_id`);
  }
}

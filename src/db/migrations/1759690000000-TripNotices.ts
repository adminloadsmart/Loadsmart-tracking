import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-off trip notices the main backend turns into notifications (route deviation, tracking
 * signal lost, delivery will be late): unlike alerts they have no lifecycle, only "sent once".
 * The id is deterministic (UUIDv5 of the trip + what happened), so a redelivered batch or a
 * repeated monitor tick inserts nothing and writes no second outbox row.
 */
export class TripNotices1759690000000 implements MigrationInterface {
  name = 'TripNotices1759690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.trip_notices (
        id          uuid PRIMARY KEY,
        tenant_id   uuid        NOT NULL,
        vehicle_id  uuid        NOT NULL,
        trip_id     uuid        NOT NULL,
        type        text        NOT NULL,
        payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX trip_notices_trip_idx ON tracking.trip_notices (trip_id, created_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tracking.trip_notices`);
  }
}

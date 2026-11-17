import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dwell milestones of a geofence visit: the truck stopped inside long enough to count as
 * arrived, or stayed long enough to be in detention. Kept beside the enter/exit log
 * (tracking.geofence_events, owned by the main backend, whose event enum is just enter/exit)
 * so the full visit — enter, arrival, detention, exit — can be rebuilt for disputes.
 */
export class GeofenceDwellEvents1759720000000 implements MigrationInterface {
  name = 'GeofenceDwellEvents1759720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.geofence_dwell_events (
        -- Deterministic (vehicle|geofence|kind|time): a redelivered batch inserts nothing new.
        id           uuid PRIMARY KEY,
        tenant_id    uuid        NOT NULL,
        geofence_id  uuid        NOT NULL,
        vehicle_id   uuid        NOT NULL,
        load_id      uuid,
        kind         text        NOT NULL CHECK (kind IN ('arrival', 'detention')),
        -- When the stop began (arrival) or the truck entered (detention).
        since        timestamptz NOT NULL,
        -- When the milestone was reached (stopped for the arrival wait / inside for the detention time).
        occurred_at  timestamptz NOT NULL,
        latitude     numeric(10,6) NOT NULL,
        longitude    numeric(10,6) NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX geofence_dwell_events_load_idx ON tracking.geofence_dwell_events (load_id, occurred_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX geofence_dwell_events_vehicle_idx ON tracking.geofence_dwell_events (tenant_id, vehicle_id, occurred_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tracking.geofence_dwell_events`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FASTag toll crossings through ULIP (docs/FASTTAG.md).
 *
 *  - fastag_crossings: one row per toll plaza a truck crossed while on a load, from the load's
 *    truck assignment until it left the tracked statuses. This is the stored history the API reads.
 *  - fastag_trips: one row per load being followed, the work list of the ULIP poller (window,
 *    when it was last polled, errors). Mirrors sim_trips.
 *
 * ULIP only keeps ~72 h of transactions per vehicle and returns them per vehicle, not per load, so
 * the poller copies the ones inside each load's window into fastag_crossings as it goes.
 */
export class FastagCrossings1759710000000 implements MigrationInterface {
  name = 'FastagCrossings1759710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.fastag_trips (
        id              uuid PRIMARY KEY,
        tenant_id       uuid        NOT NULL,
        -- The main backend's load id (our trip).
        load_id         uuid        NOT NULL,
        vehicle_id      uuid        NOT NULL,
        -- Normalized plate (upper case, no spaces or dashes): what is sent to ULIP.
        vehicle_number  text        NOT NULL,
        state           text        NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'closing', 'ended')),
        -- Crossings are kept only inside [window_start, window_end]. The start is the truck
        -- assignment; the end is set when the load leaves the tracked statuses.
        window_start    timestamptz NOT NULL,
        window_end      timestamptz,
        end_reason      text,
        last_polled_at  timestamptz,
        attempts        int         NOT NULL DEFAULT 0,
        last_error      text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )`);
    // One active row per load (a closing row waits for its last poll and no longer blocks a new one,
    // e.g. when the truck on the load is replaced).
    await queryRunner.query(`
      CREATE UNIQUE INDEX fastag_trips_active_load_idx ON tracking.fastag_trips (load_id)
      WHERE state = 'active'`);
    await queryRunner.query(`
      CREATE INDEX fastag_trips_state_idx ON tracking.fastag_trips (state)
      WHERE state IN ('active', 'closing')`);

    await queryRunner.query(`
      CREATE TABLE tracking.fastag_crossings (
        id              uuid PRIMARY KEY,
        tenant_id       uuid             NOT NULL,
        load_id         uuid             NOT NULL,
        vehicle_id      uuid             NOT NULL,
        vehicle_number  text             NOT NULL,
        -- ULIP's transaction id (seqNo): what makes a crossing unique.
        seq_no          text             NOT NULL,
        -- readerReadTime, read as India time (ULIP sends no zone).
        crossed_at      timestamptz      NOT NULL,
        toll_plaza_name text             NOT NULL,
        toll_lat        double precision,
        toll_lng        double precision,
        lane_direction  text,
        vehicle_type    text,
        -- The transaction exactly as ULIP returned it.
        raw             jsonb            NOT NULL,
        created_at      timestamptz      NOT NULL DEFAULT now(),
        UNIQUE (load_id, seq_no)
      )`);
    await queryRunner.query(`
      CREATE INDEX fastag_crossings_load_idx ON tracking.fastag_crossings (load_id, crossed_at)`);
    await queryRunner.query(`
      CREATE INDEX fastag_crossings_vehicle_idx
      ON tracking.fastag_crossings (vehicle_id, crossed_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.fastag_crossings`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.fastag_trips`);
  }
}

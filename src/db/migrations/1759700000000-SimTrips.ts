import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SIM tracking through Intugine, one row per trip (load). The driver gives consent by phone after
 * Intugine's consent SMS, so the only consent state here is the operator's. The Intugine trip is
 * started lazily — only when GPS and the driver app can't track the truck — because Intugine bills
 * by trip length; until then the row just follows the consent.
 *
 * Points themselves go to location_points with source 'sim' (source_ref = intugine_trip_id).
 */
export class SimTrips1759700000000 implements MigrationInterface {
  name = 'SimTrips1759700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.sim_trips (
        id                          uuid PRIMARY KEY,
        tenant_id                   uuid        NOT NULL,
        -- The main backend's load id (our trip). Intugine's own id is intugine_trip_id.
        load_id                     uuid        NOT NULL,
        vehicle_id                  uuid        NOT NULL,
        driver_id                   uuid,
        -- Normalized 10-digit number sent to Intugine (no country code).
        phone                       text        NOT NULL,
        operator                    text,
        operator_consent_status     text        NOT NULL DEFAULT 'pending'
          CHECK (operator_consent_status IN ('pending', 'allowed', 'not_registered', 'denied', 'unsupported')),
        -- What Intugine told the driver to do (e.g. "Send 's' to 5114040"), for ops.
        operator_consent_suggestion text,
        consent_requested_at        timestamptz,
        consent_last_checked_at     timestamptz,
        -- Past this with no approval the trip falls back to FASTag.
        consent_expires_at          timestamptz,
        state                       text        NOT NULL DEFAULT 'awaiting_consent'
          CHECK (state IN ('awaiting_consent', 'consented', 'active', 'paused', 'ended', 'unsupported', 'failed')),
        intugine_trip_id            text,
        started_at                  timestamptz,
        ended_at                    timestamptz,
        end_reason                  text,
        last_polled_at              timestamptz,
        -- recorded_at of the newest SIM point: the SIM silence rule measures from here.
        last_point_at               timestamptz,
        attempts                    int         NOT NULL DEFAULT 0,
        last_error                  text,
        -- Exactly what was sent to Intugine's start-trip API, for debugging.
        start_payload               jsonb,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now()
      )`);
    // One live SIM row per load.
    await queryRunner.query(`
      CREATE UNIQUE INDEX sim_trips_live_load_idx ON tracking.sim_trips (load_id)
      WHERE state NOT IN ('ended', 'unsupported', 'failed')`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX sim_trips_intugine_trip_idx ON tracking.sim_trips (intugine_trip_id)
      WHERE intugine_trip_id IS NOT NULL`);
    // Dispatcher scans: trips waiting on consent, trips being polled.
    await queryRunner.query(`
      CREATE INDEX sim_trips_state_idx ON tracking.sim_trips (state)
      WHERE state IN ('awaiting_consent', 'consented', 'active')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.sim_trips`);
  }
}

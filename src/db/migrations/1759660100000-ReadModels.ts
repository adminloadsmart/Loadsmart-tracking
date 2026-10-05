import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Local read models of the main loadsmart backend's data (docs/ROADMAP.md §8.1), maintained by
 * the sync module from the `loadsmart.events` snapshot stream. Tracking never queries the main
 * database. Each row keeps the snapshot `source_version` it was built from; an incoming snapshot
 * is applied only if its version is >= the stored one, so duplicates and out-of-order delivery
 * are harmless.
 */
export class ReadModels1759660100000 implements MigrationInterface {
  name = 'ReadModels1759660100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fleet vehicles keep their masters.vehicles id. Market trucks (loads with only a free-text
    // vehicle number) get a deterministic id derived from tenant + plate, so the same truck maps
    // to the same tracking vehicle across loads.
    await queryRunner.query(`
      CREATE TABLE tracking.vehicles (
        id                   uuid PRIMARY KEY,
        tenant_id            uuid        NOT NULL,
        kind                 text        NOT NULL CHECK (kind IN ('fleet', 'market')),
        registration_number  text        NOT NULL,
        status               text,
        gps_provider         text,
        gps_enabled          boolean     NOT NULL DEFAULT false,
        deleted_at           timestamptz,
        source_version       bigint      NOT NULL,
        synced_at            timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX vehicles_tenant_reg_idx ON tracking.vehicles (tenant_id, registration_number)`,
    );

    await queryRunner.query(`
      CREATE TABLE tracking.drivers (
        id              uuid PRIMARY KEY,
        tenant_id       uuid        NOT NULL,
        full_name       text        NOT NULL,
        phone_number    text        NOT NULL,
        status          text,
        deleted_at      timestamptz,
        source_version  bigint      NOT NULL,
        synced_at       timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX drivers_tenant_phone_idx ON tracking.drivers (tenant_id, phone_number)`,
    );

    // Loading points (origin) and customer delivery points (destination). Delivery points have
    // no coordinates in the main backend today — lat/lng stay null until geocoded (Phase 7).
    await queryRunner.query(`
      CREATE TABLE tracking.places (
        id              uuid PRIMARY KEY,
        tenant_id       uuid             NOT NULL,
        kind            text             NOT NULL CHECK (kind IN ('loading_point', 'delivery_point')),
        name            text             NOT NULL,
        address         text,
        city            text,
        state           text,
        pin_code        text,
        lat             double precision,
        lng             double precision,
        deleted_at      timestamptz,
        source_version  bigint           NOT NULL,
        synced_at       timestamptz      NOT NULL DEFAULT now()
      )`);

    // One trip per load (trip id = load id). tracking_state is derived from the load status:
    // pending (created/assigned) -> active (loading_confirmed .. reached_delivery_point) ->
    // ended (delivered/closed/deleted).
    await queryRunner.query(`
      CREATE TABLE tracking.trips (
        id                    uuid PRIMARY KEY,
        tenant_id             uuid        NOT NULL,
        load_code             text        NOT NULL,
        load_status           text        NOT NULL,
        source_type           text        NOT NULL CHECK (source_type IN ('own_fleet', 'market')),
        vehicle_id            uuid,
        vehicle_number        text,
        driver_id             uuid,
        driver_phone          text,
        driver_name           text,
        transporter_id        uuid,
        origin_place_id       uuid,
        destination_place_id  uuid,
        tracking_state        text        NOT NULL CHECK (tracking_state IN ('pending', 'active', 'ended')),
        tracking_started_at   timestamptz,
        tracking_ended_at     timestamptz,
        milestones            jsonb       NOT NULL DEFAULT '{}'::jsonb,
        deleted_at            timestamptz,
        source_version        bigint      NOT NULL,
        synced_at             timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX trips_tenant_state_idx ON tracking.trips (tenant_id, tracking_state)`,
    );
    await queryRunner.query(
      `CREATE INDEX trips_active_vehicle_idx ON tracking.trips (vehicle_id) WHERE tracking_state = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX trips_active_driver_idx ON tracking.trips (driver_id) WHERE tracking_state = 'active'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.trips`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.places`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.drivers`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.vehicles`);
  }
}

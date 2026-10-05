import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Derived events from the "Tracking Derivatives" rule sheet (docs/rules.md):
 *  - episodes:      every detected occurrence (a halt, an overspeed, a night drive, a no-data gap…)
 *                   with start/end, anchor and metrics — the trip and vehicle timelines read these
 *  - alerts:        what a person is told about, with severity, audience and an
 *                   open → acknowledged → closed lifecycle; one OPEN alert per dedupe key
 *  - rule_settings: per-tenant overrides of the sheet's default thresholds / switches
 *  - alert_outbox:  alert events relayed to the main backend (`tracking.events`) for push/SMS
 * Episode and alert ids are deterministic (UUIDv5 of vehicle + rule + start), so a redelivered
 * stream batch upserts the same rows instead of duplicating them.
 */
export class RulesAndAlerts1759670000000 implements MigrationInterface {
  name = 'RulesAndAlerts1759670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.episodes (
        id          uuid PRIMARY KEY,
        tenant_id   uuid        NOT NULL,
        vehicle_id  uuid        NOT NULL,
        trip_id     uuid,
        rule_id     text        NOT NULL,
        source      text        NOT NULL,
        status      text        NOT NULL CHECK (status IN ('open', 'closed')),
        started_at  timestamptz NOT NULL,
        ended_at    timestamptz,
        anchor_lat  double precision,
        anchor_lng  double precision,
        metrics     jsonb       NOT NULL DEFAULT '{}'::jsonb,
        tags        text[]      NOT NULL DEFAULT '{}',
        updated_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX episodes_trip_idx ON tracking.episodes (trip_id, started_at) WHERE trip_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX episodes_vehicle_idx ON tracking.episodes (vehicle_id, started_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE tracking.alerts (
        id                  uuid PRIMARY KEY,
        tenant_id           uuid        NOT NULL,
        vehicle_id          uuid        NOT NULL,
        trip_id             uuid,
        episode_id          uuid,
        rule_id             text        NOT NULL,
        trigger_code        text,
        severity            text        NOT NULL
                            CHECK (severity IN ('info', 'warning', 'medium', 'high', 'critical')),
        audience            text[]      NOT NULL,
        status              text        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'acknowledged', 'closed')),
        title               text        NOT NULL,
        payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
        dedupe_key          text        NOT NULL,
        repeat_count        int         NOT NULL DEFAULT 0,
        opened_at           timestamptz NOT NULL,
        occurred_at         timestamptz NOT NULL,
        acknowledged_by     uuid,
        acknowledged_at     timestamptz,
        closed_at           timestamptz,
        close_reason        text,
        reminder_every_min  int         NOT NULL DEFAULT 0,
        last_notified_at    timestamptz,
        updated_at          timestamptz NOT NULL DEFAULT now()
      )`);
    // "One open alert per trigger per vehicle": a repeat while one is open is merged into it.
    await queryRunner.query(
      `CREATE UNIQUE INDEX alerts_open_dedupe_idx ON tracking.alerts (dedupe_key) WHERE status <> 'closed'`,
    );
    await queryRunner.query(
      `CREATE INDEX alerts_tenant_status_idx ON tracking.alerts (tenant_id, status, opened_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX alerts_trip_idx ON tracking.alerts (trip_id) WHERE trip_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX alerts_vehicle_idx ON tracking.alerts (vehicle_id, opened_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE tracking.rule_settings (
        tenant_id   uuid        NOT NULL,
        rule_id     text        NOT NULL,
        enabled     boolean,
        params      jsonb       NOT NULL DEFAULT '{}'::jsonb,
        updated_by  uuid,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, rule_id)
      )`);

    await queryRunner.query(`
      CREATE TABLE tracking.alert_outbox (
        id          bigserial PRIMARY KEY,
        event_type  text        NOT NULL,
        payload     jsonb       NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);

    // Inputs some rules need from the main backend (see docs/contracts/loadsmart-events.md).
    await queryRunner.query(`ALTER TABLE tracking.vehicles ADD COLUMN body_type text`);
    await queryRunner.query(`ALTER TABLE tracking.trips ADD COLUMN customer_id uuid`);
    await queryRunner.query(
      `ALTER TABLE tracking.trips ADD COLUMN promised_delivery_at timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tracking.trips DROP COLUMN promised_delivery_at`);
    await queryRunner.query(`ALTER TABLE tracking.trips DROP COLUMN customer_id`);
    await queryRunner.query(`ALTER TABLE tracking.vehicles DROP COLUMN body_type`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.alert_outbox`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.rule_settings`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.alerts`);
    await queryRunner.query(`DROP TABLE IF EXISTS tracking.episodes`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trips created from the tracking screen's "Create trip" drawer — tracked without a load. A load
 * trip is still the main backend's loads.loads row; this table only holds trips that have no load
 * behind them. GET /trips and /trips/:tripId return both kinds, so the id here is the trip id the
 * UI routes on.
 *
 * Places are stored by value (name/address/city) with an optional master reference: a picked
 * loading point (masters.loading_points) or customer address (customers.customer_delivery_points)
 * keeps its id so the map can read its coordinates; a typed-in address has none.
 */
export class Trips1759770000000 implements MigrationInterface {
  name = 'Trips1759770000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.trips (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                 uuid        NOT NULL,
        -- Per-tenant display code, e.g. TRP-0001.
        code                      text        NOT NULL,
        status                    text        NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'ended', 'cancelled')),
        direction                 text CHECK (direction IN ('in', 'out')),

        customer_id               uuid,
        customer_name             text,

        origin_kind               text        NOT NULL
          CHECK (origin_kind IN ('loading_point', 'customer_address', 'address')),
        origin_ref_id             uuid,
        origin_name               text        NOT NULL,
        origin_address            text        NOT NULL,
        origin_city               text,
        destination_kind          text        NOT NULL
          CHECK (destination_kind IN ('loading_point', 'customer_address', 'address')),
        destination_ref_id        uuid,
        destination_name          text        NOT NULL,
        destination_address       text        NOT NULL,
        destination_city          text,

        vehicle_number            text        NOT NULL,
        driver_phone              text        NOT NULL,
        driver_name               text,
        driver_licence_number     text,
        driver_date_of_birth      date,
        transporter_id            uuid,
        transporter_name          text,
        transporter_phone         text,

        loading_reporting_at      timestamptz,
        delivery_mode             text CHECK (delivery_mode IN ('reporting', 'appointment')),
        delivery_reporting_at     timestamptz,
        appointment_ref           text,
        appointment_from          timestamptz,
        appointment_to            timestamptz,
        eway_bill_number          text,
        eway_bill_valid_till      timestamptz,

        created_by                uuid        NOT NULL,
        ended_at                  timestamptz,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT trips_tenant_code_unique UNIQUE (tenant_id, code)
      )`);
    // The tracking screen lists a tenant's trips by status, newest first.
    await queryRunner.query(
      `CREATE INDEX trips_tenant_status_created_idx ON tracking.trips (tenant_id, status, created_at DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tracking.trips`);
  }
}

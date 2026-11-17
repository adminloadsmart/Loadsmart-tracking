import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SIM consent per driver mobile number, reused across loads. Until now consent lived on each
 * sim_trips row (per load), so a driver who had approved one load was asked again for the next.
 * The consent belongs to the number: given once, it is valid for about 9 months and covers every
 * load that driver is on.
 *
 *  - sent_at         when Intugine last texted the number (a pending number is texted on each check)
 *  - given_at        when the operator first reported the number as ALLOWED
 *  - valid_until     given_at + the validity (9 months by default)
 *  - withdrawn_at    when a consent that had been valid stopped being allowed (revoked)
 *
 * sim_trips.consent_reused records that the load found a valid consent already on file, which the
 * console shows as "Valid" (against "Given" when the driver answered this load's SMS).
 */
export class SimConsents1759740000000 implements MigrationInterface {
  name = 'SimConsents1759740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tracking.sim_consents (
        -- Normalized 10-digit number, as sent to Intugine.
        phone            text PRIMARY KEY,
        operator         text,
        status           text        NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'allowed', 'not_registered', 'denied', 'unsupported')),
        suggestion       text,
        first_sent_at    timestamptz,
        sent_at          timestamptz,
        given_at         timestamptz,
        valid_until      timestamptz,
        withdrawn_at     timestamptz,
        last_checked_at  timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `ALTER TABLE tracking.sim_trips ADD COLUMN consent_reused boolean NOT NULL DEFAULT false`,
    );
    // Numbers already approved on an earlier load stay approved: carry them over (given when we
    // last saw them allowed), valid for the same 9 months from then.
    await queryRunner.query(`
      INSERT INTO tracking.sim_consents
        (phone, operator, status, suggestion, first_sent_at, sent_at, given_at, valid_until,
         last_checked_at)
      SELECT DISTINCT ON (phone)
        phone, operator, 'allowed', operator_consent_suggestion, consent_requested_at,
        consent_requested_at, COALESCE(consent_last_checked_at, consent_requested_at, created_at),
        COALESCE(consent_last_checked_at, consent_requested_at, created_at) + interval '9 months',
        consent_last_checked_at
      FROM tracking.sim_trips
      WHERE operator_consent_status = 'allowed'
      ORDER BY phone, consent_last_checked_at DESC NULLS LAST
      ON CONFLICT (phone) DO NOTHING`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tracking.sim_trips DROP COLUMN consent_reused`);
    await queryRunner.query(`DROP TABLE tracking.sim_consents`);
  }
}

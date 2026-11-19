import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * sim_trips.consent_stage: the furthest load stage at which the consent was re-checked on purpose
 * (0 none, 1 in_transit_loading, 2 reached_loading, 3 in_transit_unloading). Each stage re-checks
 * a still-pending consent once, on top of the hourly re-check, so a skipped status still gets
 * exactly one check.
 */
export class SimConsentStage1759750000000 implements MigrationInterface {
  name = 'SimConsentStage1759750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE tracking.sim_trips ADD COLUMN consent_stage smallint NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tracking.sim_trips DROP COLUMN consent_stage`);
  }
}

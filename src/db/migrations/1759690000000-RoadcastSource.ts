import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The GPS device source is Roadcast, not BlackRock BR05: rename the allowed point source. No
 * BlackRock ingest ever shipped, so there are no 'blackrock' rows to rewrite.
 */
const TABLES = ['location_points', 'location_points_short'] as const;

function setSources(name: string, sources: string[]): string {
  const list = sources.map((source) => `'${source}'`).join(', ');
  return `ALTER TABLE tracking.${name}
            DROP CONSTRAINT IF EXISTS ${name}_source_check,
            ADD CONSTRAINT ${name}_source_check CHECK (source IN (${list}))`;
}

export class RoadcastSource1759690000000 implements MigrationInterface {
  name = 'RoadcastSource1759690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const name of TABLES) {
      await queryRunner.query(setSources(name, ['driver_app', 'roadcast', 'sim']));
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of TABLES) {
      await queryRunner.query(setSources(name, ['driver_app', 'blackrock', 'sim']));
    }
  }
}

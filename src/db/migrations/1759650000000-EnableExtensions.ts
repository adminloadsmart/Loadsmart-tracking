import { MigrationInterface, QueryRunner } from 'typeorm';

// Foundation for every later migration: TimescaleDB (location_points hypertable, compression,
// continuous aggregates) and PostGIS (boundaries, geofences, ST_Covers), plus the service's own
// schema. Both extensions ship in the timescale/timescaledb-ha image used in docker-compose/CI.
export class EnableExtensions1759650000000 implements MigrationInterface {
  name = 'EnableExtensions1759650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS tracking`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // RESTRICT (the default): refuse to drop the schema if later migrations' tables still exist.
    await queryRunner.query(`DROP SCHEMA IF EXISTS tracking`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS postgis`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS timescaledb`);
  }
}

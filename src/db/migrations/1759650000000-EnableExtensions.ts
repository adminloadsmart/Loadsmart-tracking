import { MigrationInterface, QueryRunner } from 'typeorm';
import { availableExtensions } from '../db-features';

// Foundation for every later migration: the service's own schema, plus TimescaleDB
// (location_points hypertables, compression, continuous aggregates) and PostGIS WHEN the server
// has them — both ship in the timescale/timescaledb-ha image used in docker-compose/CI. On plain
// PostgreSQL (e.g. sharing the main loadsmart database in development) they're skipped and the
// service uses its plain-table path (see db-features.ts, LocationPoints migration).
export class EnableExtensions1759650000000 implements MigrationInterface {
  name = 'EnableExtensions1759650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const available = await availableExtensions(queryRunner);
    if (available.has('timescaledb'))
      await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
    if (available.has('postgis')) await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    // IF NOT EXISTS: the main backend may already have a `tracking` schema in a shared database.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS tracking`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Deliberately nothing: the schema and extensions may be shared with the main backend's
    // database objects. Later migrations' down() remove this service's own tables.
  }
}

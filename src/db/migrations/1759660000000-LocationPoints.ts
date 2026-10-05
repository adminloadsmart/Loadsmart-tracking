import { MigrationInterface, QueryRunner } from 'typeorm';
import { detectFeatures } from '../db-features';

/**
 * Location time series (docs/ROADMAP.md §6).
 *
 * Two hypertables with identical shape, split by RETENTION CLASS rather than by source, so
 * retention is a cheap whole-chunk drop instead of per-row DELETEs over compressed data:
 *  - location_points        points that belong to a trip (shown on the trip track) — 90 days raw
 *  - location_points_short  idle-vehicle points (no active trip) and, from Phase 6, points from a
 *                           trip's non-active sources — 7 days raw
 * Both roll up into 1-minute continuous aggregates kept for 12 months (vehicle timeline, trip
 * overview tracks, analytics). Windows are the roadmap defaults; change them in a new migration
 * via remove_/add_retention_policy.
 *
 * Idempotent writes: UNIQUE (vehicle_id, source, recorded_at) + INSERT ... ON CONFLICT DO NOTHING
 * (the time column must be part of any unique index on a hypertable).
 *
 * Without TimescaleDB (plain PostgreSQL) the same tables are created as ordinary tables with the
 * same indexes; retention then runs as a scheduled batch DELETE (points/retention.job.ts) and the
 * rollup views don't exist (timelines aggregate the raw rows instead).
 */
const TABLES = [
  { name: 'location_points', rawRetention: '90 days' },
  { name: 'location_points_short', rawRetention: '7 days' },
] as const;

const CAGG_RETENTION = '365 days';

export class LocationPoints1759660000000 implements MigrationInterface {
  name = 'LocationPoints1759660000000';
  // Continuous aggregates can't be created inside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { timescale } = await detectFeatures(queryRunner);
    for (const { name, rawRetention } of TABLES) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS tracking.${name} (
          tenant_id    uuid             NOT NULL,
          vehicle_id   uuid             NOT NULL,
          trip_id      uuid,
          source       text             NOT NULL CHECK (source IN ('driver_app', 'blackrock', 'sim')),
          source_ref   text             NOT NULL,
          recorded_at  timestamptz      NOT NULL,
          received_at  timestamptz      NOT NULL,
          lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
          lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
          speed_kmh    real,
          heading      real,
          accuracy_m   real,
          flags        jsonb,
          CONSTRAINT ${name}_dedup UNIQUE (vehicle_id, source, recorded_at)
        )`);
      if (timescale) {
        await queryRunner.query(
          `SELECT create_hypertable('tracking.${name}', by_range('recorded_at', INTERVAL '1 day'), if_not_exists => true)`,
        );
      }
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS ${name}_vehicle_time_idx ON tracking.${name} (vehicle_id, recorded_at DESC)`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS ${name}_trip_time_idx ON tracking.${name} (trip_id, recorded_at) WHERE trip_id IS NOT NULL`,
      );

      // Plain PostgreSQL: an index for the retention job's range deletes, and nothing more.
      if (!timescale) {
        await queryRunner.query(
          `CREATE INDEX IF NOT EXISTS ${name}_time_idx ON tracking.${name} (recorded_at)`,
        );
        continue;
      }

      // Compression after 2 days: segment by vehicle so per-vehicle reads stay cheap.
      await queryRunner.query(`
        ALTER TABLE tracking.${name} SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'vehicle_id',
          timescaledb.compress_orderby = 'recorded_at DESC'
        )`);
      await queryRunner.query(
        `SELECT add_compression_policy('tracking.${name}', INTERVAL '2 days', if_not_exists => true)`,
      );
      await queryRunner.query(
        `SELECT add_retention_policy('tracking.${name}', INTERVAL '${rawRetention}', if_not_exists => true)`,
      );

      // 1-minute rollup. Materialized-only (no real-time union) — callers needing the last few
      // minutes read the raw table, which is always present for at least 7 days.
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS tracking.${name}_1min
        WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
        SELECT
          time_bucket(INTERVAL '1 minute', recorded_at) AS bucket,
          tenant_id,
          vehicle_id,
          trip_id,
          source,
          last(lat, recorded_at)  AS lat,
          last(lng, recorded_at)  AS lng,
          max(speed_kmh)          AS max_speed_kmh,
          avg(speed_kmh)::real    AS avg_speed_kmh,
          count(*)::int           AS point_count
        FROM tracking.${name}
        GROUP BY bucket, tenant_id, vehicle_id, trip_id, source
        WITH NO DATA`);
      // Refresh well inside the raw retention window so nothing is dropped before it's rolled up.
      await queryRunner.query(`
        SELECT add_continuous_aggregate_policy('tracking.${name}_1min',
          start_offset => INTERVAL '3 days',
          end_offset => INTERVAL '1 minute',
          schedule_interval => INTERVAL '5 minutes',
          if_not_exists => true)`);
      await queryRunner.query(
        `SELECT add_retention_policy('tracking.${name}_1min', INTERVAL '${CAGG_RETENTION}', if_not_exists => true)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { name } of [...TABLES].reverse()) {
      await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS tracking.${name}_1min`);
      await queryRunner.query(`DROP TABLE IF EXISTS tracking.${name}`);
    }
  }
}

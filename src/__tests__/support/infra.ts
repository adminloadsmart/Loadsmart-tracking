import Redis from 'ioredis';
import pino from 'pino';
import { Client } from 'pg';
import { DataSource, MigrationInterface } from 'typeorm';
import { MAIN_SCHEMA_SQL, MAIN_TABLES } from './constants/main-schema';

/**
 * Integration-test infrastructure: an isolated `tracking_test` database (created and migrated on
 * demand) and Redis logical db 15, on the docker-compose ports by default. Suites call
 * `infraAvailable()` and `describe.skipIf(!available)` so plain `npm test` still passes on a
 * machine without the infra running.
 */
const PG_BASE = process.env.TEST_PG_URL ?? 'postgresql://postgres:postgres@localhost:5433';
const TEST_DB = 'tracking_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/15';

export const silentLogger = pino({ level: 'silent' });

export async function infraAvailable(): Promise<boolean> {
  const redis = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  const pg = new Client({ connectionString: `${PG_BASE}/postgres`, connectionTimeoutMillis: 1000 });
  try {
    await redis.connect();
    await redis.ping();
    await pg.connect();
    await pg.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
    await pg.end().catch(() => undefined);
  }
}

function loadMigrations(): Array<new () => MigrationInterface> {
  // Vite resolves this at transform time; TypeORM's own glob loading would `require` raw .ts.
  const modules = import.meta.glob('../../db/migrations/*.ts', { eager: true }) as Record<
    string,
    Record<string, new () => MigrationInterface>
  >;
  return Object.values(modules).flatMap((mod) => Object.values(mod));
}

const dataSources = new Map<string, DataSource>();

/** Migrated test database, shared by every suite in the run. */
export function testDataSource(): Promise<DataSource> {
  return migratedDatabase(TEST_DB);
}

/**
 * A fresh, migrated database by name. With `plain: true` the migrations run as on a server
 * without TimescaleDB/PostGIS (TRACKING_DB_EXTENSIONS=none) — the shared-main-database setup.
 */
export async function migratedDatabase(name: string, { plain = false } = {}): Promise<DataSource> {
  const existing = dataSources.get(name);
  if (existing?.isInitialized) return existing;

  const admin = new Client({ connectionString: `${PG_BASE}/postgres` });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dataSource = new DataSource({
    type: 'postgres',
    url: `${PG_BASE}/${name}`,
    migrations: loadMigrations(),
    migrationsTransactionMode: 'each',
    migrationsTableName: 'tracking_migrations',
    logging: false,
  });
  await dataSource.initialize();
  if (plain) {
    // The timescaledb-ha image pre-installs extensions in template1, so new databases inherit
    // them; remove them to look like a plain PostgreSQL server.
    await dataSource.query(
      `DROP EXTENSION IF EXISTS timescaledb_toolkit, timescaledb, postgis_topology, postgis CASCADE`,
    );
  }
  // The main backend's tables live in the same database; tests get the slice tracking reads.
  await dataSource.query(MAIN_SCHEMA_SQL);
  const previous = process.env.TRACKING_DB_EXTENSIONS;
  if (plain) process.env.TRACKING_DB_EXTENSIONS = 'none';
  try {
    await dataSource.runMigrations();
  } finally {
    if (plain) {
      if (previous === undefined) delete process.env.TRACKING_DB_EXTENSIONS;
      else process.env.TRACKING_DB_EXTENSIONS = previous;
    }
  }
  dataSources.set(name, dataSource);
  return dataSource;
}

export async function truncateTrackingTables(ds: DataSource): Promise<void> {
  await ds.query(
    `TRUNCATE tracking.location_points, tracking.location_points_short, tracking.episodes,
              tracking.alerts, tracking.rule_settings, tracking.alert_outbox, tracking.trip_routes,
              tracking.trip_route_status, tracking.place_geocodes, ${MAIN_TABLES}`,
  );
}

export function testRedis(): Redis {
  return new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
}

export async function waitFor(
  condition: () => Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** Runs everything currently on the point stream through a processing handler once (no consumer
 *  group) — deterministic processing for integration tests. */
export async function drainPointStreams(
  redis: Redis,
  keys: string[],
  handle: (
    stream: string,
    entries: Array<{ id: string; fields: Record<string, string> }>,
  ) => Promise<unknown>,
): Promise<number> {
  let processed = 0;
  for (const key of keys) {
    const raw = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
    if (raw.length === 0) continue;
    const entries = raw.map(([id, flat]) => ({ id, fields: { [flat[0]]: flat[1] } }));
    await handle(key, entries);
    processed += entries.length;
    await redis.del(key);
  }
  return processed;
}

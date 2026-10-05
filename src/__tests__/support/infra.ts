import Redis from 'ioredis';
import pino from 'pino';
import { Client } from 'pg';
import { DataSource, MigrationInterface } from 'typeorm';

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

let dataSource: DataSource | null = null;

/** Migrated test database, shared by every suite in the run. */
export async function testDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;

  const admin = new Client({ connectionString: `${PG_BASE}/postgres` });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  dataSource = new DataSource({
    type: 'postgres',
    url: `${PG_BASE}/${TEST_DB}`,
    migrations: loadMigrations(),
    migrationsTransactionMode: 'each',
    logging: false,
  });
  await dataSource.initialize();
  await dataSource.runMigrations();
  return dataSource;
}

export async function truncateTrackingTables(ds: DataSource): Promise<void> {
  await ds.query(
    `TRUNCATE tracking.location_points, tracking.location_points_short, tracking.trips,
              tracking.vehicles, tracking.drivers, tracking.places`,
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

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import pino from 'pino';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infraAvailable, migratedDatabase } from '../../__tests__/support/infra';
import { detectFeatures } from '../../db/db-features';
import { decodePolyline } from '../routes/route-geometry';
import { TrackingApiRepository } from '../tracking-api/tracking-api.repository';
import { PointRepository } from './point.repository';
import { PointRetentionJob } from './retention.job';

const available = await infraAvailable();
const DB = 'tracking_plain_test';
const TENANT = randomUUID();

/**
 * The service on PLAIN PostgreSQL — no TimescaleDB, no PostGIS — as when it shares the main
 * loadsmart database in development: migrations, writes, tracks, timelines and retention.
 */
describe.skipIf(!available)('plain PostgreSQL (no TimescaleDB / PostGIS)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const admin = new Client({
      connectionString: 'postgresql://postgres:postgres@localhost:5433/postgres',
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
    ds = await migratedDatabase(DB, { plain: true });
  });
  afterAll(async () => {
    await ds?.destroy();
  });

  it('migrates without creating extensions, with plain tables and its own migrations table', async () => {
    expect(await detectFeatures(ds)).toEqual({ timescale: false, postgis: false });
    const tables = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'tracking' ORDER BY 1`,
    );
    expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual(
      expect.arrayContaining([
        'location_points',
        'location_points_short',
        'trip_route_status',
        'place_geocodes',
        'alerts',
        'alert_outbox',
        'trip_routes',
      ]),
    );
    expect(await ds.query(`SELECT count(*)::int AS n FROM public.tracking_migrations`)).toEqual([
      { n: 4 },
    ]);
    expect(await ds.query(`SELECT to_regclass('public.migrations') AS t`)).toEqual([{ t: null }]);
    // Tracking keeps no copies of the main backend's data (it reads main's tables directly).
    for (const copy of ['trips', 'vehicles', 'drivers', 'places']) {
      expect(await ds.query(`SELECT to_regclass('tracking.${copy}') AS t`)).toEqual([{ t: null }]);
    }
  });

  it('stores points, builds a simplified track, and aggregates long timelines per minute', async () => {
    const vehicleId = randomUUID();
    const tripId = randomUUID();
    const start = Date.now() - 3 * 3_600_000;
    const points = Array.from({ length: 120 }, (_, i) => ({
      tenantId: TENANT,
      vehicleId,
      tripId,
      source: 'driver_app' as const,
      sourceRef: 'd1',
      recordedAt: new Date(start + i * 15_000).toISOString(),
      receivedAt: new Date().toISOString(),
      lat: Number((28.6 + i * 0.001).toFixed(6)),
      lng: Number((77.2 + (i % 2) * 0.00002).toFixed(6)),
      speedKmh: 50,
      heading: 0,
      accuracyM: 5,
      flags: null,
    }));
    const repo = new PointRepository(ds);
    expect(await repo.insertMany('location_points', points)).toBe(120);
    expect(await repo.insertMany('location_points', points)).toBe(0); // idempotent

    const api = new TrackingApiRepository(ds);
    const full = await api.tripPolyline(tripId, null, 0);
    const low = await api.tripPolyline(tripId, null, 0.0005);
    expect(full.point_count).toBe(120);
    expect(decodePolyline(full.polyline!)).toHaveLength(120);
    expect(decodePolyline(low.polyline!).length).toBeLessThan(5); // zig-zag removed, ends kept

    // > 24 h window → one point per minute (raw aggregation, no rollup views here).
    const rollup = await api.vehicleTimelinePolyline(
      vehicleId,
      new Date(start - 86_400_000),
      new Date(),
      0,
      true,
    );
    // 120 fixes × 15 s = 30 minutes, which touch 30 or 31 minute buckets depending on alignment.
    expect(rollup.point_count).toBeGreaterThanOrEqual(30);
    expect(rollup.point_count).toBeLessThanOrEqual(31);
  });

  it('retention job deletes expired raw points (TimescaleDB would drop chunks instead)', async () => {
    const vehicleId = randomUUID();
    const old = (days: number) => ({
      tenantId: TENANT,
      vehicleId,
      tripId: null,
      source: 'driver_app' as const,
      sourceRef: 'd1',
      recordedAt: new Date(Date.now() - days * 86_400_000).toISOString(),
      receivedAt: new Date().toISOString(),
      lat: 28.6,
      lng: 77.2,
      speedKmh: 0,
      heading: 0,
      accuracyM: 5,
      flags: null,
    });
    await new PointRepository(ds).insertMany('location_points_short', [old(8), old(10), old(1)]);
    expect(await new PointRetentionJob(ds, pino({ level: 'silent' })).run()).toBeGreaterThanOrEqual(
      2,
    );
    const left = await ds.query(
      `SELECT count(*)::int AS n FROM tracking.location_points_short WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(left).toEqual([{ n: 1 }]);
  });
});

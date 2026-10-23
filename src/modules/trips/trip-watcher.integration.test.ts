import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  infraAvailable,
  silentLogger,
  testDataSource,
  testRedis,
  truncateTrackingTables,
} from '../../__tests__/support/infra';
import { seedLoad, updateLoad } from '../../__tests__/support/main-schema';
import { driverActiveTripKey, tripRefKey, vehicleActiveTripKey } from './active-trip-index';
import { createTripsModule, TripWatcher } from './index';
import { marketVehicleId } from './trip-state';

const available = await infraAvailable();
const TENANT = '11111111-1111-4111-8111-111111111111';

/** Trips are the main backend's loads, read directly; the watcher keeps the Redis index in step. */
describe.skipIf(!available)('TripWatcher + main-data (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let trips: ReturnType<typeof createTripsModule>;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    trips = createTripsModule(ds, redis, silentLogger);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('indexes a load from assignment until delivery, with its GPS device on the on-trip registry', async () => {
    const load = await seedLoad(ds, { tenantId: TENANT, status: 'assigned', startedAt: null });
    await ds.query(
      `INSERT INTO masters.vehicle_telemetry_meta (tenant_id, vehicle_id, gps_device_imei)
       VALUES ($1, $2, '866221070401935')`,
      [TENANT, load.vehicleId],
    );
    // Assigned: indexed for the drive to the plant (geofence check), not yet tracking.
    await trips.watcher.poll();
    expect(await redis.get(vehicleActiveTripKey(load.vehicleId!))).toBe(load.loadId);
    expect(await redis.hget(tripRefKey(load.loadId), 'loadStatus')).toBe('assigned');
    expect((await trips.activeTrips.onTripDevicesByTenant()).get(TENANT)).toEqual([
      { imei: '866221070401935', vehicleId: load.vehicleId, tenantId: TENANT },
    ]);

    const confirmedAt = new Date('2026-10-06T08:00:00Z');
    await updateLoad(ds, load.loadId, {
      status: 'loading_confirmed',
      loading_confirmed_at: confirmedAt,
    });
    await trips.watcher.poll();
    expect(await redis.get(vehicleActiveTripKey(load.vehicleId!))).toBe(load.loadId);
    expect(await redis.get(driverActiveTripKey(load.driverId!))).toBe(load.loadId);
    expect(await redis.hgetall(tripRefKey(load.loadId))).toMatchObject({
      tenantId: TENANT,
      loadStatus: 'loading_confirmed',
      startedAtMs: String(confirmedAt.getTime()),
    });

    await updateLoad(ds, load.loadId, { status: 'in_transit' });
    await trips.watcher.poll();
    expect(await redis.hget(tripRefKey(load.loadId), 'loadStatus')).toBe('in_transit');

    await updateLoad(ds, load.loadId, { status: 'delivered', delivered_at: new Date() });
    await trips.watcher.poll();
    expect(await redis.get(vehicleActiveTripKey(load.vehicleId!))).toBeNull();
    expect(await redis.exists(tripRefKey(load.loadId))).toBe(0);
    expect(await trips.activeTrips.onTripDevicesByTenant()).toEqual(new Map());
  });

  it('pages through more loads than one page holds, even when they share an updated_at', async () => {
    const loads = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        seedLoad(ds, { tenantId: TENANT, code: `LOAD-P${i}`, registrationNumber: `MH12PG000${i}` }),
      ),
    );
    // A bulk update in main: every row gets the same updated_at, with microseconds (finer than
    // the JS Date the watcher pages with).
    await ds.query(
      `UPDATE loads.loads SET updated_at = '2026-10-06T08:00:00.123456Z' WHERE tenant_id = $1`,
      [TENANT],
    );

    const watcher = new TripWatcher(trips.mainData, trips.activeTrips, redis, silentLogger, 2);
    expect(await watcher.poll()).toBe(5);
    for (const load of loads) {
      expect(await redis.get(driverActiveTripKey(load.driverId!))).toBe(load.loadId);
    }
  });

  it('releases the old driver when a load is reassigned', async () => {
    const load = await seedLoad(ds, { tenantId: TENANT });
    await trips.watcher.poll();
    const newDriver = randomUUID();
    await updateLoad(ds, load.loadId, { driver_id: newDriver });
    await trips.watcher.poll();
    expect(await redis.get(driverActiveTripKey(load.driverId!))).toBeNull();
    expect(await redis.get(driverActiveTripKey(newDriver))).toBe(load.loadId);
  });

  it('market trucks get a stable vehicle id from the plate (no vehicle row needed)', async () => {
    const load = await seedLoad(ds, {
      tenantId: TENANT,
      sourceType: 'market',
      vehicleNumber: 'mh12 ab-9999',
    });
    await trips.watcher.poll();
    expect(await redis.get(vehicleActiveTripKey(marketVehicleId(TENANT, 'MH12AB9999')))).toBe(
      load.loadId,
    );
    const fleet = await trips.mainData.vehicles({ tenantId: TENANT }, 100);
    expect(fleet).toEqual([
      expect.objectContaining({ kind: 'market', registrationNumber: 'MH12AB9999' }),
    ]);
  });

  it('rebuild restores the index from the loads table and removes stale keys', async () => {
    const load = await seedLoad(ds, { tenantId: TENANT });
    await redis.set(vehicleActiveTripKey(randomUUID()), 'stale');
    const result = await trips.watcher.rebuild();
    expect(result.removed).toBe(1);
    expect(await redis.get(vehicleActiveTripKey(load.vehicleId!))).toBe(load.loadId);
  });

  it('main-data: truck type body type (tanker), promised delivery at 23:59 IST', async () => {
    const load = await seedLoad(ds, {
      tenantId: TENANT,
      bodyType: 'tanker',
      expectedDeliveryDate: '2026-10-07',
    });
    expect(await trips.mainData.bodyTypes([load.vehicleId!])).toEqual(
      new Map([[load.vehicleId!, 'tanker']]),
    );
    const row = await trips.mainData.load({ tenantId: TENANT }, load.loadId);
    expect(row?.promisedDeliveryAt?.toISOString()).toBe('2026-10-07T18:29:00.000Z');
    expect(await trips.mainData.load({ tenantId: randomUUID() }, load.loadId)).toBeNull(); // tenant-scoped
  });
});

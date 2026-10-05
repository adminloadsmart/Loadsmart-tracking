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
import { driverActiveTripKey, vehicleActiveTripKey } from './active-trip-index';
import { LoadPayload, parseSnapshot } from './sync.contract';
import { createSyncModule } from './index';
import { marketVehicleId } from './trip-state';

const available = await infraAvailable();

const TENANT = '11111111-1111-4111-8111-111111111111';

function loadPayload(overrides: Partial<LoadPayload> = {}): LoadPayload {
  return {
    code: 'LOAD-0001',
    status: 'assigned',
    sourceType: 'own_fleet',
    vehicleId: randomUUID(),
    vehicleNumber: 'MH12AB1234',
    driverId: randomUUID(),
    driverNumber: '9876543210',
    driverName: 'Ravi',
    transporterId: null,
    loadingPointId: null,
    deliveryPointId: null,
    milestones: {
      loadingConfirmedAt: null,
      atPlantAt: null,
      inTransitAt: null,
      reachedDeliveryPointAt: null,
      deliveredAt: null,
    },
    ...overrides,
  };
}

/** Builds stream fields exactly as the main backend's relay will, then parses them. */
function snapshot(type: string, id: string, version: number, payload: unknown | null) {
  return parseSnapshot({
    type,
    id,
    tenantId: TENANT,
    version: String(version),
    deleted: payload === null ? 'true' : 'false',
    ...(payload === null ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe.skipIf(!available)('SyncService (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let sync: ReturnType<typeof createSyncModule>;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    sync = createSyncModule(ds, redis, silentLogger);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
  });
  afterAll(async () => {
    await redis.quit();
  });

  const trip = async (id: string) =>
    (await ds.query(`SELECT * FROM tracking.trips WHERE id = $1`, [id]))[0];

  it('upserts vehicles, drivers and places; ignores stale versions; keeps fields on tombstones', async () => {
    const vehicleId = randomUUID();
    const vehicle = {
      registrationNumber: 'MH12AB1234',
      status: 'active',
      gpsProvider: 'blackrock',
      gpsEnabled: true,
      gpsDeviceImei: '359339077123456',
    };
    expect(await sync.service.apply(snapshot('vehicle', vehicleId, 2, vehicle))).toBe(true);
    expect(
      await sync.service.apply(snapshot('vehicle', vehicleId, 1, { ...vehicle, status: 'stale' })),
    ).toBe(false);
    expect(await sync.service.apply(snapshot('vehicle', vehicleId, 3, null))).toBe(true);

    const [row] = await ds.query(`SELECT * FROM tracking.vehicles WHERE id = $1`, [vehicleId]);
    expect(row).toMatchObject({
      gps_device_imei: '359339077123456',
      kind: 'fleet',
      status: 'active',
      gps_provider: 'blackrock',
      gps_enabled: true,
    });
    expect(row.deleted_at).not.toBeNull();

    const placeId = randomUUID();
    await sync.service.apply(
      snapshot('loading_point', placeId, 1, {
        name: 'Plant A',
        address: 'Plot 1',
        city: 'Delhi',
        state: 'DL',
        pinCode: '110001',
        lat: 28.61,
        lng: 77.2,
      }),
    );
    const [place] = await ds.query(`SELECT kind, name, lat FROM tracking.places WHERE id = $1`, [
      placeId,
    ]);
    expect(place).toEqual({ kind: 'loading_point', name: 'Plant A', lat: 28.61 });

    const driverId = randomUUID();
    await sync.service.apply(
      snapshot('driver', driverId, 1, {
        fullName: 'Ravi',
        phoneNumber: '9876543210',
      }),
    );
    const [driver] = await ds.query(`SELECT full_name FROM tracking.drivers WHERE id = $1`, [
      driverId,
    ]);
    expect(driver.full_name).toBe('Ravi');
  });

  it('runs the trip lifecycle and keeps the Redis active-trip index in step', async () => {
    const loadId = randomUUID();
    const payload = loadPayload();
    const vehicleKey = vehicleActiveTripKey(payload.vehicleId!);
    const driverKey = driverActiveTripKey(payload.driverId!);

    await sync.service.apply(snapshot('load', loadId, 1, payload));
    expect((await trip(loadId)).tracking_state).toBe('pending');
    expect(await redis.get(vehicleKey)).toBeNull();

    const confirmedAt = '2026-10-05T08:00:00.000Z';
    await sync.service.apply(
      snapshot('load', loadId, 2, {
        ...payload,
        status: 'loading_confirmed',
        milestones: { ...payload.milestones, loadingConfirmedAt: confirmedAt },
      }),
    );
    const active = await trip(loadId);
    expect(active.tracking_state).toBe('active');
    expect(active.tracking_started_at.toISOString()).toBe(confirmedAt);
    expect(await redis.get(vehicleKey)).toBe(loadId);
    expect(await redis.get(driverKey)).toBe(loadId);

    // An out-of-order older snapshot must not roll the trip back.
    expect(await sync.service.apply(snapshot('load', loadId, 1, payload))).toBe(false);
    expect((await trip(loadId)).tracking_state).toBe('active');

    // Driver swapped mid-trip: old driver released, new one indexed.
    const newDriverId = randomUUID();
    await sync.service.apply(
      snapshot('load', loadId, 3, { ...payload, status: 'in_transit', driverId: newDriverId }),
    );
    expect(await redis.get(driverKey)).toBeNull();
    expect(await redis.get(driverActiveTripKey(newDriverId))).toBe(loadId);

    await sync.service.apply(
      snapshot('load', loadId, 4, { ...payload, status: 'delivered', driverId: newDriverId }),
    );
    const ended = await trip(loadId);
    expect(ended.tracking_state).toBe('ended');
    expect(ended.tracking_started_at.toISOString()).toBe(confirmedAt);
    expect(ended.tracking_ended_at).not.toBeNull();
    expect(await redis.get(vehicleKey)).toBeNull();
    expect(await redis.get(driverActiveTripKey(newDriverId))).toBeNull();
  });

  it('never clears a vehicle key that a newer trip now owns', async () => {
    const vehicleId = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    await sync.service.apply(
      snapshot('load', first, 1, loadPayload({ vehicleId, status: 'in_transit' })),
    );
    await sync.service.apply(
      snapshot('load', second, 1, loadPayload({ vehicleId, status: 'in_transit' })),
    );
    await sync.service.apply(
      snapshot('load', first, 2, loadPayload({ vehicleId, status: 'closed' })),
    );

    expect(await redis.get(vehicleActiveTripKey(vehicleId))).toBe(second);
  });

  it('gives market trucks a stable vehicle id derived from the plate', async () => {
    const loadId = randomUUID();
    await sync.service.apply(
      snapshot(
        'load',
        loadId,
        1,
        loadPayload({
          sourceType: 'market',
          vehicleId: null,
          vehicleNumber: 'mh12 ab-9999',
          status: 'in_transit',
        }),
      ),
    );
    const expectedId = marketVehicleId(TENANT, 'MH12AB9999');
    expect((await trip(loadId)).vehicle_id).toBe(expectedId);
    expect((await trip(loadId)).vehicle_number).toBe('MH12AB9999');
    const [vehicle] = await ds.query(
      `SELECT kind, registration_number FROM tracking.vehicles WHERE id = $1`,
      [expectedId],
    );
    expect(vehicle).toEqual({ kind: 'market', registration_number: 'MH12AB9999' });
    expect(await redis.get(vehicleActiveTripKey(expectedId))).toBe(loadId);
  });

  it('a deleted load ends its trip; a tombstone for an unknown load is a no-op', async () => {
    const loadId = randomUUID();
    const payload = loadPayload({ status: 'in_transit' });
    await sync.service.apply(snapshot('load', loadId, 1, payload));
    await sync.service.apply(snapshot('load', loadId, 2, null));

    const deleted = await trip(loadId);
    expect(deleted).toMatchObject({ tracking_state: 'ended' });
    expect(deleted.deleted_at).not.toBeNull();
    expect(await redis.get(vehicleActiveTripKey(payload.vehicleId!))).toBeNull();

    expect(await sync.service.apply(snapshot('load', randomUUID(), 1, null))).toBe(true);

    // A stale tombstone (older than what we have) is ignored, not "applied".
    const other = randomUUID();
    await sync.service.apply(snapshot('load', other, 5, loadPayload({ status: 'in_transit' })));
    expect(await sync.service.apply(snapshot('load', other, 4, null))).toBe(false);
    expect((await trip(other)).tracking_state).toBe('active');
  });

  it('rebuilds the Redis index from Postgres after a Redis loss', async () => {
    const loadId = randomUUID();
    const payload = loadPayload({ status: 'in_transit' });
    await sync.service.apply(snapshot('load', loadId, 1, payload));
    await redis.flushdb();
    await redis.set(vehicleActiveTripKey(randomUUID()), 'stale-trip');

    const result = await sync.service.rebuildActiveTripIndex();
    expect(result).toEqual({ set: 2, removed: 1 });
    expect(await redis.get(vehicleActiveTripKey(payload.vehicleId!))).toBe(loadId);
  });

  it('handleBatch dead-letters bad entries and applies the rest', async () => {
    const id = randomUUID();
    const result = await sync.service.handleBatch('loadsmart.events', [
      { id: '1-0', fields: { type: 'nope' } },
      {
        id: '2-0',
        fields: {
          type: 'driver',
          id,
          version: '1',
          deleted: 'false',
          payload: JSON.stringify({ fullName: 'A', phoneNumber: '1' }),
        },
      },
    ]);
    expect(result.dead?.map((d) => d.id)).toEqual(['1-0']);
    expect(result.retry).toEqual([]);
    expect((await ds.query(`SELECT 1 FROM tracking.drivers WHERE id = $1`, [id])).length).toBe(1);
  });
});

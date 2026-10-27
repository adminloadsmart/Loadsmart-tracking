import type Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { infraAvailable, testRedis } from '../../__tests__/support/infra';
import { ActiveTripIndex, ActiveTripRefs, ON_TRIP_TENANTS_KEY } from './active-trip-index';

const available = await infraAvailable();

function trip(n: number, tenantId: string, deviceImei: string | null): ActiveTripRefs {
  return {
    tripId: `trip-${n}`,
    tenantId,
    vehicleId: `veh-${n}`,
    driverId: null,
    startedAt: new Date('2026-10-23T05:00:00Z'),
    loadStatus: 'in_transit_unloading',
    deviceImei,
  };
}

/** The registry as plain data: org → IMEIs, sorted. */
async function registry(index: ActiveTripIndex) {
  const byTenant = await index.onTripDevicesByTenant();
  return Object.fromEntries(
    [...byTenant].map(([tenant, devices]) => [tenant, devices.map((d) => d.imei).sort()]),
  );
}

describe.skipIf(!available)('on-trip device registry (real Redis)', () => {
  let redis: Redis;
  let index: ActiveTripIndex;

  beforeAll(() => {
    redis = testRedis();
    index = new ActiveTripIndex(redis);
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('lists the devices of trucks on a trip per org, and drops an org when its last trip ends', async () => {
    const a1 = trip(1, 'org-a', 'imei-1');
    const a2 = trip(2, 'org-a', 'imei-2');
    const b3 = trip(3, 'org-b', 'imei-3');
    await index.activate(a1);
    await index.activate(a2);
    await index.activate(b3);
    await index.activate(trip(4, 'org-b', null)); // no GPS device: not in the registry

    expect(await registry(index)).toEqual({
      'org-a': ['imei-1', 'imei-2'],
      'org-b': ['imei-3'],
    });
    const [device] = (await index.onTripDevicesByTenant()).get('org-b')!;
    expect(device).toEqual({ imei: 'imei-3', vehicleId: 'veh-3', tenantId: 'org-b' });

    await index.deactivate(a1);
    await index.deactivate(b3);
    expect(await registry(index)).toEqual({ 'org-a': ['imei-2'] });
    expect(await redis.smembers(ON_TRIP_TENANTS_KEY)).toEqual(['org-a']);
  });

  it("ending a trip never drops a device that has moved to another vehicle's trip", async () => {
    await index.activate(trip(1, 'org-a', 'imei-1'));
    // The device was moved to vehicle 2, which is now on its own trip.
    await index.activate({ ...trip(2, 'org-a', 'imei-1') });
    await index.deactivate(trip(1, 'org-a', 'imei-1'));
    const devices = (await index.onTripDevicesByTenant()).get('org-a')!;
    expect(devices).toEqual([{ imei: 'imei-1', vehicleId: 'veh-2', tenantId: 'org-a' }]);
  });

  it('remembers the device on the trip ref, for releasing it later', async () => {
    await index.activate(trip(1, 'org-a', 'imei-1'));
    expect(await index.getRef('trip-1')).toEqual({
      tenantId: 'org-a',
      vehicleId: 'veh-1',
      driverId: null,
      deviceImei: 'imei-1',
    });
  });

  it('rebuild makes the registry match the active trips exactly', async () => {
    await index.activate(trip(1, 'org-a', 'imei-1')); // trip ended while no leader ran
    await index.activate(trip(2, 'org-b', 'imei-old')); // device changed since
    await index.rebuild([
      trip(2, 'org-b', 'imei-new'),
      trip(3, 'org-c', 'imei-3'),
      trip(4, 'org-c', null),
    ]);
    expect(await registry(index)).toEqual({ 'org-b': ['imei-new'], 'org-c': ['imei-3'] });
    expect((await redis.smembers(ON_TRIP_TENANTS_KEY)).sort()).toEqual(['org-b', 'org-c']);

    await index.rebuild([]);
    expect(await registry(index)).toEqual({});
    expect(await redis.exists(ON_TRIP_TENANTS_KEY)).toBe(0);
  });
});

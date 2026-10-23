import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  drainPointStreams,
  infraAvailable,
  silentLogger,
  testDataSource,
  testRedis,
  truncateTrackingTables,
} from '../../__tests__/support/infra';
import { allPointStreamKeys } from '../../streams/partitioner';
import { MainDataRepository } from '../main-data';
import { createPointsModule } from '../points';
import { APPROACH_STATUS, createTripsModule } from '../trips';
import type { PositionSource } from './roadcast.client';
import { RoadcastDevice, RoadcastPollJob } from './roadcast-poll.job';

const available = await infraAvailable();
const PARTITIONS = 4;
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-23T05:17:00Z');

/** A Roadcast stand-in: returns whatever rows the test sets, records the IMEIs asked for. */
class FakeRoadcast implements PositionSource {
  rows: unknown[] = [];
  asked: string[][] = [];
  async pullPositions(imeis: string[]): Promise<unknown[]> {
    this.asked.push(imeis);
    return this.rows;
  }
}

function row(imei: string, fixIso: string, lat = 30.64, lng = 76.82) {
  return {
    deviceImei: imei,
    latitude: lat,
    longitude: lng,
    speed: 40,
    course: 90,
    ignition: true,
    motion: true,
    gpsBattery: 80,
    deviceStatus: 'online',
    gpsFixTimestamp: fixIso,
    deviceTimestamp: fixIso,
  };
}

describe.skipIf(!available)('Roadcast pull end to end (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let trips: ReturnType<typeof createTripsModule>;
  let points: ReturnType<typeof createPointsModule>;
  let roadcast: FakeRoadcast;
  let job: RoadcastPollJob;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    trips = createTripsModule(ds, redis, silentLogger);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
    points = createPointsModule(ds, redis, { partitions: PARTITIONS, maxLen: 10_000 });
    roadcast = new FakeRoadcast();
    job = new RoadcastPollJob(roadcast, redis, trips.activeTrips, points.publisher, {
      idleIntervalMs: 5 * 60_000,
      speedUnit: 'kmh',
    });
  });
  afterAll(async () => {
    await redis.quit();
  });

  function newDevice(tenantId = TENANT): RoadcastDevice {
    return {
      imei: String(866221070000000 + Math.floor(Math.random() * 1e6)),
      vehicleId: randomUUID(),
      tenantId,
    };
  }

  async function onTrip(device: RoadcastDevice, loadStatus = 'in_transit') {
    const tripId = randomUUID();
    await trips.activeTrips.activate({
      tripId,
      tenantId: device.tenantId,
      vehicleId: device.vehicleId,
      driverId: null,
      startedAt: new Date(NOW - 60 * 60_000),
      loadStatus,
    });
    return tripId;
  }

  async function processStream() {
    await drainPointStreams(redis, allPointStreamKeys(PARTITIONS), (s, e) =>
      points.processing.handleBatch(s, e),
    );
  }

  async function storedPoints(vehicleId: string) {
    return ds.query(
      `SELECT trip_id, source, source_ref, recorded_at, speed_kmh, flags
       FROM tracking.location_points WHERE vehicle_id = $1
       UNION ALL
       SELECT trip_id, source, source_ref, recorded_at, speed_kmh, flags
       FROM tracking.location_points_short WHERE vehicle_id = $1
       ORDER BY recorded_at`,
      [vehicleId],
    );
  }

  it('stores an on-trip fix with its trip, once — the repeated latest fix is stale', async () => {
    const device = newDevice();
    const tripId = await onTrip(device);
    roadcast.rows = [row(device.imei, '2026-10-23T05:16:00Z')];

    expect((await job.run({ devices: [device] }, NOW)).accepted).toBe(1);
    expect(roadcast.asked).toEqual([[device.imei]]);
    // Latest-only API: the same fix comes back on the next poll.
    expect(await job.run({ devices: [device] }, NOW + 60_000)).toMatchObject({
      accepted: 0,
      stale: 1,
    });

    await processStream();
    const stored = await storedPoints(device.vehicleId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      trip_id: tripId,
      source: 'roadcast',
      source_ref: device.imei,
    });
    expect(stored[0].flags).toMatchObject({ ignition: true });
  });

  it('one call per org: on-trip trucks every pull, idle ones per 5 min, each in its own org', async () => {
    const orgA = { moving: newDevice(TENANT), idle: newDevice(TENANT) };
    const orgB = { moving: newDevice(OTHER_TENANT), idle: newDevice(OTHER_TENANT) };
    const tripA = await onTrip(orgA.moving);
    const tripB = await onTrip(orgB.moving);

    // Six ticks 10 s apart, each org's call with both of its trucks; every truck reports a new fix.
    for (let i = 0; i < 6; i++) {
      const fix = new Date(NOW - 60_000 + i * 10_000).toISOString();
      for (const org of [orgA, orgB]) {
        roadcast.rows = [row(org.moving.imei, fix), row(org.idle.imei, fix)];
        await job.run({ devices: [org.moving, org.idle] }, NOW + i * 10_000);
      }
    }
    expect(roadcast.asked).toHaveLength(12);
    expect(roadcast.asked[1]).toEqual([orgB.moving.imei, orgB.idle.imei]);

    await processStream();
    const tenantOf = async (vehicleId: string) =>
      (
        await ds.query(
          `SELECT DISTINCT tenant_id FROM tracking.location_points WHERE vehicle_id = $1
           UNION SELECT DISTINCT tenant_id FROM tracking.location_points_short WHERE vehicle_id = $1`,
          [vehicleId],
        )
      ).map((r: { tenant_id: string }) => r.tenant_id);

    expect(
      (await storedPoints(orgA.moving.vehicleId)).map((p: { trip_id: string }) => p.trip_id),
    ).toEqual(Array(6).fill(tripA));
    expect(
      (await storedPoints(orgB.moving.vehicleId)).map((p: { trip_id: string }) => p.trip_id),
    ).toEqual(Array(6).fill(tripB));
    // Idle trucks: the first fix only — the rest fall inside the 5 min idle interval.
    for (const idle of [orgA.idle, orgB.idle]) {
      const stored = await storedPoints(idle.vehicleId);
      expect(stored).toHaveLength(1);
      expect(stored[0].trip_id).toBeNull();
    }
    expect(await tenantOf(orgA.moving.vehicleId)).toEqual([TENANT]);
    expect(await tenantOf(orgB.idle.vehicleId)).toEqual([OTHER_TENANT]);
  });

  it('throttles a vehicle with no trip to one point per idle interval', async () => {
    const device = newDevice();
    roadcast.rows = [row(device.imei, '2026-10-23T05:00:00Z')];
    expect((await job.run({ devices: [device] }, NOW)).accepted).toBe(1);

    roadcast.rows = [row(device.imei, '2026-10-23T05:02:00Z')];
    expect((await job.run({ devices: [device] }, NOW)).idle_throttled).toBe(1);

    roadcast.rows = [row(device.imei, '2026-10-23T05:06:00Z')];
    expect((await job.run({ devices: [device] }, NOW)).accepted).toBe(1);

    await processStream();
    const stored = await storedPoints(device.vehicleId);
    expect(stored.map((p: { trip_id: string | null }) => p.trip_id)).toEqual([null, null]);
  });

  it('on the drive to the plant, carries the trip only as approachTripId', async () => {
    const device = newDevice();
    const tripId = await onTrip(device, APPROACH_STATUS);
    roadcast.rows = [row(device.imei, '2026-10-23T05:16:00Z')];
    expect((await job.run({ devices: [device] }, NOW)).accepted).toBe(1);

    await processStream();
    const [stored] = await storedPoints(device.vehicleId);
    expect(stored.trip_id).toBeNull();
    expect(stored.flags).toMatchObject({ approachTripId: tripId });
  });

  it('ignores devices it did not ask for, rows without a fix, and malformed rows', async () => {
    const device = newDevice();
    roadcast.rows = [
      row('999999999999999', '2026-10-23T05:16:00Z'),
      row(device.imei, '2026-10-23T05:16:00Z', 0, 0),
      { deviceImei: device.imei, latitude: 'north' },
    ];
    expect(await job.run({ devices: [device] }, NOW)).toMatchObject({
      accepted: 0,
      unknown_device: 1,
      no_fix: 1,
      invalid: 1,
    });
  });

  it('reads device bindings from main: IMEI set, not deleted, newest edit wins a duplicate', async () => {
    const [a, b, c, deleted] = [1, 2, 3, 4].map(() => randomUUID());
    for (const id of [a, b, c, deleted]) {
      await ds.query(
        `INSERT INTO masters.vehicles (id, tenant_id, registration_number) VALUES ($1, $2, $3)`,
        [id, TENANT, `PB65V${id.slice(0, 4)}`],
      );
    }
    const meta = (vehicleId: string, imei: string | null, updatedAt: string, deletedAt = null) =>
      ds.query(
        `INSERT INTO masters.vehicle_telemetry_meta
           (tenant_id, vehicle_id, gps_device_imei, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [TENANT, vehicleId, imei, updatedAt, deletedAt],
      );
    await meta(a, '866221070401935', '2026-10-01');
    await meta(b, '866221070401935', '2026-10-02'); // same IMEI, edited later
    await meta(c, null, '2026-10-01');
    await ds.query(`UPDATE masters.vehicles SET deleted_at = now() WHERE id = $1`, [deleted]);
    await meta(deleted, '866221070405217', '2026-10-01');

    const bindings = await new MainDataRepository(ds).gpsDeviceBindings();
    expect(bindings).toEqual([{ imei: '866221070401935', vehicleId: b, tenantId: TENANT }]);
  });

  it('sweep slots split the orgs: every org in exactly one slot, all its devices together', async () => {
    const repo = new MainDataRepository(ds);
    const tenants = Array.from({ length: 12 }, () => randomUUID());
    for (const [i, tenantId] of tenants.entries()) {
      for (const n of [0, 1]) {
        const vehicleId = randomUUID();
        await ds.query(
          `INSERT INTO masters.vehicles (id, tenant_id, registration_number) VALUES ($1, $2, $3)`,
          [vehicleId, tenantId, `KA01${i}${n}`],
        );
        await ds.query(
          `INSERT INTO masters.vehicle_telemetry_meta (tenant_id, vehicle_id, gps_device_imei)
           VALUES ($1, $2, $3)`,
          [tenantId, vehicleId, String(866221070500000 + i * 10 + n)],
        );
      }
    }
    const slots = 5;
    const perSlot = await Promise.all(
      Array.from({ length: slots }, (_, slot) => repo.gpsDeviceBindings({ slot, slots })),
    );
    const all = perSlot.flat();
    expect(all).toHaveLength(tenants.length * 2);
    for (const tenantId of tenants) {
      const slotsWithOrg = perSlot.filter((rows) => rows.some((r) => r.tenantId === tenantId));
      expect(slotsWithOrg).toHaveLength(1);
      expect(slotsWithOrg[0].filter((r) => r.tenantId === tenantId)).toHaveLength(2);
    }
  });
});

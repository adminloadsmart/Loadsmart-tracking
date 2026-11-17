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
import { seedLoad, updateLoad } from '../../__tests__/support/main-schema';
import { allPointStreamKeys } from '../../streams/partitioner';
import { createPointsModule, NormalizedPoint } from '../points';
import { createTripsModule } from '../trips';
import { createTripStartModule } from './index';

const available = await infraAvailable();
const PARTITIONS = 4;
const TENANT = '11111111-1111-4111-8111-111111111111';
const START = { lat: 28.6, lng: 77.2 };

describe.skipIf(!available)('trip.started end to end (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let trips: ReturnType<typeof createTripsModule>;
  let points: ReturnType<typeof createPointsModule>;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    trips = createTripsModule(ds, redis, silentLogger);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
    const tripStart = createTripStartModule({ dataSource: ds, redis, logger: silentLogger });
    points = createPointsModule(
      ds,
      redis,
      { partitions: PARTITIONS, maxLen: 10_000 },
      {},
      undefined,
      tripStart.hook,
    );
  });
  afterAll(async () => {
    await redis.quit();
  });

  async function assignedTrip(status = 'truck_assigned') {
    const seeded = await seedLoad(ds, { tenantId: TENANT, status, startedAt: null });
    await trips.watcher.poll();
    return { tripId: seeded.loadId, vehicleId: seeded.vehicleId! };
  }

  /** Fixes as ingest stamps them on the approach: [seconds ago, metres north]. */
  async function feed(
    trip: { tripId: string; vehicleId: string },
    fixes: Array<[number, number]>,
    source: 'driver_app' | 'sim' = 'driver_app',
  ) {
    const batch: NormalizedPoint[] = fixes.map(([agoS, northM]) => ({
      tenantId: TENANT,
      vehicleId: trip.vehicleId,
      tripId: null,
      source,
      sourceRef: 'ref-1',
      recordedAt: new Date(Date.now() - agoS * 1000).toISOString(),
      receivedAt: new Date().toISOString(),
      lat: Number((START.lat + northM / 111_195).toFixed(6)),
      lng: START.lng,
      speedKmh: 30,
      heading: 0,
      accuracyM: 5,
      flags: { geofenceTripId: trip.tripId },
    }));
    await points.publisher.publish(batch);
    await drainPointStreams(redis, allPointStreamKeys(PARTITIONS), (s, e) =>
      points.processing.handleBatch(s, e),
    );
  }

  const started = async (): Promise<Array<Record<string, unknown>>> =>
    (
      await ds.query(
        `SELECT payload FROM tracking.alert_outbox WHERE event_type = 'trip.started' ORDER BY id`,
      )
    ).map((r: { payload: Record<string, unknown> }) => r.payload);

  it('a truck 3 km from where it was assigned → one trip.started, however many fixes follow', async () => {
    const trip = await assignedTrip();
    await feed(trip, [
      [600, 0],
      [400, 1200],
    ]);
    expect(await started()).toEqual([]);
    await feed(trip, [[200, 3300]]);
    await feed(trip, [
      [100, 5000],
      [50, 7000],
    ]);

    const events = await started();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenant_id: TENANT,
      loadId: trip.tripId,
      vehicleId: trip.vehicleId,
      source: 'driver_app',
      pings: 1,
    });
    expect(Number(events[0].distanceM)).toBeGreaterThanOrEqual(3000);
    expect(await ds.query(`SELECT count(*)::int AS n FROM tracking.trip_start_events`)).toEqual([
      { n: 1 },
    ]);
  });

  it('a lost Redis state does not send the start twice (the primary key stops it)', async () => {
    const trip = await assignedTrip();
    await feed(trip, [
      [600, 0],
      [300, 3500],
    ]);
    expect(await started()).toHaveLength(1);
    await redis.del(`trk:tripstart:${trip.tripId}`);
    await feed(trip, [
      [200, 0],
      [100, 3600],
    ]);
    expect(await started()).toHaveLength(1);
  });

  it('SIM needs two distinct far pings', async () => {
    const trip = await assignedTrip();
    await feed(trip, [[3000, 0]], 'sim');
    await feed(trip, [[1800, 3500]], 'sim');
    expect(await started()).toEqual([]);
    await feed(trip, [[600, 6000]], 'sim');
    const events = await started();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'sim', pings: 2 });
  });

  it('a load already past "Truck assigned" never starts again', async () => {
    const trip = await assignedTrip('in_transit_loading');
    await feed(trip, [
      [600, 0],
      [300, 5000],
    ]);
    expect(await started()).toEqual([]);
  });

  it('a re-assigned truck can start again', async () => {
    const trip = await assignedTrip();
    await feed(trip, [
      [900, 0],
      [800, 3500],
    ]);
    expect(await started()).toHaveLength(1);
    // Cancelled and assigned again: the load's truck_assigned_at is new.
    await updateLoad(ds, trip.tripId, { truck_assigned_at: new Date() });
    await trips.watcher.poll();
    await feed(trip, [
      [500, 0],
      [300, 3500],
    ]);
    expect(await started()).toHaveLength(2);
  });
});

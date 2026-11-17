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
import { seedLoad, updateLoad } from '../../__tests__/support/main-schema';
import { allPointStreamKeys } from '../../streams/partitioner';
import { createPointsModule, NormalizedPoint } from '../points';
import { createTripsModule } from '../trips';
import { createGeofencesModule } from './index';

const available = await infraAvailable();
const PARTITIONS = 4;
const TENANT = '11111111-1111-4111-8111-111111111111';
/** The seeded loading point's coordinates (seedLoad's default origin). */
const PLANT = { lat: 28.6, lng: 77.2 };

describe.skipIf(!available)('geofence check end to end (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let trips: ReturnType<typeof createTripsModule>;
  let points: ReturnType<typeof createPointsModule>;
  let geofences: ReturnType<typeof createGeofencesModule>;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    trips = createTripsModule(ds, redis, silentLogger);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
    // A fresh module per test: its geofence cache would otherwise outlive the truncate.
    geofences = createGeofencesModule({
      dataSource: ds,
      redis,
      activeTrips: trips.activeTrips,
      logger: silentLogger,
    });
    points = createPointsModule(
      ds,
      redis,
      { partitions: PARTITIONS, maxLen: 10_000 },
      {},
      undefined,
      geofences.hook,
    );
  });
  afterAll(async () => {
    await redis.quit();
  });

  async function assignedTrip() {
    const seeded = await seedLoad(ds, {
      tenantId: TENANT,
      status: 'truck_assigned',
      startedAt: null,
    });
    await trips.watcher.poll();
    await ds.query(
      `INSERT INTO tracking.geofences (id, tenant_id, name, type, latitude, longitude, radius_m, loading_point_id)
       VALUES ($1, $2, 'Plant', 'loading_point', $3, $4, 300, $5)`,
      [randomUUID(), TENANT, PLANT.lat, PLANT.lng, seeded.loadingPointId],
    );
    return { tripId: seeded.loadId, vehicleId: seeded.vehicleId! };
  }

  /** Approach fixes (load still assigned, as phone ingest stamps them): [seconds ago, metres north]. */
  async function feed(
    trip: { tripId: string; vehicleId: string },
    fixes: Array<[number, number]>,
    speedKmh = 20,
  ) {
    const batch: NormalizedPoint[] = fixes.map(([agoS, northM]) => ({
      tenantId: TENANT,
      vehicleId: trip.vehicleId,
      tripId: null,
      source: 'driver_app',
      sourceRef: 'd1',
      recordedAt: new Date(Date.now() - agoS * 1000).toISOString(),
      receivedAt: new Date().toISOString(),
      lat: Number((PLANT.lat + northM / 111_195).toFixed(6)),
      lng: PLANT.lng,
      speedKmh,
      heading: 0,
      accuracyM: 5,
      flags: { geofenceTripId: trip.tripId },
    }));
    await points.publisher.publish(batch);
    await drainPointStreams(redis, allPointStreamKeys(PARTITIONS), (s, e) =>
      points.processing.handleBatch(s, e),
    );
  }

  const outbox = async (): Promise<Array<[string, Record<string, unknown>]>> =>
    (await ds.query(`SELECT event_type, payload FROM tracking.alert_outbox ORDER BY id`)).map(
      (r: { event_type: string; payload: Record<string, unknown> }) => [r.event_type, r.payload],
    );

  it('driving into the plant geofence while assigned → only geofence.entered (the arrival waits for the stop)', async () => {
    const trip = await assignedTrip();
    await feed(trip, [
      [180, 2000],
      [120, 1000],
      [60, 100],
    ]);

    const events = await outbox();
    expect(events.map(([type]) => type)).toEqual(['geofence.entered']);
    const logged = await ds.query(`SELECT event, load_id FROM tracking.geofence_events`);
    expect(logged).toEqual([{ event: 'enter', load_id: trip.tripId }]);
  });

  it('stopped inside for 10 min → trip.arrived_at_pickup, once, stamped with when the stop began', async () => {
    const trip = await assignedTrip();
    await feed(trip, [[900, 2000]]);
    await feed(trip, [[800, 100]], 0);
    await feed(trip, [[400, 60]], 0);
    expect((await outbox()).map(([type]) => type)).toEqual(['geofence.entered']);
    await feed(trip, [[100, 60]], 0); // 700 s after stopping: past the 10 min wait

    const events = await outbox();
    expect(events.map(([type]) => type)).toEqual(['geofence.entered', 'trip.arrived_at_pickup']);
    expect(events[1][1]).toMatchObject({
      tenant_id: TENANT,
      loadId: trip.tripId,
      vehicleId: trip.vehicleId,
      point: 'loading',
    });
    const stoppedAt = Date.parse(events[1][1].occurredAt as string);
    const confirmedAt = Date.parse(events[1][1].confirmedAt as string);
    expect(confirmedAt - stoppedAt).toBe(10 * 60_000);

    // More fixes, a redelivery: nothing new.
    await feed(trip, [[50, 60]], 0);
    await feed(trip, [[100, 60]], 0);
    expect((await outbox()).map(([type]) => type)).toEqual([
      'geofence.entered',
      'trip.arrived_at_pickup',
    ]);
    expect(await ds.query(`SELECT kind FROM tracking.geofence_dwell_events`)).toEqual([
      { kind: 'arrival' },
    ]);
  });

  it('a truck that stops sending still arrives: the tick checks the clock, and the batch does not repeat it', async () => {
    const trip = await assignedTrip();
    await feed(trip, [[600, 2000]]);
    await feed(trip, [[500, 100]], 0);
    await feed(trip, [[40, 60]], 0); // 460 s stopped so far
    expect(await geofences.tick(Date.now())).toBe(0);
    expect(await geofences.tick(Date.now() + 200_000)).toBe(1); // now past the wait
    expect(await geofences.tick(Date.now() + 210_000)).toBe(0);
    expect((await outbox()).map(([type]) => type)).toEqual([
      'geofence.entered',
      'trip.arrived_at_pickup',
    ]);
    await feed(trip, [[1, 60]], 0); // the next fix: same arrival, same id, no second event
    expect((await outbox()).map(([type]) => type)).toEqual([
      'geofence.entered',
      'trip.arrived_at_pickup',
    ]);
  });

  it('a load past assigned gets only the geofence event, even after the stop', async () => {
    const trip = await assignedTrip();
    await updateLoad(ds, trip.tripId, { status: 'reached_loading' });
    await trips.watcher.poll();
    await feed(trip, [[900, 2000]]);
    await feed(trip, [[800, 100]], 0);
    await feed(trip, [[100, 60]], 0);
    expect((await outbox()).map(([type]) => type)).toEqual(['geofence.entered']);
  });
});

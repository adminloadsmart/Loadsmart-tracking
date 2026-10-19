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

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    trips = createTripsModule(ds, redis, silentLogger);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
    // A fresh module per test: its geofence cache would otherwise outlive the truncate.
    const geofences = createGeofencesModule({
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
    const seeded = await seedLoad(ds, { tenantId: TENANT, status: 'assigned', startedAt: null });
    await trips.watcher.poll();
    await ds.query(
      `INSERT INTO tracking.geofences (id, tenant_id, name, type, latitude, longitude, radius_m, loading_point_id)
       VALUES ($1, $2, 'Plant', 'loading_point', $3, $4, 300, $5)`,
      [randomUUID(), TENANT, PLANT.lat, PLANT.lng, seeded.loadingPointId],
    );
    return { tripId: seeded.loadId, vehicleId: seeded.vehicleId! };
  }

  /** Approach fixes (load still assigned, as phone ingest stamps them): [seconds ago, metres north]. */
  async function feed(trip: { tripId: string; vehicleId: string }, fixes: Array<[number, number]>) {
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
      speedKmh: 20,
      heading: 0,
      accuracyM: 5,
      flags: { approachTripId: trip.tripId },
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

  it('driving into the plant geofence while assigned → geofence.entered + trip.arrived_at_pickup', async () => {
    const trip = await assignedTrip();
    await feed(trip, [
      [180, 2000],
      [120, 1000],
      [60, 100],
    ]);

    const events = await outbox();
    expect(events.map(([type]) => type)).toEqual(['geofence.entered', 'trip.arrived_at_pickup']);
    expect(events[1][1]).toMatchObject({
      tenant_id: TENANT,
      loadId: trip.tripId,
      vehicleId: trip.vehicleId,
    });
    const logged = await ds.query(`SELECT event, load_id FROM tracking.geofence_events`);
    expect(logged).toEqual([{ event: 'enter', load_id: trip.tripId }]);
  });

  it('staying inside raises nothing more; a redelivered fix adds no event', async () => {
    const trip = await assignedTrip();
    await feed(trip, [
      [180, 2000],
      [60, 100],
    ]);
    await feed(trip, [[30, 50]]);
    expect((await outbox()).map(([type]) => type)).toEqual([
      'geofence.entered',
      'trip.arrived_at_pickup',
    ]);
  });

  it('a load past assigned gets only the geofence event', async () => {
    const trip = await assignedTrip();
    await updateLoad(ds, trip.tripId, { status: 'at_plant' });
    await trips.watcher.poll();
    await feed(trip, [
      [180, 2000],
      [60, 100],
    ]);
    expect((await outbox()).map(([type]) => type)).toEqual(['geofence.entered']);
  });
});

import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainPointStreams,
  infraAvailable,
  silentLogger,
  testDataSource,
  testRedis,
  truncateTrackingTables,
} from '../../__tests__/support/infra';
import { createApp } from '../../app';
import { buildContainer } from '../../composition-root';
import { allPointStreamKeys } from '../../streams/partitioner';
import { createPointsModule, NormalizedPoint } from '../points';
import { createRulesModule } from '../rules';
import { seedLoad } from '../../__tests__/support/main-schema';
import { createTripsModule } from '../trips';
import type { Geocoder, RouteProvider } from './google.client';
import { encodePolyline } from './route-geometry';
import { createRoutesModule } from './index';

const available = await infraAvailable();
const SECRET = 'integration-test-secret-integration-test';
const PARTITIONS = 4;
const TENANT = '11111111-1111-4111-8111-111111111111';

// A straight ~111 km road north from the plant (28.6, 77.2) to the drop (29.6, 77.2).
const ROAD = Array.from({ length: 101 }, (_, i) => ({
  lat: Number((28.6 + i * 0.01).toFixed(5)),
  lng: 77.2,
}));
const M = 1 / 111_195;
const E = 1 / (111_195 * Math.cos((28.9 * Math.PI) / 180));

const fixtureProvider: RouteProvider = {
  name: 'fixture',
  computeRoute: async () => ({
    polyline: encodePolyline(ROAD),
    distanceM: 111_195,
    durationS: 7200,
  }),
};
const geocoded: string[] = [];
const fixtureGeocoder: Geocoder = {
  name: 'fixture-geocoder',
  geocode: async (address) => {
    geocoded.push(address);
    return ROAD[ROAD.length - 1];
  },
};

describe.skipIf(!available)('routes, DELAY-GPS and DEV-GPS end to end (fixture Google)', () => {
  let ds: DataSource;
  let redis: Redis;
  let routes: ReturnType<typeof createRoutesModule>;
  let rules: ReturnType<typeof createRulesModule>;
  let trips: ReturnType<typeof createTripsModule>;
  let points: ReturnType<typeof createPointsModule>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    trips = createTripsModule(ds, redis, silentLogger);
    routes = createRoutesModule({
      dataSource: ds,
      redis,
      logger: silentLogger,
      provider: fixtureProvider,
      geocoder: fixtureGeocoder,
    });
    rules = createRulesModule({
      dataSource: ds,
      redis,
      activeTrips: trips.activeTrips,
      logger: silentLogger,
      routes,
    });
    points = createPointsModule(
      ds,
      redis,
      { partitions: PARTITIONS, maxLen: 10_000 },
      {},
      undefined,
      rules.hook,
    );
    app = createApp(
      buildContainer({
        dataSource: ds,
        redis,
        mainRedis: redis,
        jwtSecret: SECRET,
        logger: silentLogger,
        routeProvider: fixtureProvider,
      }),
    );
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
    geocoded.length = 0;
  });
  afterAll(async () => {
    await redis.quit();
  });

  const token = (overrides: object = {}) =>
    jwt.sign(
      {
        id: randomUUID(),
        tenantId: TENANT,
        role: 'dispatch',
        permissions: [],
        portal: 'organization',
        purpose: 'access',
        ...overrides,
      },
      SECRET,
      { algorithm: 'HS256', expiresIn: 900 },
    );

  /** A load in the main tables (plant with coordinates, drop with an address only). */
  async function setup(promisedInMin: number, startedMinAgo: number, status?: string) {
    const seeded = await seedLoad(ds, {
      tenantId: TENANT,
      code: 'LOAD-RT',
      ...(status ? { status } : {}),
      registrationNumber: 'UK07AB0001',
      startedAt: new Date(Date.now() - startedMinAgo * 60_000),
      origin: { lat: 28.6, lng: 77.2 },
      destination: {
        location: 'ACME DC',
        address: 'NH-58',
        city: 'Roorkee',
        state: 'UK',
        pinCode: '247667',
      },
    });
    await trips.watcher.poll();
    return {
      tripId: seeded.loadId,
      vehicleId: seeded.vehicleId!,
      drop: seeded.deliveryPointId,
      promisedInMin,
    };
  }

  /**
   * Main stores a promised delivery DATE (end of day); these scenarios need a promise minutes
   * away, so set it on the planned route — the same override an ops approval makes.
   */
  async function promise(tripId: string, inMin: number) {
    await ds.query(`UPDATE tracking.trip_routes SET promised_at = $2 WHERE trip_id = $1`, [
      tripId,
      new Date(Date.now() + inMin * 60_000),
    ]);
    routes.store.invalidate(tripId);
  }

  async function feed(
    trip: { tripId: string; vehicleId: string },
    fixes: Array<{ minAgo: number; alongM: number; offM?: number; speed?: number }>,
    source: NormalizedPoint['source'] = 'driver_app',
  ) {
    const batch: NormalizedPoint[] = fixes.map((f) => ({
      tenantId: TENANT,
      vehicleId: trip.vehicleId,
      tripId: trip.tripId,
      source,
      sourceRef: 'd1',
      recordedAt: new Date(Date.now() - f.minAgo * 60_000).toISOString(),
      receivedAt: new Date().toISOString(),
      lat: Number((28.6 + f.alongM * M).toFixed(6)),
      lng: Number((77.2 + (f.offM ?? 0) * E).toFixed(6)),
      speedKmh: f.speed ?? 40,
      heading: 0,
      accuracyM: 5,
      flags: null,
    }));
    await points.publisher.publish(batch);
    await drainPointStreams(redis, allPointStreamKeys(PARTITIONS), (s, e) =>
      points.processing.handleBatch(s, e),
    );
  }

  it('plans once (geocoding the drop), projects the ETA, and raises DELAY after 2 evaluations', async () => {
    // Promised in 60 min, but 3 h in the truck has only done 30 km at ~10 km/h → badly late soon.
    const trip = await setup(60, 180);
    expect(await routes.planner.planPending()).toBe(1);
    await promise(trip.tripId, trip.promisedInMin);
    expect(geocoded).toEqual(['ACME DC, NH-58, Roorkee, UK, 247667']);
    expect(await routes.planner.planPending()).toBe(0); // planned once
    const [status] = await ds.query(
      `SELECT status FROM tracking.trip_route_status WHERE trip_id = $1`,
      [trip.tripId],
    );
    expect(status.status).toBe('ok');

    // Fixes every 5 min over the last 3 h: 0 → 30 km along the road.
    await feed(
      trip,
      Array.from({ length: 37 }, (_, i) => ({ minAgo: 180 - i * 5, alongM: i * 833 })),
    );
    // Every 50 km threshold not reached → planned speed; first evaluation, no alert yet (needs 2).
    await rules.tick(Date.now());
    expect(
      await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts WHERE rule_id = 'DELAY-GPS'`),
    ).toEqual([{ n: 0 }]);
    const tripView = await request(app)
      .get(`/v1/trips/${trip.tripId}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(tripView.body.data).toMatchObject({
      routeStatus: 'ok',
      eta: { stale: false, basis: 'planned' },
    });
    expect(tripView.body.data.eta.remainingKm).toBeCloseTo(81, 0);
    expect(tripView.body.data.eta.projectedDelayMin).toBeGreaterThan(60);

    await rules.tick(Date.now() + 16 * 60_000); // second evaluation 15+ min later
    const [alert] = await ds.query(
      `SELECT severity, status FROM tracking.alerts WHERE rule_id = 'DELAY-GPS'`,
    );
    expect(alert).toMatchObject({ status: 'open' });
    expect(['warning', 'critical']).toContain(alert.severity);
  });

  it('refreshes the ETA every minute but still raises DELAY only after 2 evaluations 15 min apart', async () => {
    const trip = await setup(60, 180);
    await routes.planner.planPending();
    await promise(trip.tripId, trip.promisedInMin);
    await feed(
      trip,
      Array.from({ length: 37 }, (_, i) => ({ minAgo: 180 - i * 5, alongM: i * 833 })),
    );
    const t0 = Date.now();
    await rules.tick(t0);
    const first = await redis.hget(`trk:trip:${trip.tripId}:eta`, 'evaluatedAt');
    expect(Number(first)).toBe(t0);

    await rules.tick(t0 + 2 * 60_000); // ETA refreshed, but no second alert evaluation yet
    expect(Number(await redis.hget(`trk:trip:${trip.tripId}:eta`, 'evaluatedAt'))).toBe(
      t0 + 2 * 60_000,
    );
    expect(
      await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts WHERE rule_id = 'DELAY-GPS'`),
    ).toEqual([{ n: 0 }]);

    await rules.tick(t0 + 16 * 60_000);
    expect(
      await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts WHERE rule_id = 'DELAY-GPS'`),
    ).toEqual([{ n: 1 }]);
  });

  it('SIM fixes move the in-transit progress and remaining km', async () => {
    const trip = await setup(600, 60);
    await routes.planner.planPending();
    await feed(
      trip,
      Array.from({ length: 7 }, (_, i) => ({ minAgo: 30 - i * 5, alongM: 20_000 + i * 2_000 })),
      'sim',
    );
    await rules.tick(Date.now());
    const view = await request(app)
      .get(`/v1/trips/${trip.tripId}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(view.body.data.eta).toMatchObject({ stale: false, stage: null });
    expect(view.body.data.eta.remainingKm).toBeCloseTo(111.2 - 32, 0);
  });

  it('pre-transit: a truck_assigned trip gets a delivery ETA (approach + dwell + route), no alerts', async () => {
    const trip = await setup(-600, 60, 'truck_assigned'); // promise long past: must not alert
    await routes.planner.planPending();
    // The truck is ~22 km short of the plant (south of it, on no drawn approach leg).
    await redis.hset(`trk:veh:${trip.vehicleId}:latest`, {
      tenantId: TENANT,
      lat: '28.4',
      lng: '77.2',
      recordedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      source: 'sim',
      motion: 'moving',
      tripId: trip.tripId,
    });
    const now = Date.now();
    await rules.tick(now);

    const list = await request(app)
      .get('/v1/trips?state=active')
      .set('Authorization', `Bearer ${token()}`);
    const [listed] = list.body.data.trips;
    expect(listed.eta).toMatchObject({
      basis: 'pre_transit',
      stage: 'truck_assigned',
      stale: false,
    });
    // ~22.2 km × 1.3 approach + 111.2 km route at 350 km/day, + 240 min at the plant.
    const kmLeft = 22.24 * 1.3 + 111.2;
    expect(listed.eta.remainingKm).toBeCloseTo(kmLeft, 0);
    const expectedEta = now + (kmLeft / (350 / 24)) * 3_600_000 + 240 * 60_000;
    expect(Math.abs(Date.parse(listed.eta.etaAt) - expectedEta)).toBeLessThan(5 * 60_000);
    expect(
      await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts WHERE rule_id = 'DELAY-GPS'`),
    ).toEqual([{ n: 0 }]);
  });

  it('a failing delay step does not stop the pre-transit ETA', async () => {
    const trip = await setup(600, 60, 'in_transit_loading');
    await routes.planner.planPending();
    await redis.hset(`trk:veh:${trip.vehicleId}:latest`, {
      tenantId: TENANT,
      lat: '28.55',
      lng: '77.2',
      recordedAt: new Date().toISOString(),
      source: 'driver_app',
      motion: 'moving',
      tripId: trip.tripId,
    });
    const broken = vi
      .spyOn(routes.repository, 'inTransitTripsWithRoute')
      .mockRejectedValue(new Error('boom'));
    try {
      await rules.tick(Date.now());
    } finally {
      broken.mockRestore();
    }
    expect(await redis.hgetall(`trk:trip:${trip.tripId}:eta`)).toMatchObject({
      basis: 'pre_transit',
      stage: 'in_transit_loading',
      stale: '0',
    });
  });

  it('pre-transit: no position yet → eta stays null', async () => {
    const trip = await setup(600, 60, 'truck_assigned');
    await routes.planner.planPending();
    await rules.tick(Date.now());
    const view = await request(app)
      .get(`/v1/trips/${trip.tripId}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(view.body.data.eta).toBeNull();
  });

  it('"already late" alerts at once: Warning when under 240 min late', async () => {
    const trip = await setup(-30, 300); // promised 30 min ago
    await routes.planner.planPending();
    await promise(trip.tripId, trip.promisedInMin);
    await feed(trip, [{ minAgo: 1, alongM: 90_000 }]);
    await rules.tick(Date.now());
    const [alert] = await ds.query(
      `SELECT severity, title FROM tracking.alerts WHERE rule_id = 'DELAY-GPS'`,
    );
    expect(alert).toEqual({ severity: 'warning', title: 'Delivery is already late' });
  });

  it('"already late" alerts at once: Critical when 240+ min late', async () => {
    const trip = await setup(-300, 600); // promised 5 h ago
    await routes.planner.planPending();
    await promise(trip.tripId, trip.promisedInMin);
    await feed(trip, [{ minAgo: 1, alongM: 90_000 }]);
    await rules.tick(Date.now());
    const [alert] = await ds.query(
      `SELECT severity, title FROM tracking.alerts WHERE rule_id = 'DELAY-GPS'`,
    );
    expect(alert).toEqual({ severity: 'critical', title: 'Delivery is already late' });
  });

  it('DEV-GPS: 6 km driven 1.5 km off the corridor raises; ops approving the detour closes it', async () => {
    const trip = await setup(600, 60);
    await routes.planner.planPending();
    await feed(trip, [
      ...Array.from({ length: 10 }, (_, i) => ({ minAgo: 20 - i, alongM: 10_000 + i * 800 })),
      ...Array.from({ length: 10 }, (_, i) => ({
        minAgo: 9.5 - i, // recent: older (buffered) fixes never alert
        alongM: 18_000 + i * 700,
        offM: 1500,
      })),
    ]);
    const [dev] = await ds.query(
      `SELECT id, status FROM tracking.alerts WHERE rule_id = 'DEV-GPS'`,
    );
    expect(dev.status).toBe('open');

    const detour = ROAD.map((p) => ({ lat: p.lat, lng: Number((p.lng + 1500 * E).toFixed(5)) }));
    const forbidden = await request(app)
      .post(`/v1/trips/${trip.tripId}/route/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ reason: 'Bridge closed', polyline: encodePolyline(detour) });
    expect(forbidden.status).toBe(403);
    const approved = await request(app)
      .post(`/v1/trips/${trip.tripId}/route/approve`)
      .set('Authorization', `Bearer ${token({ permissions: ['tracking.routes.approve'] })}`)
      .send({ reason: 'Bridge closed', polyline: encodePolyline(detour) });
    expect(approved.status).toBe(201);
    expect(approved.body.data).toMatchObject({
      version: 2,
      kind: 'approved_alternate',
      closedDeviationAlerts: 1,
    });
    const [after] = await ds.query(
      `SELECT status, close_reason FROM tracking.alerts WHERE id = $1`,
      [dev.id],
    );
    expect(after).toEqual({ status: 'closed', close_reason: 'alternate_approved' });
  });

  it('without a provider, trips are marked no_api_key and retried later', async () => {
    const offline = createRoutesModule({
      dataSource: ds,
      redis,
      logger: silentLogger,
      provider: null,
      geocoder: null,
    });
    const trip = await setup(600, 60);
    await offline.planner.planPending();
    const [row] = await ds.query(
      `SELECT status AS route_status, attempts AS route_attempts FROM tracking.trip_route_status WHERE trip_id = $1`,
      [trip.tripId],
    );
    expect(row).toEqual({ route_status: 'no_api_key', route_attempts: 1 });
    expect(await offline.planner.planPending()).toBe(0); // backing off
  });
});

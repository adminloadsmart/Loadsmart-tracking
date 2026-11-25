import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  infraAvailable,
  silentLogger,
  testDataSource,
  testRedis,
  truncateTrackingTables,
} from '../../__tests__/support/infra';
import { seedLoad } from '../../__tests__/support/main-schema';
import { createTripsModule } from '../trips';
import { tripRefKey, vehicleActiveTripKey } from '../trips/active-trip-index';
import { marketVehicleId } from '../trips/trip-state';
import { createApp } from '../../app';
import { buildContainer } from '../../composition-root';

const available = await infraAvailable();
const SECRET = 'integration-test-secret-integration-test';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!available)('created trips — POST /trips (real Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    app = createApp(
      buildContainer({
        dataSource: ds,
        redis,
        mainRedis: redis,
        jwtSecret: SECRET,
        logger: silentLogger,
      }),
    );
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
  });
  afterAll(async () => {
    await redis.quit();
  });

  const token = (overrides: object = {}) =>
    jwt.sign(
      {
        id: randomUUID(),
        tenantId: TENANT_A,
        role: 'dispatch',
        portal: 'organization',
        purpose: 'access',
        jti: randomUUID(),
        ...overrides,
      },
      SECRET,
      { algorithm: 'HS256', expiresIn: 900 },
    );
  const auth = (req: request.Test, t = token()) => req.set('Authorization', `Bearer ${t}`);

  const body = (loadingPointId: string) => ({
    customerName: 'ACME Ltd',
    source: { kind: 'loading_point', id: loadingPointId, name: 'Plant', address: 'Plot 1' },
    // Both ends are master places (an inbound trip can end at a loading point).
    destination: {
      kind: 'loading_point',
      id: loadingPointId,
      name: 'Warehouse',
      address: 'NH 48, Pune',
      city: 'Pune',
    },
    direction: 'out',
    vehicleNumber: 'mh 12 ab 1234',
    driverPhone: '9876543210',
    delivery: {
      mode: 'appointment',
      appointmentId: 'APT-7',
      slotFrom: '2026-11-26T04:30:00.000Z',
      slotTo: '2026-11-26T06:30:00.000Z',
    },
    driver: { name: 'Ravi Kumar', licenceNumber: 'gj0420120005008' },
    transporter: { name: 'Speedy Roadlines', phone: '9000000000' },
    ewayBill: { number: '331012345678', validTill: '2026-11-28T18:29:59.000Z' },
  });

  it('stores the trip in tracking.trips and returns it by its trip id', async () => {
    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });

    const created = await auth(request(app).post('/v1/trips')).send(body(loadingPointId));

    expect(created.status).toBe(201);
    const trip = created.body.data;
    expect(trip).toMatchObject({
      loadCode: 'TRP-0001',
      trackingOnly: true,
      trackingState: 'active',
      direction: 'out',
      vehicleNumber: 'MH12AB1234',
      driverName: 'Ravi Kumar',
      transporterName: 'Speedy Roadlines',
      promisedDeliveryAt: '2026-11-26T06:30:00.000Z',
      appointment: { id: 'APT-7', from: '2026-11-26T04:30:00.000Z' },
      ewayBillNumber: '331012345678',
      position: null,
    });
    // The picked masters give the map its coordinates.
    expect(trip.origin).toMatchObject({ id: loadingPointId, name: 'Plant', lat: 28.6, lng: 77.2 });
    expect(trip.destination).toMatchObject({ name: 'Warehouse', city: 'Pune', lat: 28.6 });

    const [row] = await ds.query(
      `SELECT tenant_id, status, driver_licence_number FROM tracking.trips WHERE id = $1`,
      [trip.tripId],
    );
    expect(row).toEqual({
      tenant_id: TENANT_A,
      // Saved, waiting for its first ping.
      status: 'waiting_first_ping',
      driver_licence_number: 'GJ0420120005008',
    });

    const fetched = await auth(request(app).get(`/v1/trips/${trip.tripId}`));
    expect(fetched.status).toBe(200);
    expect(fetched.body.data).toMatchObject({ tripId: trip.tripId, loadCode: 'TRP-0001' });

    // The route/track endpoints the map calls answer (empty) instead of 404.
    const route = await auth(request(app).get(`/v1/trips/${trip.tripId}/route`));
    expect(route.status).toBe(200);
  });

  it('lists created trips with load trips and numbers them per tenant', async () => {
    const { loadingPointId } = await seedLoad(ds, {
      tenantId: TENANT_A,
      status: 'in_transit_unloading',
    });
    await auth(request(app).post('/v1/trips')).send(body(loadingPointId));
    // Another truck and another driver: neither can be on two trips at once.
    const second = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      vehicleNumber: 'MH12AB9999',
      driverPhone: '9876500001',
    });
    const other = await auth(request(app).post('/v1/trips'), token({ tenantId: TENANT_B })).send(
      body(loadingPointId),
    );

    expect(second.body.data.loadCode).toBe('TRP-0002');
    expect(other.body.data.loadCode).toBe('TRP-0001');

    const list = await auth(request(app).get('/v1/trips?state=active'));
    const codes = list.body.data.trips.map((t: { loadCode: string }) => t.loadCode);
    expect(codes.slice(0, 2)).toEqual(['TRP-0002', 'TRP-0001']);
    expect(list.body.data.trips).toHaveLength(3); // + the in-transit load trip
    // Tenant B's trip is not visible to tenant A.
    const hidden = await auth(request(app).get(`/v1/trips/${other.body.data.tripId}`));
    expect(hidden.status).toBe(404);
  });

  it('refuses a second active trip for the same truck or the same driver, per account', async () => {
    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });
    const first = await auth(request(app).post('/v1/trips')).send(body(loadingPointId));
    expect(first.status).toBe(201);

    const message = (res: request.Response) => String(res.body.error?.message ?? res.body.message);
    const again = await auth(request(app).post('/v1/trips')).send(body(loadingPointId));
    expect(again.status).toBe(409);
    expect(message(again)).toContain('TRP-0001');
    // The same truck with another driver…
    const sameTruck = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      driverPhone: '9876500009',
    });
    expect(sameTruck.status).toBe(409);
    expect(message(sameTruck)).toContain('Truck MH12AB1234');
    // …and the same driver in another truck.
    const sameDriver = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      vehicleNumber: 'MH12ZZ0001',
    });
    expect(sameDriver.status).toBe(409);
    expect(message(sameDriver)).toContain('This driver');

    // Another account may track the same truck and driver.
    const otherAccount = await auth(
      request(app).post('/v1/trips'),
      token({ tenantId: TENANT_B }),
    ).send(body(loadingPointId));
    expect(otherAccount.status).toBe(201);

    // Once the first one ends, a new trip can start.
    await auth(request(app).post(`/v1/trips/${first.body.data.tripId}/end`)).send({});
    const after = await auth(request(app).post('/v1/trips')).send(body(loadingPointId));
    expect(after.status).toBe(201);
  });

  it('edits the truck, driver, destination and LR number of an active created trip', async () => {
    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });
    const created = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      lrNumber: 'LR-100',
    });
    const { tripId } = created.body.data;
    expect(created.body.data).toMatchObject({
      lrNumber: 'LR-100',
      trackingSource: 'sim',
      // No point has arrived yet: tracking hasn't started.
      trackingStartedAt: null,
      vehicleVerified: false,
    });

    const edited = await auth(request(app).patch(`/v1/trips/${tripId}`)).send({
      vehicleNumber: 'KA 01 AB 0001',
      vahanStatus: 'verified',
      driver: { name: 'Suresh' },
      destination: {
        kind: 'loading_point',
        id: loadingPointId,
        name: 'New Warehouse',
        address: 'MIDC, Nagpur',
        lat: 21.1,
        lng: 79.0,
      },
      lrNumber: 'LR-200',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      vehicleNumber: 'KA01AB0001',
      vehicleId: marketVehicleId(TENANT_A, 'KA01AB0001'),
      driverName: 'Suresh',
      lrNumber: 'LR-200',
      vehicleVerified: true,
      // The master's current pin is what the map shows.
      destination: { name: 'New Warehouse', lat: 28.6, lng: 77.2 },
    });

    // Found on VAHAN with an expired paper is not "Verified".
    const expired = await auth(request(app).patch(`/v1/trips/${tripId}`)).send({
      vehicleNumber: 'KA01AB0002',
      vahanStatus: 'non_compliant',
    });
    expect(expired.body.data.vehicleVerified).toBe(false);

    // Moving onto a truck the driver is already running is refused.
    const busy = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      driverPhone: '9876500002',
    });
    expect(busy.status).toBe(201);
    const clash = await auth(request(app).patch(`/v1/trips/${tripId}`)).send({
      vehicleNumber: 'MH12AB1234',
    });
    expect(clash.status).toBe(409);

    await auth(request(app).post(`/v1/trips/${tripId}/end`)).send({});
    const late = await auth(request(app).patch(`/v1/trips/${tripId}`)).send({ lrNumber: 'X' });
    expect(late.status).toBe(400);
  });

  it('ends a created trip, which then lists as ended', async () => {
    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });
    const { tripId } = (await auth(request(app).post('/v1/trips')).send(body(loadingPointId))).body
      .data;

    const ended = await auth(request(app).post(`/v1/trips/${tripId}/end`)).send({
      status: 'cancelled',
    });
    expect(ended.status).toBe(200);
    expect(ended.body.data.trackingState).toBe('ended');

    const again = await auth(request(app).post(`/v1/trips/${tripId}/end`)).send({});
    expect(again.status).toBe(400);

    const active = await auth(request(app).get('/v1/trips?state=active'));
    expect(active.body.data.trips.map((t: { tripId: string }) => t.tripId)).not.toContain(tripId);
    const endedList = await auth(request(app).get('/v1/trips?state=ended'));
    expect(endedList.body.data.trips.map((t: { tripId: string }) => t.tripId)).toContain(tripId);
    // A cancelled trip is under Cancelled, not Completed, and says how it ended.
    const ids = async (state: string) =>
      (await auth(request(app).get(`/v1/trips?state=${state}`))).body.data.trips.map(
        (t: { tripId: string }) => t.tripId,
      );
    expect(await ids('cancelled')).toContain(tripId);
    expect(await ids('completed')).not.toContain(tripId);
    expect(
      endedList.body.data.trips.find((t: { tripId: string }) => t.tripId === tripId),
    ).toMatchObject({
      outcome: 'cancelled',
    });
  });

  it('decides how the truck is tracked: fleet GPS, else the driver app, else SIM on the number', async () => {
    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });
    const fleetId = randomUUID();
    await ds.query(
      `INSERT INTO masters.vehicles (id, tenant_id, registration_number) VALUES ($1, $2, 'GJ-01-GP-0001')`,
      [fleetId, TENANT_A],
    );
    await ds.query(
      `INSERT INTO masters.vehicle_telemetry_meta (tenant_id, vehicle_id, has_gps, gps_enabled)
       VALUES ($1, $2, true, true)`,
      [TENANT_A, fleetId],
    );
    // masters.drivers isn't truncated between tests: a fresh number keeps the match unambiguous.
    const appPhone = `9${String(Date.now()).slice(-9)}`;
    const appDriver = randomUUID();
    await ds.query(
      `INSERT INTO masters.drivers (id, full_name, phone_number) VALUES ($1, 'App Driver', $2)`,
      [appDriver, appPhone],
    );
    await ds.query(`INSERT INTO masters.driver_sessions (driver_id) VALUES ($1)`, [appDriver]);
    const create = async (vehicleNumber: string, driverPhone: string) => {
      const res = await auth(request(app).post('/v1/trips')).send({
        ...body(loadingPointId),
        vehicleNumber,
        driverPhone,
      });
      expect(res.status).toBe(201);
      const [row] = await ds.query(
        `SELECT vehicle_id, own_fleet, driver_id, tracking_source FROM tracking.trips WHERE id = $1`,
        [res.body.data.tripId],
      );
      return { view: res.body.data, row };
    };

    const gps = await create('gj 01 gp 0001', '9876543210');
    expect(gps.row).toEqual({
      vehicle_id: fleetId,
      own_fleet: true,
      driver_id: null,
      tracking_source: 'gps',
    });
    expect(gps.view.vehicleId).toBe(fleetId);

    const app_ = await create('KA01ZZ9999', appPhone);
    expect(app_.row).toMatchObject({ driver_id: appDriver, tracking_source: 'driver_app' });

    const sim = await create('KA01ZZ9998', '9876500003');
    expect(sim.row).toEqual({
      vehicle_id: marketVehicleId(TENANT_A, 'KA01ZZ9998'),
      own_fleet: false,
      driver_id: null,
      tracking_source: 'sim',
    });
  });

  it('indexes an active created trip for live points, and drops it once ended', async () => {
    const trips = createTripsModule(ds, redis, silentLogger);
    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });
    const { tripId } = (await auth(request(app).post('/v1/trips')).send(body(loadingPointId))).body
      .data;
    const vehicleId = marketVehicleId(TENANT_A, 'MH12AB1234');

    await trips.watcher.poll();
    expect(await redis.get(vehicleActiveTripKey(vehicleId))).toBe(tripId);
    // Its pickup (a loading point with coordinates) has a geofence, so it heads there first.
    expect(await redis.hgetall(tripRefKey(tripId))).toMatchObject({
      tenantId: TENANT_A,
      loadStatus: 'in_transit_loading',
      trackingSource: 'sim',
      postingType: 'market_fleet',
    });
    // A rebuild keeps it (it would otherwise remove keys no load accounts for).
    await trips.watcher.rebuild();
    expect(await redis.get(vehicleActiveTripKey(vehicleId))).toBe(tripId);

    await auth(request(app).post(`/v1/trips/${tripId}/end`)).send({});
    await trips.watcher.poll();
    expect(await redis.get(vehicleActiveTripKey(vehicleId))).toBeNull();
  });

  it('shows a created SIM trip’s consent by its trip id', async () => {
    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });
    const { tripId } = (await auth(request(app).post('/v1/trips')).send(body(loadingPointId))).body
      .data;
    const consent = await auth(request(app).get(`/v1/trips/${tripId}/sim-consent`));
    expect(consent.status).toBe(200);
    expect(consent.body.data).toMatchObject({ tripId, applicable: true });
  });

  it('rejects a bad body and a platform admin without a tenant', async () => {
    const bad = await auth(request(app).post('/v1/trips')).send({ driverPhone: '123' });
    expect(bad.status).toBe(400);

    const { loadingPointId } = await seedLoad(ds, { tenantId: TENANT_A });
    // A place must be in the masters: a typed address (or one without a master id) is refused.
    const typed = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      destination: { kind: 'address', name: 'Warehouse', address: 'NH 48, Pune' },
    });
    expect(typed.status).toBe(400);

    // VAHAN failed: the RC photo is required. Sarathi manual review: both licence photos are.
    const noRc = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      vahanStatus: 'not_found',
    });
    expect(noRc.status).toBe(400);
    const oneSide = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      driver: { licenceStatus: 'manual_review', licenceFrontKey: 'masters/driver/t/front.jpg' },
    });
    expect(oneSide.status).toBe(400);
    const withPhotos = await auth(request(app).post('/v1/trips')).send({
      ...body(loadingPointId),
      vahanStatus: 'not_found',
      rcKey: 'masters/vehicle/t/rc.jpg',
      driver: {
        licenceStatus: 'manual_review',
        licenceFrontKey: 'masters/driver/t/front.jpg',
        licenceBackKey: 'masters/driver/t/back.jpg',
      },
    });
    expect(withPhotos.status).toBe(201);
    const [saved] = await ds.query(
      `SELECT rc_key, dl_status, dl_front_key, dl_back_key FROM tracking.trips WHERE id = $1`,
      [withPhotos.body.data.tripId],
    );
    expect(saved).toEqual({
      rc_key: 'masters/vehicle/t/rc.jpg',
      dl_status: 'manual_review',
      dl_front_key: 'masters/driver/t/front.jpg',
      dl_back_key: 'masters/driver/t/back.jpg',
    });

    const admin = await auth(
      request(app).post('/v1/trips'),
      token({ tenantId: null, role: 'platform_admin', portal: 'platform' }),
    ).send(body(loadingPointId));
    expect(admin.status).toBe(400);
  });
});

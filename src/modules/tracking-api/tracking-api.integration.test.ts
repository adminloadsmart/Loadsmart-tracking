import { randomUUID } from 'crypto';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import type Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  drainPointStreams,
  infraAvailable,
  silentLogger,
  testDataSource,
  testRedis,
  truncateTrackingTables,
  waitFor,
} from '../../__tests__/support/infra';
import { createApp } from '../../app';
import { buildContainer } from '../../composition-root';
import { allPointStreamKeys } from '../../streams/partitioner';
import { createLiveModule, createLivePublisher } from '../live';
import { createPointsModule, NormalizedPoint } from '../points';
import { createSyncModule } from '../sync';
import { parseSnapshot } from '../sync/sync.contract';
import { createTrackingApiModule } from './index';

const available = await infraAvailable();
const SECRET = 'integration-test-secret-integration-test';
const PARTITIONS = 4;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** Google polyline decoder (precision 5) — to assert on what the API returns. */
function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

describe.skipIf(!available)('tracking read API + /live (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let subscriber: Redis;
  let points: ReturnType<typeof createPointsModule>;
  let sync: ReturnType<typeof createSyncModule>;
  let app: ReturnType<typeof createApp>;
  let httpServer: HttpServer;
  let io: Server;
  let liveUrl: string;
  let fanoutStop: () => Promise<void>;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    subscriber = testRedis();
    sync = createSyncModule(ds, redis, silentLogger);
    points = createPointsModule(
      ds,
      redis,
      { partitions: PARTITIONS, maxLen: 10_000 },
      {},
      { onLatestPositions: createLivePublisher(redis).publish, logger: silentLogger },
    );
    app = createApp(
      buildContainer({
        dataSource: ds,
        redis,
        mainRedis: redis,
        jwtSecret: SECRET,
        logger: silentLogger,
      }),
    );

    httpServer = createServer();
    io = new Server(httpServer, { transports: ['websocket'] });
    const fanout = await createLiveModule({
      subscriber,
      mainRedis: redis,
      service: createTrackingApiModule(ds, redis).service,
      jwtSecret: SECRET,
      logger: silentLogger,
      minIntervalMs: 300,
    }).attach(io.of('/live'));
    fanoutStop = () => fanout.stop();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    liveUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}/live`;
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
  });
  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });
  afterAll(async () => {
    await fanoutStop();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await Promise.all([redis.quit(), subscriber.quit()]);
  });

  // --- helpers -------------------------------------------------------------------------------

  function staffToken(overrides: object = {}) {
    return jwt.sign(
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
  }
  const get = (path: string, token = staffToken()) =>
    request(app).get(path).set('Authorization', `Bearer ${token}`);

  async function seedTrip(tenantId: string, plate: string) {
    const tripId = randomUUID();
    const vehicleId = randomUUID();
    await sync.service.apply(
      parseSnapshot({
        type: 'vehicle',
        id: vehicleId,
        tenantId,
        version: '1',
        deleted: 'false',
        payload: JSON.stringify({
          registrationNumber: plate,
          status: 'active',
          gpsProvider: null,
          gpsEnabled: false,
          gpsDeviceImei: null,
        }),
      }),
    );
    await sync.service.apply(
      parseSnapshot({
        type: 'load',
        id: tripId,
        tenantId,
        version: '1',
        deleted: 'false',
        payload: JSON.stringify({
          code: `LOAD-${plate}`,
          status: 'in_transit',
          sourceType: 'own_fleet',
          vehicleId,
          vehicleNumber: plate,
          driverId: randomUUID(),
          driverNumber: null,
          driverName: 'Ravi',
          transporterId: null,
          loadingPointId: null,
          deliveryPointId: null,
          milestones: {
            loadingConfirmedAt: new Date(Date.now() - 3_600_000).toISOString(),
            atPlantAt: null,
            inTransitAt: null,
            reachedDeliveryPointAt: null,
            deliveredAt: null,
          },
        }),
      }),
    );
    return { tripId, vehicleId };
  }

  /** Drives a zig-zag route (so simplification has something to remove) and processes it. */
  async function drive(
    trip: { tripId: string; vehicleId: string },
    tenantId: string,
    count: number,
  ) {
    const start = Date.now() - count * 15_000;
    const fixes: NormalizedPoint[] = Array.from({ length: count }, (_, i) => ({
      tenantId,
      vehicleId: trip.vehicleId,
      tripId: trip.tripId,
      source: 'driver_app',
      sourceRef: 'd1',
      recordedAt: new Date(start + i * 15_000).toISOString(),
      receivedAt: new Date().toISOString(),
      lat: Number((28.6 + i * 0.002).toFixed(6)),
      lng: 77.2 + (i % 2) * 0.00002,
      speedKmh: 50,
      heading: 0,
      accuracyM: 5,
      flags: null,
    }));
    await points.publisher.publish(fixes);
    await drainPointStreams(redis, allPointStreamKeys(PARTITIONS), (s, e) =>
      points.processing.handleBatch(s, e),
    );
    return fixes;
  }

  function viewer(token: string): ClientSocket {
    const socket = connect(liveUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token },
    });
    clients.push(socket);
    return socket;
  }
  const connected = (socket: ClientSocket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });

  // --- REST ----------------------------------------------------------------------------------

  it('requires a staff access token with tracking scope', async () => {
    expect((await request(app).get('/v1/vehicles/live')).status).toBe(401);
    const driverToken = jwt.sign(
      { id: randomUUID(), tenantId: TENANT_A, purpose: 'driver-access' },
      SECRET,
    );
    expect((await get('/v1/vehicles/live', driverToken)).status).toBe(401);
    expect(
      (
        await get(
          '/v1/vehicles/live',
          staffToken({ tenantId: null, role: 'sales', portal: 'platform' }),
        )
      ).status,
    ).toBe(403);
    const jti = randomUUID();
    await redis.set(`access-token-blocklist:${jti}`, '1');
    expect((await get('/v1/vehicles/live', staffToken({ jti }))).status).toBe(401);
  });

  it('fleet live: own tenant only (platform admin sees all), with positions and active trips', async () => {
    const a = await seedTrip(TENANT_A, 'MH12AA0001');
    const b = await seedTrip(TENANT_B, 'MH12BB0002');
    await drive(a, TENANT_A, 3);

    const res = await get('/v1/vehicles/live');
    expect(res.status).toBe(200);
    expect(res.body.data.vehicles).toHaveLength(1);
    expect(res.body.data.vehicles[0]).toMatchObject({
      vehicleId: a.vehicleId,
      registrationNumber: 'MH12AA0001',
      activeTripId: a.tripId,
      position: { source: 'driver_app', stale: false, lat: 28.604 },
    });

    const admin = await get(
      '/v1/vehicles/live',
      staffToken({ tenantId: null, role: 'platform_admin', portal: 'platform' }),
    );
    expect(admin.body.data.vehicles.map((v: { vehicleId: string }) => v.vehicleId).sort()).toEqual(
      [a.vehicleId, b.vehicleId].sort(),
    );

    // Another tenant's vehicle and trip are simply not found.
    expect((await get(`/v1/vehicles/${b.vehicleId}/location`)).status).toBe(404);
    expect((await get(`/v1/trips/${b.tripId}`)).status).toBe(404);
  });

  it('trip summary has distance, position and milestones; active-trip list includes it', async () => {
    const a = await seedTrip(TENANT_A, 'MH12AA0003');
    await drive(a, TENANT_A, 5);

    const trip = await get(`/v1/trips/${a.tripId}`);
    expect(trip.status).toBe(200);
    expect(trip.body.data).toMatchObject({
      tripId: a.tripId,
      loadCode: 'LOAD-MH12AA0003',
      trackingState: 'active',
      fraudFlags: [],
      position: { lat: 28.608 },
    });
    expect(trip.body.data.distanceKm).toBeCloseTo(0.89, 1);

    const list = await get('/v1/trips?state=active');
    expect(list.body.data.trips.map((t: { tripId: string }) => t.tripId)).toContain(a.tripId);
  });

  it('track: simplified polyline vs full playback points', async () => {
    const a = await seedTrip(TENANT_A, 'MH12AA0004');
    const fixes = await drive(a, TENANT_A, 40);

    const full = await get(`/v1/trips/${a.tripId}/track?resolution=full`);
    const low = await get(`/v1/trips/${a.tripId}/track?resolution=low`);
    expect(full.body.data.pointCount).toBe(40);
    const fullLine = decodePolyline(full.body.data.polyline);
    const lowLine = decodePolyline(low.body.data.polyline);
    expect(fullLine).toHaveLength(40);
    // The 2 m zig-zag is removed at low resolution; the endpoints survive.
    expect(lowLine.length).toBeLessThan(5);
    expect(lowLine[0]).toEqual([28.6, 77.2]);
    expect(lowLine.at(-1)![0]).toBeCloseTo(fixes.at(-1)!.lat, 5);

    const playback = await get(`/v1/trips/${a.tripId}/track?resolution=full&format=points`);
    expect(playback.body.data.points).toHaveLength(40);
    expect(playback.body.data.points[0]).toMatchObject({
      lat: 28.6,
      source: 'driver_app',
      motion: 'moving',
    });
    expect((await get(`/v1/trips/${a.tripId}/track?format=points`)).status).toBe(400);
  });

  it('vehicle timeline over a raw window', async () => {
    const a = await seedTrip(TENANT_A, 'MH12AA0005');
    await drive(a, TENANT_A, 10);
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const res = await get(
      `/v1/vehicles/${a.vehicleId}/timeline?from=${from}&to=${to}&resolution=full`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ granularity: 'raw', pointCount: 10 });
    expect((await get(`/v1/vehicles/${a.vehicleId}/timeline?from=${to}&to=${from}`)).status).toBe(
      400,
    );
  });

  // --- /live ---------------------------------------------------------------------------------

  it('/live: snapshot on subscribe, then tenant-isolated position pushes', async () => {
    const a = await seedTrip(TENANT_A, 'MH12AA0006');
    const b = await seedTrip(TENANT_B, 'MH12BB0007');

    await expect(connected(viewer('nope'))).rejects.toThrow('unauthorized');

    const viewerA = viewer(staffToken());
    const viewerB = viewer(staffToken({ tenantId: TENANT_B }));
    await Promise.all([connected(viewerA), connected(viewerB)]);

    const fleetAck = await viewerA.timeout(5000).emitWithAck('subscribe', { type: 'fleet' });
    expect(fleetAck.ok).toBe(true);
    expect(fleetAck.snapshot.vehicles.map((v: { vehicleId: string }) => v.vehicleId)).toEqual([
      a.vehicleId,
    ]);
    // B can't subscribe to A's trip.
    expect(
      await viewerB.timeout(5000).emitWithAck('subscribe', { type: 'trip', id: a.tripId }),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect((await viewerB.timeout(5000).emitWithAck('subscribe', { type: 'fleet' })).ok).toBe(true);

    const receivedA: Array<{ vehicleId: string }> = [];
    const receivedB: Array<{ vehicleId: string }> = [];
    viewerA.on('position', (event) => receivedA.push(event));
    viewerB.on('position', (event) => receivedB.push(event));

    await drive(a, TENANT_A, 2);
    await waitFor(async () => receivedA.length === 1);
    expect(receivedA[0]).toMatchObject({
      vehicleId: a.vehicleId,
      tripId: a.tripId,
      position: { lat: 28.602 },
    });

    await drive(b, TENANT_B, 2);
    await waitFor(async () => receivedB.length === 1);
    expect(receivedA).toHaveLength(1); // A never sees B's truck
  });

  it('/live: throttles per vehicle but always delivers the newest position', async () => {
    const a = await seedTrip(TENANT_A, 'MH12AA0008');
    const socket = viewer(staffToken());
    await connected(socket);
    await socket.timeout(5000).emitWithAck('subscribe', { type: 'vehicle', id: a.vehicleId });
    const received: Array<{ position: { lat: number } }> = [];
    socket.on('position', (event) => received.push(event));

    // Three batches in quick succession → first pushed now, the newest pushed after the window.
    for (let i = 0; i < 3; i += 1) {
      await points.publisher.publish([
        {
          tenantId: TENANT_A,
          vehicleId: a.vehicleId,
          tripId: a.tripId,
          source: 'driver_app',
          sourceRef: 'd1',
          recordedAt: new Date(Date.now() - (3 - i) * 15_000).toISOString(),
          receivedAt: new Date().toISOString(),
          lat: Number((28.6 + i * 0.002).toFixed(6)),
          lng: 77.2,
          speedKmh: 50,
          heading: 0,
          accuracyM: 5,
          flags: null,
        },
      ]);
      await drainPointStreams(redis, allPointStreamKeys(PARTITIONS), (s, e) =>
        points.processing.handleBatch(s, e),
      );
    }
    await waitFor(async () => received.length === 2, { timeoutMs: 3000 });
    expect(received.map((e) => e.position.lat)).toEqual([28.6, 28.604]);
  });
});

import { randomUUID } from 'crypto';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import type Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  infraAvailable,
  silentLogger,
  testDataSource,
  testRedis,
  truncateTrackingTables,
  waitFor,
} from '../../__tests__/support/infra';
import { allPointStreamKeys } from '../../streams/partitioner';
import { createPointsModule } from '../points';
import { tripFraudKey, tripMetricsKey, vehicleLatestKey } from '../processing/vehicle-state.store';
import { seedLoad, updateLoad } from '../../__tests__/support/main-schema';
import { createTripsModule } from '../trips';
import { createIngestPhoneModule } from './index';

const available = await infraAvailable();
const SECRET = 'integration-test-secret-integration-test';
const PARTITIONS = 4;
const TENANT = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!available)('/driver socket → stream → processing (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let httpServer: HttpServer;
  let io: Server;
  let url: string;
  let points: ReturnType<typeof createPointsModule>;
  let trips: ReturnType<typeof createTripsModule>;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    points = createPointsModule(ds, redis, { partitions: PARTITIONS, maxLen: 10_000 });
    trips = createTripsModule(ds, redis, silentLogger);

    httpServer = createServer();
    io = new Server(httpServer, { transports: ['websocket'] });
    createIngestPhoneModule({
      dataSource: ds,
      mainRedis: redis,
      activeTrips: trips.activeTrips,
      publisher: points.publisher,
      jwtSecret: SECRET,
      logger: silentLogger,
      options: { minLocIntervalMs: 200, minBatchIntervalMs: 0 },
    }).attach(io.of('/driver'));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    url = `http://localhost:${(httpServer.address() as AddressInfo).port}/driver`;
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
  });
  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await redis.quit();
  });

  // --- helpers -------------------------------------------------------------------------------

  function token(driverId: string, overrides: object = {}, expiresIn = 900) {
    return jwt.sign(
      { id: driverId, tenantId: TENANT, purpose: 'driver-access', jti: randomUUID(), ...overrides },
      SECRET,
      { algorithm: 'HS256', expiresIn },
    );
  }

  function client(authToken: string | undefined): ClientSocket {
    const socket = connect(url, {
      transports: ['websocket'],
      reconnection: false,
      auth: authToken ? { token: authToken } : {},
    });
    clients.push(socket);
    return socket;
  }

  async function connected(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  }

  /** Puts the driver on an active load in the main tables; the trip watcher indexes it. */
  async function startTrip(driverId: string, startedMinutesAgo = 60) {
    const seeded = await seedLoad(ds, {
      tenantId: TENANT,
      driverId,
      startedAt: new Date(Date.now() - startedMinutesAgo * 60_000),
    });
    await trips.watcher.poll();
    return {
      tripId: seeded.loadId,
      vehicleId: seeded.vehicleId!,
      end: async () => {
        await updateLoad(ds, seeded.loadId, { status: 'delivered', delivered_at: new Date() });
        await trips.watcher.poll();
      },
    };
  }

  /** Runs everything on the point stream through the processor once. */
  async function drainStreams(): Promise<number> {
    let processed = 0;
    for (const key of allPointStreamKeys(PARTITIONS)) {
      const raw = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
      if (raw.length === 0) continue;
      const entries = raw.map(([id, flat]) => ({ id, fields: { [flat[0]]: flat[1] } }));
      await points.processing.handleBatch(key, entries);
      processed += entries.length;
      await redis.del(key);
    }
    return processed;
  }

  const fix = (minutesAgo: number, latOffset = 0, extra: object = {}) => ({
    pointId: randomUUID(),
    lat: 28.6 + latOffset,
    lng: 77.2,
    accuracy: 8,
    speed: 14,
    bearing: 0,
    recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    isMock: false,
    batteryPct: 80,
    provider: 'fused',
    appState: 'foreground',
    ...extra,
  });

  const rows = (table: string, tripId: string) =>
    ds.query(`SELECT * FROM tracking.${table} WHERE trip_id = $1 ORDER BY recorded_at`, [tripId]);

  // --- tests ---------------------------------------------------------------------------------

  it('rejects connections without a valid driver-access token or with a revoked one', async () => {
    const driverId = randomUUID();
    for (const bad of [
      undefined,
      'garbage',
      token(driverId, { purpose: 'driver-identity-access', tenantId: null }),
      jwt.sign({ id: driverId, tenantId: TENANT, purpose: 'driver-access' }, 'wrong-secret'),
    ]) {
      await expect(connected(client(bad))).rejects.toThrow('unauthorized');
    }

    const jti = randomUUID();
    await redis.set(`access-token-blocklist:${jti}`, '1');
    await expect(connected(client(token(driverId, { jti })))).rejects.toThrow('unauthorized');

    await expect(connected(client(token(driverId)))).resolves.toBeUndefined();
  });

  it('falls back to the token query param or Authorization header when auth is not set', async () => {
    const viaQuery = (t: string) => {
      const socket = connect(url, {
        transports: ['websocket'],
        reconnection: false,
        query: { token: t },
      });
      clients.push(socket);
      return socket;
    };
    const viaHeader = (t: string) => {
      const socket = connect(url, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { Authorization: `Bearer ${t}` },
      });
      clients.push(socket);
      return socket;
    };

    await expect(connected(viaQuery(token(randomUUID())))).resolves.toBeUndefined();
    await expect(connected(viaHeader(token(randomUUID())))).resolves.toBeUndefined();
    await expect(connected(viaQuery('garbage'))).rejects.toThrow('unauthorized');
    await expect(connected(viaHeader('garbage'))).rejects.toThrow('unauthorized');
  });

  it('disconnects the socket when the token expires', async () => {
    const socket = client(token(randomUUID(), {}, 1));
    const expired = new Promise<void>((resolve) => socket.once('auth:expired', () => resolve()));
    await connected(socket);
    await expired;
    await waitFor(async () => socket.disconnected);
  });

  it('ingests a live fix onto the active trip: stored, latest position and state updated', async () => {
    const driverId = randomUUID();
    const { tripId, vehicleId } = await startTrip(driverId);
    const socket = client(token(driverId));
    await connected(socket);

    const ack = await socket.timeout(5000).emitWithAck('loc', fix(0));
    expect(ack).toEqual({ ok: true, accepted: 1, noTrip: 0 });
    expect(await drainStreams()).toBe(1);

    const [row] = await rows('location_points', tripId);
    expect(row).toMatchObject({
      vehicle_id: vehicleId,
      source: 'driver_app',
      source_ref: driverId,
    });
    expect(row.speed_kmh).toBeCloseTo(50.4, 1);
    expect(await redis.hget(vehicleLatestKey(vehicleId), 'tripId')).toBe(tripId);
  });

  it('accumulates distance from an offline batch, and a replayed batch changes nothing', async () => {
    const driverId = randomUUID();
    const { tripId } = await startTrip(driverId);
    const socket = client(token(driverId));
    await connected(socket);

    // 6 fixes, 15s apart, ~222 m apart → 5 gaps ≈ 1.11 km.
    const batch = Array.from({ length: 6 }, (_, i) => fix(10 - i * 0.25, i * 0.002));
    expect(await socket.timeout(5000).emitWithAck('loc:batch', batch)).toEqual({
      ok: true,
      accepted: 6,
      noTrip: 0,
    });
    await drainStreams();
    const distance = Number(await redis.hget(tripMetricsKey(tripId), 'distance_m:driver_app'));
    expect(distance).toBeCloseTo(5 * 222.4, -1);

    // App never got the ack and resends the same batch.
    await socket.timeout(5000).emitWithAck('loc:batch', batch);
    await drainStreams();
    expect(await rows('location_points', tripId)).toHaveLength(6);
    expect(Number(await redis.hget(tripMetricsKey(tripId), 'distance_m:driver_app'))).toBe(
      distance,
    );
  });

  it('acks noTrip and stores nothing for a driver not on a trip', async () => {
    const socket = client(token(randomUUID()));
    await connected(socket);
    expect(await socket.timeout(5000).emitWithAck('loc', fix(0))).toEqual({
      ok: true,
      accepted: 0,
      noTrip: 1,
    });
    expect(await drainStreams()).toBe(0);
  });

  it('places a batch flushed after the trip ended onto that trip (DB fallback)', async () => {
    const driverId = randomUUID();
    const { tripId, end } = await startTrip(driverId, 60);
    await end();
    const socket = client(token(driverId));
    await connected(socket);

    const ack = await socket
      .timeout(5000)
      .emitWithAck('loc:batch', [fix(30), fix(29.75, 0.002), fix(120)]); // last one predates the trip
    expect(ack).toEqual({ ok: true, accepted: 2, noTrip: 1 });
    await drainStreams();
    expect(await rows('location_points', tripId)).toHaveLength(2);
  });

  it('rate-limits loc and rejects invalid payloads', async () => {
    const driverId = randomUUID();
    await startTrip(driverId);
    const socket = client(token(driverId));
    await connected(socket);

    await socket.timeout(5000).emitWithAck('loc', fix(0));
    expect(await socket.timeout(5000).emitWithAck('loc', fix(0))).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await socket.timeout(5000).emitWithAck('loc', { lat: 'x' })).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
  });

  it('keeps a mock-location fix for audit only and flags the trip', async () => {
    const driverId = randomUUID();
    const { tripId } = await startTrip(driverId);
    const socket = client(token(driverId));
    await connected(socket);

    await socket.timeout(5000).emitWithAck('loc', fix(0, 0, { isMock: true }));
    await drainStreams();

    expect(await rows('location_points', tripId)).toHaveLength(0);
    const [audit] = await rows('location_points_short', tripId);
    expect(audit.flags).toMatchObject({ rejected: 'mock_location', isMock: true });
    expect(await redis.smembers(tripFraudKey(tripId))).toEqual(['mock_location']);
  });
});

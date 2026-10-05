import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
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
import { allPointStreamKeys, partitionFor, pointStreamKey } from '../../streams/partitioner';
import { deadLetterKey, GroupConsumer } from '../../streams/stream-consumer';
import { NormalizedPoint } from './point.contract';
import { createPointsModule } from './index';

const available = await infraAvailable();
const PARTITIONS = 4;
const TENANT = randomUUID();

function point(overrides: Partial<NormalizedPoint> = {}): NormalizedPoint {
  return {
    tenantId: TENANT,
    vehicleId: randomUUID(),
    tripId: null,
    source: 'driver_app',
    sourceRef: 'driver-1',
    recordedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    lat: 28.6139,
    lng: 77.209,
    speedKmh: 42,
    heading: 90,
    accuracyM: 8,
    flags: { batteryPct: 80 },
    ...overrides,
  };
}

describe.skipIf(!available)('point stream → hypertables (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let blocking: Redis;
  let consumer: GroupConsumer;
  let points: ReturnType<typeof createPointsModule>;

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    blocking = testRedis();
    points = createPointsModule(ds, redis, { partitions: PARTITIONS, maxLen: 10_000 });
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
    consumer = new GroupConsumer({
      name: 'points-test',
      redis,
      blockingRedis: blocking,
      group: 'processors',
      consumer: 'c1',
      streams: () => allPointStreamKeys(PARTITIONS),
      handler: (stream, entries) => points.processing.handleBatch(stream, entries),
      logger: silentLogger,
      blockMs: 50,
      claimIdleMs: 50,
    });
    consumer.start();
  });
  afterEach(async () => {
    await consumer.stop();
  });
  afterAll(async () => {
    await Promise.all([redis.quit(), blocking.quit()]);
  });

  const count = async (table: string) =>
    Number((await ds.query(`SELECT count(*)::int AS n FROM tracking.${table}`))[0].n);

  it('publishes to the vehicle’s partition and stores trip vs idle points in their tables', async () => {
    const onTrip = point({ tripId: randomUUID() });
    const idle = point();
    await points.publisher.publish([onTrip, idle]);

    expect(
      await redis.xlen(pointStreamKey(partitionFor(onTrip.vehicleId, PARTITIONS))),
    ).toBeGreaterThan(0);

    await waitFor(
      async () =>
        (await count('location_points')) === 1 && (await count('location_points_short')) === 1,
    );
    const [row] = await ds.query(
      `SELECT vehicle_id, trip_id, source, lat, speed_kmh, flags FROM tracking.location_points`,
    );
    expect(row).toMatchObject({
      vehicle_id: onTrip.vehicleId,
      trip_id: onTrip.tripId,
      source: 'driver_app',
      lat: 28.6139,
      speed_kmh: 42,
      flags: { batteryPct: 80 },
    });
  });

  it('is idempotent: re-publishing the same points stores them once', async () => {
    const batch = Array.from({ length: 50 }, (_, i) =>
      point({
        vehicleId: TENANT,
        recordedAt: new Date(Date.UTC(2026, 9, 5, 10, 0, i)).toISOString(),
      }),
    );
    await points.publisher.publish(batch);
    await points.publisher.publish(batch);

    const streamKey = pointStreamKey(partitionFor(TENANT, PARTITIONS));
    // Every entry delivered (lag 0) and acked (nothing pending) — not just "nothing pending yet".
    await waitFor(async () => {
      const groups = (await redis.xinfo('GROUPS', streamKey)) as unknown[][];
      const group = Object.fromEntries(
        Array.from({ length: groups[0].length / 2 }, (_, i) => [
          groups[0][2 * i],
          groups[0][2 * i + 1],
        ]),
      );
      return group.lag === 0 && group.pending === 0;
    });
    expect(await count('location_points_short')).toBe(50);
  });

  it('dead-letters an invalid point and still stores the valid ones', async () => {
    const vehicleId = randomUUID();
    const key = pointStreamKey(partitionFor(vehicleId, PARTITIONS));
    await redis.xadd(key, '*', 'p', JSON.stringify({ ...point({ vehicleId }), lat: 123 }));
    await points.publisher.publish([point({ vehicleId })]);

    await waitFor(
      async () =>
        (await redis.xlen(deadLetterKey(key))) === 1 &&
        (await count('location_points_short')) === 1,
    );
    const [[, fields]] = (await redis.xrange(deadLetterKey(key), '-', '+')) as Array<
      [string, string[]]
    >;
    expect(fields.join(' ')).toContain('invalid point: lat');
  });
});

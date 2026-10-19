import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createPointsModule, NormalizedPoint } from '../points';
import { seedLoad } from '../../__tests__/support/main-schema';
import { createTripsModule } from '../trips';
import {
  LIVE_ALERTS_CHANNEL,
  OutboxRelay,
  TRACKING_EVENTS_STREAM,
  createRulesModule,
} from './index';

const available = await infraAvailable();
const SECRET = 'integration-test-secret-integration-test';
const PARTITIONS = 4;
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!available)('rules engine end to end (real Redis + Postgres)', () => {
  let ds: DataSource;
  let redis: Redis;
  let subscriber: Redis;
  let trips: ReturnType<typeof createTripsModule>;
  let rules: ReturnType<typeof createRulesModule>;
  let points: ReturnType<typeof createPointsModule>;
  let app: ReturnType<typeof createApp>;
  const liveAlerts: Array<{ type: string; alert: { rule_id: string } }> = [];

  beforeAll(async () => {
    ds = await testDataSource();
    redis = testRedis();
    subscriber = testRedis();
    trips = createTripsModule(ds, redis, silentLogger);
    rules = createRulesModule({
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
      rules.hook,
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
    subscriber.on('message', (_channel, message) => liveAlerts.push(...JSON.parse(message)));
    await subscriber.subscribe(LIVE_ALERTS_CHANNEL);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await truncateTrackingTables(ds);
    liveAlerts.length = 0;
    rules.engine.invalidateSettings(TENANT);
  });
  afterAll(async () => {
    await Promise.all([redis.quit(), subscriber.quit()]);
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
  const api = (method: 'get' | 'post' | 'put', path: string, auth = token()) =>
    request(app)[method](path).set('Authorization', `Bearer ${auth}`);

  async function startTrip(tenantId = TENANT) {
    const seeded = await seedLoad(ds, {
      tenantId,
      code: 'LOAD-R1',
      startedAt: new Date(Date.now() - 3 * 3_600_000),
    });
    await trips.watcher.poll();
    return { tripId: seeded.loadId, vehicleId: seeded.vehicleId!, tenantId };
  }

  /** Sends fixes (seconds relative to now) through the real stream + processor + rules. */
  async function feed(
    trip: { tripId: string; vehicleId: string; tenantId: string },
    fixes: Array<[number, number, number] | [number, number, number, number]>,
  ) {
    const batch: NormalizedPoint[] = fixes.map(([offsetS, speedKmh, northM, accuracyM = 5]) => ({
      tenantId: trip.tenantId,
      vehicleId: trip.vehicleId,
      tripId: trip.tripId,
      source: 'driver_app',
      sourceRef: 'd1',
      recordedAt: new Date(Date.now() + offsetS * 1000).toISOString(),
      receivedAt: new Date().toISOString(),
      lat: Number((28.6 + northM / 111_195).toFixed(6)),
      lng: 77.2,
      speedKmh,
      heading: 0,
      accuracyM,
      flags: null,
    }));
    await points.publisher.publish(batch);
    await drainPointStreams(redis, allPointStreamKeys(PARTITIONS), (s, e) =>
      points.processing.handleBatch(s, e),
    );
  }
  const parked = (fromS: number, toS: number, northM = 0): Array<[number, number, number]> =>
    Array.from({ length: Math.floor((toS - fromS) / 15) + 1 }, (_, i) => [
      fromS + i * 15,
      0,
      northM,
    ]);

  it('a 12-minute halt on a trip → one episode, one Warning alert, on /live and in the outbox', async () => {
    const trip = await startTrip();
    await feed(trip, parked(-12 * 60, 0));

    const [episode] = await ds.query(`SELECT * FROM tracking.episodes WHERE trip_id = $1`, [
      trip.tripId,
    ]);
    expect(episode).toMatchObject({ rule_id: 'HALT-GPS', status: 'open', source: 'driver_app' });
    const [alert] = await ds.query(`SELECT * FROM tracking.alerts WHERE trip_id = $1`, [
      trip.tripId,
    ]);
    expect(alert).toMatchObject({
      rule_id: 'HALT-GPS',
      severity: 'warning',
      status: 'open',
      episode_id: episode.id,
    });

    await waitFor(async () =>
      liveAlerts.some((a) => a.type === 'alert.opened' && a.alert.rule_id === 'HALT-GPS'),
    );
    const outbox = await ds.query(`SELECT event_type FROM tracking.alert_outbox`);
    expect(outbox).toEqual([{ event_type: 'alert.opened' }]);

    // REST sees it; the timeline endpoint shows the episode.
    const list = await api('get', `/v1/alerts?tripId=${trip.tripId}`);
    expect(list.body.data.alerts).toHaveLength(1);
    expect(list.body.data.alerts[0]).toMatchObject({ ruleId: 'HALT-GPS', status: 'open' });
    const events = await api('get', `/v1/trips/${trip.tripId}/events`);
    expect(events.body.data.events[0]).toMatchObject({
      ruleId: 'HALT-GPS',
      kind: 'HALT-GPS',
      status: 'open',
    });

    // Driving off closes the halt and its alert.
    await feed(
      trip,
      Array.from({ length: 12 }, (_, i): [number, number, number] => [
        15 + i * 15,
        50,
        5 + i * 210,
      ]),
    );
    const [closed] = await ds.query(
      `SELECT status, close_reason FROM tracking.alerts WHERE id = $1`,
      [alert.id],
    );
    expect(closed).toEqual({ status: 'closed', close_reason: 'halt_ended:left_anchor' });
  });

  it('redelivering the same batch changes nothing (idempotent effects)', async () => {
    const trip = await startTrip();
    const fixes = parked(-12 * 60, 0);
    await feed(trip, fixes);
    await feed(trip, fixes); // same device times → late → no rule input
    expect(await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts`)).toEqual([{ n: 1 }]);
    expect(await ds.query(`SELECT count(*)::int AS n FROM tracking.episodes`)).toEqual([{ n: 1 }]);
  });

  it('acknowledge and close via the API; closing writes an outbox event; tenant isolation', async () => {
    const trip = await startTrip();
    await feed(trip, parked(-12 * 60, 0));
    const alertId = (await api('get', '/v1/alerts')).body.data.alerts[0].alertId;

    const ack = await api('post', `/v1/alerts/${alertId}/acknowledge`);
    expect(ack.body.data).toMatchObject({ status: 'acknowledged' });
    const otherTenant = await api(
      'post',
      `/v1/alerts/${alertId}/close`,
      token({ tenantId: OTHER_TENANT }),
    ).send({ reason: 'x' });
    expect(otherTenant.status).toBe(404);
    const close = await api('post', `/v1/alerts/${alertId}/close`).send({
      reason: 'Driver confirmed tea break',
    });
    expect(close.body.data).toMatchObject({
      status: 'closed',
      closeReason: 'Driver confirmed tea break',
    });
    expect(
      (await ds.query(`SELECT event_type FROM tracking.alert_outbox ORDER BY id`)).map(
        (r: { event_type: string }) => r.event_type,
      ),
    ).toEqual(['alert.opened', 'alert.closed']);
  });

  it('outbox relay publishes to tracking.events and empties the outbox', async () => {
    const trip = await startTrip();
    await feed(trip, parked(-12 * 60, 0));
    const relay = new OutboxRelay(ds, redis);
    expect(await relay.relay()).toBe(1);
    const [[, fields]] = (await redis.xrange(TRACKING_EVENTS_STREAM, '-', '+')) as Array<
      [string, string[]]
    >;
    expect(fields).toEqual(expect.arrayContaining(['type', 'alert.opened', 'tenantId', TENANT]));
    expect(await ds.query(`SELECT count(*)::int AS n FROM tracking.alert_outbox`)).toEqual([
      { n: 0 },
    ]);
  });

  it('INACT: phone silent 60+ min on a trip → "No data" episode + Medium alert; closes when data resumes', async () => {
    const trip = await startTrip();
    await feed(trip, [[-70 * 60, 50, 0]]); // last fix 70 minutes ago
    await rules.tick(Date.now());

    const [alert] = await ds.query(`SELECT * FROM tracking.alerts WHERE rule_id = 'INACT-GPS'`);
    expect(alert).toMatchObject({ severity: 'medium', status: 'open', trip_id: trip.tripId });
    const events = await api('get', `/v1/trips/${trip.tripId}/events`);
    expect(events.body.data.events[0]).toMatchObject({ kind: 'no_data', status: 'open' });

    await rules.tick(Date.now()); // still inactive: no duplicate
    expect(await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts`)).toEqual([{ n: 1 }]);

    await feed(trip, [[0, 50, 1000]]);
    const [after] = await ds.query(
      `SELECT status, close_reason FROM tracking.alerts WHERE id = $1`,
      [alert.id],
    );
    expect(after).toEqual({ status: 'closed', close_reason: 'data_resumed' });
    const [episode] = await ds.query(
      `SELECT status, metrics FROM tracking.episodes WHERE rule_id = 'INACT-GPS'`,
    );
    expect(episode.status).toBe('closed');
    expect(episode.metrics.durationS).toBeGreaterThan(69 * 60);
  });

  it('INACT: a packet that is rejected (e.g. low accuracy) still counts as activity; a future one does not', async () => {
    const trip = await startTrip();
    await feed(trip, [[-70 * 60, 50, 0]]); // last good fix 70 minutes ago
    await feed(trip, [[0, 50, 100, 500]]); // arrives now, rejected as low_accuracy
    await rules.tick(Date.now());
    expect(await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts`)).toEqual([{ n: 0 }]);

    const other = await startTrip();
    await feed(other, [[-70 * 60, 50, 0]]);
    await feed(other, [[30 * 60, 50, 100]]); // device clock 30 min ahead: future_timestamp
    await rules.tick(Date.now());
    const alerts = await ds.query(
      `SELECT trip_id FROM tracking.alerts WHERE rule_id = 'INACT-GPS'`,
    );
    expect(alerts).toEqual([{ trip_id: other.tripId }]);
  });

  it('rule settings: org admin can change thresholds (permission-checked), engine applies them', async () => {
    const forbidden = await api('put', '/v1/rule-settings/HALT-GPS').send({
      params: { recordAfterS: 300 },
    });
    expect(forbidden.status).toBe(403);
    const admin = token({ role: 'org_admin', permissions: ['tracking.settings.manage'] });
    const bad = await api('put', '/v1/rule-settings/HALT-GPS', admin).send({
      params: { recordAfterS: 'soon' },
    });
    expect(bad.status).toBe(400);
    const ok = await api('put', '/v1/rule-settings/HALT-GPS', admin).send({
      params: { recordAfterS: 300 },
    });
    expect(ok.body.data).toMatchObject({
      ruleId: 'HALT-GPS',
      params: { recordAfterS: 300, haltRadiusM: 150 },
    });

    rules.engine.invalidateSettings(TENANT);
    const trip = await startTrip();
    await feed(trip, parked(-6 * 60, 0)); // 6 min: enough with the 5-min override
    expect(
      await ds.query(`SELECT count(*)::int AS n FROM tracking.alerts WHERE rule_id = 'HALT-GPS'`),
    ).toEqual([{ n: 1 }]);

    const disable = await api('put', '/v1/rule-settings/HALT-GPS', admin).send({ enabled: false });
    expect(disable.body.data.enabled).toBe(false);
  });
});

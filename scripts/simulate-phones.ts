/**
 * Load simulator for the /driver socket (docs/ROADMAP.md Phase 2 exit criteria).
 *
 *   npx tsx scripts/simulate-phones.ts --phones 2000 --duration 600 [--burst 0.2]
 *
 * For each simulated phone it:
 *  1. publishes a `load` snapshot to `loadsmart.events` (exactly as the main backend's outbox
 *     relay would) so the sync consumer puts the driver on an active trip;
 *  2. connects to /driver with a driver-access JWT signed with JWT_SECRET;
 *  3. sends one `loc` every --interval ms along a straight northbound road.
 * With --burst, halfway through that fraction of phones disconnect for 60s and on reconnect flush
 * the fixes they recorded meanwhile as one `loc:batch`.
 *
 * Needs a running service (ROLE=all or realtime + processor) and the same .env.
 * Prints ack latency percentiles, errors and how many acked points reached Postgres.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { io, Socket } from 'socket.io-client';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const PHONES = arg('phones', 100);
const INTERVAL_MS = arg('interval', 15_000);
const DURATION_S = arg('duration', 120);
const BURST = arg('burst', 0);
const RAMP_MS = arg('ramp', 20_000);
const URL = process.env.SIM_URL ?? `http://localhost:${process.env.REALTIME_PORT ?? 4101}/driver`;
const SECRET = process.env.JWT_SECRET;
const TENANT = process.env.SIM_TENANT ?? randomUUID();
if (!SECRET) throw new Error('JWT_SECRET must be set (same as the service)');

const latencies: number[] = [];
const errors: Record<string, number> = {};
let accepted = 0;
let noTrip = 0;

interface Phone {
  driverId: string;
  vehicleId: string;
  tripId: string;
  socket: Socket | null;
  step: number;
  offline: Array<Record<string, unknown>>;
}

function fix(phone: Phone): Record<string, unknown> {
  phone.step += 1;
  return {
    pointId: randomUUID(),
    // ~200 m per fix northbound from a per-phone starting point.
    lat: 20 + ((phone.step * 0.0018) % 8),
    lng: 75 + (Number.parseInt(phone.driverId.slice(0, 6), 16) % 1000) / 1000,
    accuracy: 6 + Math.random() * 6,
    speed: 13 + Math.random() * 2,
    bearing: 0,
    recordedAt: new Date().toISOString(),
    isMock: false,
    batteryPct: 80,
    provider: 'fused',
    appState: 'background',
  };
}

async function send(phone: Phone, event: 'loc' | 'loc:batch', payload: unknown, count: number) {
  const started = performance.now();
  try {
    const ack = await phone.socket!.timeout(10_000).emitWithAck(event, payload);
    latencies.push(performance.now() - started);
    if (ack.ok) {
      accepted += ack.accepted;
      noTrip += ack.noTrip;
    } else {
      errors[ack.error] = (errors[ack.error] ?? 0) + 1;
      if (event === 'loc') phone.offline.push(payload as Record<string, unknown>);
    }
  } catch {
    errors.timeout = (errors.timeout ?? 0) + 1;
    if (event === 'loc') phone.offline.push(payload as Record<string, unknown>);
    else errors.lost_batch_points = (errors.lost_batch_points ?? 0) + count;
  }
}

function connectPhone(phone: Phone): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = io(URL, {
      transports: ['websocket'],
      reconnection: true,
      auth: (cb) =>
        cb({
          token: jwt.sign(
            { id: phone.driverId, tenantId: TENANT, purpose: 'driver-access', jti: randomUUID() },
            SECRET!,
            { algorithm: 'HS256', expiresIn: 900 },
          ),
        }),
    });
    phone.socket = socket;
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const mainRedis = new Redis(process.env.MAIN_REDIS_URL || process.env.REDIS_URL!);
  const redis = new Redis(process.env.REDIS_URL!);
  const phones: Phone[] = Array.from({ length: PHONES }, () => ({
    driverId: randomUUID(),
    vehicleId: randomUUID(),
    tripId: randomUUID(),
    socket: null,
    step: 0,
    offline: [],
  }));

  console.log(`Creating ${PHONES} active trips via loadsmart.events …`);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const pipeline = mainRedis.pipeline();
  for (const [i, phone] of phones.entries()) {
    pipeline.xadd(
      'loadsmart.events',
      '*',
      'type',
      'vehicle',
      'id',
      phone.vehicleId,
      'tenantId',
      TENANT,
      'version',
      String(Date.now()),
      'deleted',
      'false',
      'payload',
      JSON.stringify({
        registrationNumber: `SIM${String(i).padStart(6, '0')}`,
        status: 'active',
        gpsProvider: null,
        gpsEnabled: false,
        gpsDeviceImei: null,
      }),
    );
    pipeline.xadd(
      'loadsmart.events',
      '*',
      'type',
      'load',
      'id',
      phone.tripId,
      'tenantId',
      TENANT,
      'version',
      String(Date.now()),
      'deleted',
      'false',
      'payload',
      JSON.stringify({
        code: `SIM-${phone.tripId.slice(0, 8)}`,
        status: 'in_transit',
        sourceType: 'own_fleet',
        vehicleId: phone.vehicleId,
        vehicleNumber: null,
        driverId: phone.driverId,
        driverNumber: null,
        driverName: null,
        transporterId: null,
        loadingPointId: null,
        deliveryPointId: null,
        milestones: {
          loadingConfirmedAt: startedAt,
          atPlantAt: null,
          inTransitAt: null,
          reachedDeliveryPointAt: null,
          deliveredAt: null,
        },
      }),
    );
  }
  await pipeline.exec();
  const last = phones[phones.length - 1];
  for (let i = 0; !(await redis.get(`trk:drv:${last.driverId}:active_trip`)); i += 1) {
    if (i > 120) throw new Error('trips were not synced within 60s — is the processor running?');
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`Connecting ${PHONES} phones to ${URL} over ${RAMP_MS / 1000}s …`);
  await Promise.all(
    phones.map(async (phone, i) => {
      await new Promise((r) => setTimeout(r, (i / PHONES) * RAMP_MS));
      await connectPhone(phone);
    }),
  );
  const connected = performance.now();
  console.log(`Connected. Sending every ${INTERVAL_MS / 1000}s for ${DURATION_S}s …`);

  const timers = phones.map((phone, i) =>
    setTimeout(function tick() {
      timers[i] = setTimeout(tick, INTERVAL_MS);
      const point = fix(phone);
      if (phone.socket?.connected) void send(phone, 'loc', point, 1);
      else phone.offline.push(point);
    }, Math.random() * INTERVAL_MS),
  );

  if (BURST > 0) {
    setTimeout(
      () => {
        const group = phones.slice(0, Math.floor(PHONES * BURST));
        console.log(`Burst: ${group.length} phones offline for 60s …`);
        for (const phone of group) phone.socket!.disconnect();
        setTimeout(async () => {
          console.log('Burst: reconnecting and flushing offline queues …');
          await Promise.all(
            group.map(async (phone) => {
              await connectPhone(phone);
              const queued = phone.offline.splice(0, 200);
              if (queued.length > 0) await send(phone, 'loc:batch', queued, queued.length);
            }),
          );
        }, 60_000);
      },
      (DURATION_S * 1000) / 2,
    );
  }

  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  timers.forEach(clearTimeout);
  await new Promise((r) => setTimeout(r, 3000)); // let in-flight acks land
  const elapsedS = (performance.now() - connected) / 1000;

  console.log('\n=== results ===');
  console.log(
    `acks: ${latencies.length} in ${elapsedS.toFixed(0)}s (${(latencies.length / elapsedS).toFixed(1)}/s)`,
  );
  console.log(
    `ack latency ms  p50=${percentile(latencies, 50).toFixed(1)}  p95=${percentile(latencies, 95).toFixed(1)}  p99=${percentile(latencies, 99).toFixed(1)}  max=${Math.max(...latencies).toFixed(1)}`,
  );
  console.log(`points accepted=${accepted} noTrip=${noTrip} errors=${JSON.stringify(errors)}`);

  // Every acked point must reach Postgres (processor lag permitting).
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const count = async () =>
    Number(
      (
        await pg.query(
          `SELECT count(*)::int AS n FROM tracking.location_points WHERE tenant_id = $1`,
          [TENANT],
        )
      ).rows[0].n,
    );
  let stored = await count();
  for (let i = 0; i < 30 && stored < accepted; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    stored = await count();
  }
  console.log(
    `stored in location_points=${stored} (acked ${accepted}) → ${stored >= accepted ? 'NO LOSS' : `LOST ${accepted - stored}`}`,
  );

  for (const phone of phones) phone.socket?.disconnect();
  await Promise.all([pg.end(), mainRedis.quit(), redis.quit()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

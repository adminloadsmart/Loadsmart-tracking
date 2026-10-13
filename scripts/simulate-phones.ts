/**
 * Load simulator for the /driver socket (docs/ROADMAP.md Phase 2 exit criteria).
 *
 *   npx tsx scripts/simulate-phones.ts --phones 2000 --duration 600 [--burst 0.2]
 *
 * For each simulated phone it:
 *  1. inserts a driver and an in-transit market load into main's tables (the database tracking
 *     shares with the main backend), under a per-run tenant, so the TripWatcher puts the driver
 *     on an active trip;
 *  2. connects to /driver with a driver-access JWT signed with JWT_SECRET;
 *  3. sends one `loc` every --interval ms along a straight northbound road.
 * With --burst, halfway through that fraction of phones disconnect for 60s and on reconnect flush
 * the fixes they recorded meanwhile as one `loc:batch`.
 *
 * Needs a running service (ROLE=all, or realtime + processor + scheduler) and the same .env.
 * Prints ack latency percentiles, errors and how many acked points reached Postgres, then marks
 * the run's loads delivered and deletes everything it inserted.
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
  const redis = new Redis(process.env.REDIS_URL!);
  const phones: Phone[] = Array.from({ length: PHONES }, () => ({
    driverId: randomUUID(),
    tripId: randomUUID(),
    socket: null,
    step: 0,
    offline: [],
  }));

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  console.log(`Simulator tenant: ${TENANT}`);

  let cleanup: Promise<void> | undefined;
  const finish = () =>
    (cleanup ??= (async () => {
      for (const phone of phones) phone.socket?.disconnect();
      await removeTrips(pg, redis, phones).catch((err) => console.error('Cleanup failed:', err));
      await Promise.all([pg.end(), redis.quit()]);
    })());
  // Ctrl-C / a killed run must not leave in-transit loads behind in main's tables.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log(`\n${signal}: cleaning up …`);
      void finish().then(() => process.exit(130));
    });
  }
  try {
    await run(phones, pg, redis);
  } finally {
    await finish();
  }
}

/**
 * Seeds main's tables for this run's tenant the way the main backend would: one customer,
 * loading point, delivery point and requisition, then one driver and one in-transit market load
 * (plate only, no vehicle row) per phone. The TripWatcher picks the loads up from there.
 */
async function createTrips(pg: Client, redis: Redis, phones: Phone[]) {
  console.log(`Creating ${PHONES} active trips in main's loads table …`);
  const [customerId, loadingPointId, deliveryPointId, requisitionId] = [1, 2, 3, 4].map(() =>
    randomUUID(),
  );
  await pg.query('BEGIN');
  try {
    await seed(pg, phones, { customerId, loadingPointId, deliveryPointId, requisitionId });
    await pg.query('COMMIT');
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }

  // The TripWatcher polls loads in pages, so wait until every driver is on its trip.
  const deadline = Date.now() + 60_000;
  for (const phone of phones) {
    while (!(await redis.get(`trk:drv:${phone.driverId}:active_trip`))) {
      if (Date.now() > deadline) {
        throw new Error('trips were not picked up within 60s — is the scheduler role running?');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function seed(
  pg: Client,
  phones: Phone[],
  ids: {
    customerId: string;
    loadingPointId: string;
    deliveryPointId: string;
    requisitionId: string;
  },
) {
  const { customerId, loadingPointId, deliveryPointId, requisitionId } = ids;
  await pg.query(
    `INSERT INTO customers.customers (id, tenant_id, name, mobile, created_by)
     VALUES ($1, $2, 'Simulator customer', '9000000000', $3)`,
    [customerId, TENANT, randomUUID()],
  );
  await pg.query(
    `INSERT INTO masters.loading_points (id, tenant_id, title, address_line_1, city, state, pin_code, latitude, longitude)
     VALUES ($1, $2, 'Simulator plant', 'Plot 1', 'Nashik', 'MH', '422001', 20, 75)`,
    [loadingPointId, TENANT],
  );
  await pg.query(
    `INSERT INTO customers.customer_delivery_points (id, tenant_id, customer_id, location)
     VALUES ($1, $2, $3, 'Simulator DC')`,
    [deliveryPointId, TENANT, customerId],
  );
  await pg.query(
    `INSERT INTO loads.requisitions (id, tenant_id, code, customer_id, quantity_tonnes, loading_point_id,
       customer_delivery_point_id, expected_delivery_date, pickup_date, customer_po_number)
     VALUES ($1, $2, 'SIM-REQ', $3, 1, $4, $5, current_date + 7, current_date, 'SIM')`,
    [requisitionId, TENANT, customerId, loadingPointId, deliveryPointId],
  );
  const indexes = phones.map((_, i) => String(i).padStart(6, '0'));
  await pg.query(
    `INSERT INTO masters.drivers (id, tenant_id, full_name, phone_number)
     SELECT id, $2, 'Sim driver ' || n, '8' || lpad(n, 9, '0')
     FROM unnest($1::uuid[], $3::text[]) AS d(id, n)`,
    [phones.map((phone) => phone.driverId), TENANT, indexes],
  );
  await pg.query(
    `INSERT INTO loads.loads (id, tenant_id, code, status, source_type, requisition_id, vehicle_number,
       driver_id, planned_capacity_tonnes, loading_confirmed_at, in_transit_at)
     SELECT id, $3, 'SIM-' || n, 'in_transit', 'market', $4, 'SIM' || n, driver_id, 1,
       now() - interval '1 minute', now()
     FROM unnest($1::uuid[], $2::uuid[], $5::text[]) AS l(id, driver_id, n)`,
    [
      phones.map((phone) => phone.tripId),
      phones.map((phone) => phone.driverId),
      TENANT,
      requisitionId,
      indexes,
    ],
  );
}

/** Ends the run's loads (so the TripWatcher releases them) and deletes everything it seeded. */
async function removeTrips(pg: Client, redis: Redis, phones: Phone[]) {
  await pg.query(
    `UPDATE loads.loads SET status = 'delivered', delivered_at = now(), updated_at = clock_timestamp()
     WHERE tenant_id = $1`,
    [TENANT],
  );
  const last = phones[phones.length - 1];
  for (let i = 0; i < 60 && (await redis.get(`trk:drv:${last.driverId}:active_trip`)); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const table of [
    'loads.loads',
    'loads.requisitions',
    'masters.drivers',
    'customers.customer_delivery_points',
    'masters.loading_points',
    'customers.customers',
  ]) {
    await pg.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [TENANT]);
  }
  console.log(`Removed the simulator's rows for tenant ${TENANT} from main's tables.`);
}

async function run(phones: Phone[], pg: Client, redis: Redis) {
  await createTrips(pg, redis, phones);

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

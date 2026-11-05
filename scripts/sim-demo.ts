/**
 * Demo of the whole SIM tracking flow, on a clock that runs faster than real time.
 * Intugine is ALWAYS a fake here: no real call, no SMS, nothing billed, and the INTUGINE_*
 * credentials are never read.
 *
 *   npx tsx scripts/sim-demo.ts [--delay 400] [--fast]      fully in memory (no Postgres, no Redis)
 *   npx tsx scripts/sim-demo.ts --db [--delay 400] [--fast] same, but through your local database
 *   npx tsx scripts/sim-demo.ts --cleanup                   delete what a --db run left behind
 *
 * --db seeds a demo tenant in DATABASE_URL (customer, loading point = Chandigarh Railway Station,
 * delivery point = Kashmere Gate, vehicle, driver with a fake number, requisition, and a load on
 * tracking_source 'sim'), moves the load through its statuses as the story runs, and uses the real
 * repositories: loads are read with MainDataRepository, rows go to tracking.sim_trips and the
 * fixes are inserted into tracking.location_points (source 'sim') with the real PointRepository.
 * It bypasses the Redis stream and the processor, so no geofence or alert rules run on the fixes.
 * The rows are kept after the run so you can query them; --cleanup (or the next --db run) removes them.
 *
 * Route: Chandigarh Railway Station -> Delhi Kashmere Gate ISBT (NH44, about 240 km).
 * It drives the REAL SimConsentService, SimLifecycleService and SimPollJob. Only Intugine (a fake
 * that plays the driver, the operator and the cell towers), the database (MemoryStore), the Redis
 * cursor and the point stream are replaced. Ticks stand for the scheduler leader: the lifecycle
 * every 5 virtual minutes, the poll dispatcher on the same beat, polling every 20.
 *
 * Story: truck assigned -> consent SMS, driver approves later -> billed trip starts -> truck goes
 * to the station, loads, drives to Delhi -> one 429 and a bad row on the way -> delivered -> trip
 * ends. A checklist at the end says what held. Exit code 1 if anything failed.
 *
 * --delay  real ms per virtual tick (default 400, so about 35 s). --fast = no delay.
 */
import 'dotenv/config';
import pino from 'pino';
import { DataSource } from 'typeorm';
import { MainDataRepository } from '../src/modules/main-data';
import { PointRepository } from '../src/modules/points/point.repository';
import type { NormalizedPoint, PointPublisher } from '../src/modules/points';
import type { ActiveTripIndex, TripRef } from '../src/modules/trips';
import type { LoadStatus } from '../src/modules/trips/trip-state';
import { IntugineError, type SimProvider } from '../src/modules/ingest-sim/intugine.client';
import type { SimConsent } from '../src/modules/ingest-sim/intugine.contract';
import { SimConsentService } from '../src/modules/ingest-sim/sim-consent.service';
import {
  SimLifecycleService,
  type SimMainData,
} from '../src/modules/ingest-sim/sim-lifecycle.service';
import { SimPollJob, type SimCursorStore } from '../src/modules/ingest-sim/sim-poll.job';
import { MemoryStore } from '../src/modules/ingest-sim/sim-trip.memory-store';
import {
  SimTripRepository,
  type SimTripRow,
  type SimTripStore,
} from '../src/modules/ingest-sim/sim-trip.repository';

// ---------------------------------------------------------------- settings
const MIN = 60_000;
const TICK_MIN = 5; // scheduler beat
const POLL_INTERVAL_MIN = 20; // INTUGINE_POLL_INTERVAL_MIN
const CONSENT_CHECK_MIN = 60; // INTUGINE_CONSENT_CHECK_MIN
const CONSENT_TTL_MIN = 720; // INTUGINE_CONSENT_TTL_MIN
const PING_EVERY_MIN = 10; // how often the network produces a cell fix
const STATUS_LIMIT = 50;
const SPEED_KMH = 62; // on the polyline (about 55 on the road)
const DRIVER_APPROVES_AT_MIN = 50; // driver calls the number and presses 1
const FAIL_POLL_AT_MIN = 205; // one status call answers 429

const argv = process.argv.slice(2);
const flag = (name: string) => argv.indexOf(`--${name}`);
const DELAY_MS = flag('fast') >= 0 ? 0 : Number(argv[flag('delay') + 1] ?? 400) || 400;

const T0 = Date.parse('2026-11-03T06:00:00Z'); // 11:30 IST
const DB_MODE = flag('db') >= 0 || flag('cleanup') >= 0;
// Fixed ids, so --cleanup (and the next run) can find exactly what this script created.
const LOAD_ID = 'de000000-0000-4000-8000-000000000001';
const TENANT = 'de000000-0000-4000-8000-0000000000aa';
const VEHICLE = 'de000000-0000-4000-8000-000000000002';
const DRIVER_ID = 'de000000-0000-4000-8000-000000000003';
const CUSTOMER_ID = 'de000000-0000-4000-8000-000000000004';
const LOADING_POINT_ID = 'de000000-0000-4000-8000-000000000005';
const DELIVERY_POINT_ID = 'de000000-0000-4000-8000-000000000006';
const REQUISITION_ID = 'de000000-0000-4000-8000-000000000007';
const LOAD_CODE = 'LD-CHD-DEL-0001';
const PLATE = 'HR38AB1234';
const PHONE = '9876543210'; // fake; never sent anywhere

// ---------------------------------------------------------------- route
type Stop = { name: string; lat: number; lng: number };
const ZIRAKPUR: Stop = { name: 'Zirakpur yard', lat: 30.6425, lng: 76.8173 };
const STATION: Stop = { name: 'Chandigarh Railway Station', lat: 30.7061, lng: 76.8206 };
const KASHMERE: Stop = { name: 'Delhi Kashmere Gate ISBT', lat: 28.6676, lng: 77.2284 };
const HIGHWAY: Stop[] = [
  STATION,
  ZIRAKPUR,
  { name: 'Ambala', lat: 30.3782, lng: 76.7767 },
  { name: 'Shahabad', lat: 30.1667, lng: 76.8667 },
  { name: 'Kurukshetra', lat: 29.9695, lng: 76.8783 },
  { name: 'Karnal', lat: 29.6857, lng: 76.9905 },
  { name: 'Panipat', lat: 29.3909, lng: 76.9635 },
  { name: 'Samalkha', lat: 29.2335, lng: 77.014 },
  { name: 'Sonipat', lat: 28.9931, lng: 77.0151 },
  { name: 'Narela', lat: 28.8527, lng: 77.0929 },
  KASHMERE,
];

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const cumulative = HIGHWAY.reduce<number[]>(
  (acc, stop, i) => [...acc, i === 0 ? 0 : acc[i - 1] + km(HIGHWAY[i - 1], stop)],
  [],
);
const ROUTE_KM = cumulative[cumulative.length - 1];

/** Where the truck is after driving `distKm` along the highway from the station. */
function onHighway(distKm: number): { lat: number; lng: number; near: string } {
  const d = Math.min(Math.max(distKm, 0), ROUTE_KM);
  let i = 1;
  while (i < HIGHWAY.length - 1 && cumulative[i] < d) i++;
  const f = (d - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1]);
  const a = HIGHWAY[i - 1];
  const b = HIGHWAY[i];
  const nearest = f < 0.5 ? a : b;
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, near: nearest.name };
}

// ---------------------------------------------------------------- the story, in minutes after t0
const APPROACH_FROM = 60; // driver leaves the yard for the station (load: in_transit_loading)
const AT_STATION = 85; // reached_loading
const LOADED = 110;
const DEPART = 130; // in_transit_unloading
const DRIVE_MIN = Math.ceil((ROUTE_KM / SPEED_KMH) * 60);
const ARRIVE = DEPART + DRIVE_MIN; // reached_unloading
const DELIVERED = ARRIVE + 30;
const END_AT = DELIVERED + 15;

function statusAt(min: number): LoadStatus {
  if (min >= DELIVERED) return 'delivered_ok';
  if (min >= ARRIVE) return 'reached_unloading';
  if (min >= DEPART) return 'in_transit_unloading';
  if (min >= LOADED) return 'loaded';
  if (min >= AT_STATION) return 'reached_loading';
  if (min >= APPROACH_FROM) return 'in_transit_loading';
  return 'truck_assigned';
}

/** True position of the truck, in the physical world. */
function truckAt(min: number): { lat: number; lng: number; near: string; doneKm: number } {
  if (min < APPROACH_FROM) return { ...ZIRAKPUR, near: ZIRAKPUR.name, doneKm: 0 };
  if (min < AT_STATION) {
    const f = (min - APPROACH_FROM) / (AT_STATION - APPROACH_FROM);
    return {
      lat: ZIRAKPUR.lat + (STATION.lat - ZIRAKPUR.lat) * f,
      lng: ZIRAKPUR.lng + (STATION.lng - ZIRAKPUR.lng) * f,
      near: f > 0.5 ? STATION.name : ZIRAKPUR.name,
      doneKm: 0,
    };
  }
  if (min < DEPART) return { ...STATION, near: STATION.name, doneKm: 0 };
  const doneKm = Math.min(((min - DEPART) / 60) * SPEED_KMH, ROUTE_KM);
  return { ...onHighway(doneKm), doneKm };
}

// seeded noise: the same run gives the same "cell tower" scatter every time
let seed = 20261103;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2;

// ---------------------------------------------------------------- fake Intugine
const INTUGINE_TRIP = 'INT-DEMO-7781';
let clockMin = 0; // virtual minutes since t0
const virtualNow = () => new Date(T0 + clockMin * MIN);

const calls = { consent: 0, start: 0, end: 0, status: 0 };
let tripStartedAtMin: number | null = null;
let tripEndedAtMin: number | null = null;
let failedOnce = false;
let junkSent = false;
let consentAllowedSeenAtMin: number | null = null;

const logged: string[] = [];
const IST = (ms: number) => new Date(ms + 330 * MIN).toISOString().slice(11, 16); // HH:MM in IST

const useColor = process.stdout.isTTY;
const paint = (code: number, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint(2, t);
const bold = (t: string) => paint(1, t);
const green = (t: string) => paint(32, t);
const yellow = (t: string) => paint(33, t);
const red = (t: string) => paint(31, t);
const cyan = (t: string) => paint(36, t);

function event(who: string, text: string, color: (t: string) => string = (t) => t) {
  const line = `${bold(IST(virtualNow().getTime()))}  ${cyan(who.padEnd(9))} ${color(text)}`;
  console.log(line);
  logged.push(`${IST(virtualNow().getTime())} ${who} ${text}`);
}

const provider: SimProvider = {
  async checkConsent(): Promise<SimConsent> {
    calls.consent++;
    const approved = clockMin >= DRIVER_APPROVES_AT_MIN;
    if (approved) consentAllowedSeenAtMin ??= clockMin;
    event(
      'INTUGINE',
      approved
        ? 'GET /consents -> ALLOWED (airtel)'
        : 'GET /consents -> PENDING (airtel). SMS sent to the driver: call the number and press 1',
      approved ? green : yellow,
    );
    return {
      status: approved ? 'allowed' : 'pending',
      operator: 'airtel',
      suggestion: approved ? null : 'Call 1800-xxx-xxxx and press 1 to allow tracking',
    };
  },
  async startTrip(input) {
    calls.start++;
    tripStartedAtMin = clockMin;
    event(
      'INTUGINE',
      `POST /trips/start  ${input.srcName} -> ${input.destName}  truck ${input.truckNumber}  ` +
        `invoice ${input.invoice}  => tripId ${INTUGINE_TRIP}  (BILLING STARTS)`,
      green,
    );
    return {
      intugineTripId: INTUGINE_TRIP,
      consent: { status: 'allowed', operator: 'airtel', suggestion: null },
    };
  },
  async endTrip() {
    calls.end++;
    tripEndedAtMin = clockMin;
    event('INTUGINE', `POST /trips/end/${INTUGINE_TRIP}  (BILLING STOPS)`, green);
    return true;
  },
  async setTracking() {},
  async findTripByInvoice() {
    return null;
  },
  async fetchLocations(_tripId, limit) {
    calls.status++;
    if (tripStartedAtMin === null) return [];
    if (clockMin >= FAIL_POLL_AT_MIN && !failedOnce) {
      failedOnce = true;
      event('INTUGINE', 'GET /status -> 429 Too Many Requests', red);
      throw new IntugineError('Too Many Requests', 429);
    }
    // One cell fix every PING_EVERY_MIN since the trip started, newest first.
    const rows: unknown[] = [];
    for (
      let m = Math.floor(clockMin / PING_EVERY_MIN) * PING_EVERY_MIN;
      m >= tripStartedAtMin;
      m -= PING_EVERY_MIN
    ) {
      const p = truckAt(m);
      rows.push({
        _id: `loc-${m}`,
        tripId: INTUGINE_TRIP,
        tel: PHONE,
        // cell-tower accuracy: a few hundred metres of scatter
        loc: [p.lat + rand() * 0.003, p.lng + rand() * 0.003],
        createdAt: new Date(T0 + m * MIN).toISOString(),
        through: 'cell',
        tracking_type: 'SIM',
      });
    }
    if (!junkSent && clockMin >= 150 && rows.length > 2) {
      junkSent = true;
      // An unlocated fix (0,0) and a half-formed row: both must be dropped, not stored.
      rows.unshift({
        _id: 'bad-1',
        tripId: INTUGINE_TRIP,
        loc: [0, 0],
        createdAt: virtualNow().toISOString(),
      });
      rows.unshift({ _id: 'bad-2', tripId: INTUGINE_TRIP, createdAt: 'not-a-date' });
    }
    return rows.slice(0, limit);
  },
};

// ---------------------------------------------------------------- fake main backend / Redis / stream
const trackingSource: string | null = 'sim';
const mainLoad = () =>
  ({
    id: LOAD_ID,
    tenantId: TENANT,
    code: LOAD_CODE,
    status: statusAt(clockMin),
    trackingSource,
    vehicleId: VEHICLE,
    vehicleNumber: PLATE,
    driverId: DRIVER_ID,
    driverNumber: PHONE,
    startedAt: new Date(T0),
  }) as never;

const memoryMainData: SimMainData = {
  loadsByStatus: async (_scope, statuses) => {
    const load = mainLoad() as unknown as { status: LoadStatus };
    return statuses.includes(load.status) ? [mainLoad()] : [];
  },
  load: async () => mainLoad(),
  tripPoints: async () =>
    new Map([
      [
        LOAD_ID,
        {
          vehicleNumber: PLATE,
          pickupLoadingPointId: LOADING_POINT_ID,
          dropCustomerDeliveryPointId: DELIVERY_POINT_ID,
          dropLoadingPointId: null,
        },
      ],
    ]) as never,
  places: async () =>
    new Map([
      [
        LOADING_POINT_ID,
        {
          id: LOADING_POINT_ID,
          kind: 'loading_point',
          name: STATION.name,
          city: 'Chandigarh',
          address: 'Railway Station Rd, Chandigarh',
          lat: STATION.lat,
          lng: STATION.lng,
        },
      ],
      [
        DELIVERY_POINT_ID,
        {
          id: DELIVERY_POINT_ID,
          kind: 'delivery_point',
          name: KASHMERE.name,
          city: 'Delhi',
          address: 'Kashmere Gate ISBT, Delhi',
          lat: KASHMERE.lat,
          lng: KASHMERE.lng,
        },
      ],
    ]) as never,
};

const cursors = new Map<string, number>();
const cursorStore: SimCursorStore = {
  get: async (id) => cursors.get(id) ?? 0,
  set: async (id, ms) => void cursors.set(id, ms),
  delete: async (id) => void cursors.delete(id),
};

const published: NormalizedPoint[] = [];
const publishedWhileApproaching = new Set<NormalizedPoint>();
const publisher = {
  publish: async (points: NormalizedPoint[]) => {
    // Ownership is stamped when a point is polled, so remember what the load was doing then.
    const approaching = ['truck_assigned', 'in_transit_loading'].includes(statusAt(clockMin));
    for (const p of points) if (approaching) publishedWhileApproaching.add(p);
    // --db: the real bulk writer; its ON CONFLICT DO NOTHING is the second duplicate guard.
    if (pointRepository) await pointRepository.insertMany('location_points', points);
    published.push(...points);
  },
} as unknown as PointPublisher;

const activeTrips = {
  getTripRefsForVehicles: async (vehicleIds: string[]) => {
    const status = statusAt(clockMin);
    const live = [
      'truck_assigned',
      'in_transit_loading',
      'reached_loading',
      'loaded',
      'in_transit_unloading',
      'reached_unloading',
    ];
    const refs = new Map<string, TripRef>();
    if (live.includes(status)) {
      // main derives a vehicle's id from its plate, so use the id the poll asks about
      refs.set(vehicleIds[0], {
        tripId: LOAD_ID,
        tenantId: TENANT,
        vehicleId: vehicleIds[0],
        startedAtMs: T0,
        loadStatus: status,
        trackingSource,
      });
    }
    return refs;
  },
} as unknown as ActiveTripIndex;

// ---------------------------------------------------------------- the real services
const logger = pino({ level: 'silent' });
const dataSource = DB_MODE
  ? new DataSource({ type: 'postgres', url: process.env.DATABASE_URL })
  : null;
const pointRepository = dataSource ? new PointRepository(dataSource) : null;
const store: SimTripStore = dataSource ? new SimTripRepository(dataSource) : new MemoryStore();
const realMainData = dataSource ? new MainDataRepository(dataSource) : null;
// Only the demo tenant's loads: other `sim` loads in your database are none of this script's business.
const mainData: SimMainData = realMainData
  ? {
      loadsByStatus: async (scope, statuses, limit) =>
        (await realMainData.loadsByStatus(scope, statuses, limit)).filter(
          (load) => load.tenantId === TENANT,
        ),
      load: (scope, id) => realMainData.load(scope, id),
      tripPoints: (ids) => realMainData.tripPoints(ids),
      places: (loadingPointIds, deliveryPointIds) =>
        realMainData.places(loadingPointIds, deliveryPointIds),
    }
  : memoryMainData;
const consent = new SimConsentService(store, provider, {
  checkIntervalMs: CONSENT_CHECK_MIN * MIN,
  ttlMs: CONSENT_TTL_MIN * MIN,
});
const lifecycle = new SimLifecycleService(mainData, store, provider, consent, cursorStore, logger);
const pollJob = new SimPollJob(provider, store, cursorStore, activeTrips, publisher, {
  limit: STATUS_LIMIT,
});

// ---------------------------------------------------------------- --db: seed, move the load, clean up
async function cleanupDb() {
  const ds = dataSource!;
  // Children first. Everything is keyed by the demo tenant or the fixed load id.
  const steps: [string, string, unknown[]][] = [
    ['tracking.location_points', 'tenant_id = $1', [TENANT]],
    ['tracking.sim_trips', 'tenant_id = $1', [TENANT]],
    ['loads.loads', 'tenant_id = $1', [TENANT]],
    ['loads.requisitions', 'tenant_id = $1', [TENANT]],
    ['masters.vehicles', 'tenant_id = $1', [TENANT]],
    ['masters.drivers', 'id = $1', [DRIVER_ID]],
    ['customers.customer_delivery_points', 'tenant_id = $1', [TENANT]],
    ['masters.loading_points', 'tenant_id = $1', [TENANT]],
    ['customers.customers', 'tenant_id = $1', [TENANT]],
  ];
  for (const [table, where, params] of steps) {
    await ds.query(`DELETE FROM ${table} WHERE ${where}`, params);
  }
}

async function seedDb() {
  const ds = dataSource!;
  await cleanupDb(); // a previous run's rows
  const creator = '00000000-0000-4000-8000-000000000000';
  await ds.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO customers.customers (id, tenant_id, name, mobile, created_by)
       VALUES ($1, $2, 'SIM demo customer', '9000000000', $3)`,
      [CUSTOMER_ID, TENANT, creator],
    );
    await tx.query(
      `INSERT INTO masters.loading_points (id, tenant_id, title, address_line_1, city, state, pin_code, latitude, longitude)
       VALUES ($1, $2, $3, 'Railway Station Rd', 'Chandigarh', 'CH', '160002', $4, $5)`,
      [LOADING_POINT_ID, TENANT, STATION.name, STATION.lat, STATION.lng],
    );
    await tx.query(
      `INSERT INTO customers.customer_delivery_points (id, tenant_id, customer_id, location, city, state, pin_code, latitude, longitude)
       VALUES ($1, $2, $3, $4, 'Delhi', 'DL', '110006', $5, $6)`,
      [DELIVERY_POINT_ID, TENANT, CUSTOMER_ID, KASHMERE.name, KASHMERE.lat, KASHMERE.lng],
    );
    await tx.query(
      `INSERT INTO loads.requisitions (id, tenant_id, code, customer_id, quantity_tonnes, loading_point_id,
         customer_delivery_point_id, expected_delivery_date, pickup_date, customer_po_number)
       VALUES ($1, $2, 'SIM-DEMO-REQ', $3, 1, $4, $5, current_date + 7, current_date, 'SIM-DEMO')`,
      [REQUISITION_ID, TENANT, CUSTOMER_ID, LOADING_POINT_ID, DELIVERY_POINT_ID],
    );
    await tx.query(
      `INSERT INTO masters.vehicles (id, tenant_id, registration_number) VALUES ($1, $2, $3)`,
      [VEHICLE, TENANT, PLATE],
    );
    await tx.query(
      `INSERT INTO masters.drivers (id, full_name, phone_number) VALUES ($1, 'SIM demo driver', $2)`,
      [DRIVER_ID, PHONE],
    );
    await tx.query(
      `INSERT INTO loads.loads (id, tenant_id, code, status, source_type, requisition_id, vehicle_id,
         vehicle_number, driver_id, driver_number, driver_name, planned_capacity_tonnes,
         tracking_source, truck_assigned_at, loading_point_id)
       VALUES ($1, $2, $3, 'truck_assigned', 'market', $4, $5, $6, $7, $8, 'SIM demo driver', 1,
         'sim', $9, $10)`,
      [
        LOAD_ID,
        TENANT,
        LOAD_CODE,
        REQUISITION_ID,
        VEHICLE,
        PLATE,
        DRIVER_ID,
        PHONE,
        new Date(T0).toISOString(),
        LOADING_POINT_ID,
      ],
    );
  });
}

async function setLoadStatus(status: LoadStatus) {
  if (!dataSource) return;
  await dataSource.query(
    `UPDATE loads.loads SET status = $2::loads.loads_status_enum, updated_at = now() WHERE id = $1`,
    [LOAD_ID, status],
  );
}

// ---------------------------------------------------------------- the run
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bar = (done: number) => {
  const width = 24;
  const filled = Math.round((Math.min(done, ROUTE_KM) / ROUTE_KM) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
};

async function main() {
  if (flag('cleanup') >= 0) {
    await dataSource!.initialize().catch(() => undefined);
    return cleanupOnly();
  }
  console.log(bold('\nSIM tracking demo: Chandigarh Railway Station -> Delhi Kashmere Gate ISBT'));
  console.log(
    dim(
      `Route ${ROUTE_KM.toFixed(0)} km, ~${DRIVE_MIN} min driving. Intugine is a fake: nothing is sent or billed.\n`,
    ),
  );
  if (dataSource) {
    await dataSource.initialize();
    await seedDb();
    console.log(
      dim(`Seeded demo tenant ${TENANT} in your database: load ${LOAD_CODE}, truck ${PLATE}.\n`),
    );
  }

  event(
    'MAIN',
    `Truck ${PLATE} assigned to ${LOAD_ID}. No GPS device, driver has no app -> tracking_source = sim`,
    yellow,
  );

  let lastStatus: LoadStatus | null = null;
  for (clockMin = 0; clockMin <= END_AT; clockMin += TICK_MIN) {
    const status = statusAt(clockMin);
    if (status !== lastStatus) {
      event('LOAD', `status -> ${status}`, bold);
      await setLoadStatus(status);
      lastStatus = status;
    }
    const now = virtualNow();

    // Scheduler leader, every tick: consent + trip lifecycle.
    const result = await lifecycle.run(now);
    if (result.consentRequested) event('TRACKING', 'consent requested for the driver number', cyan);
    if (result.started)
      event('TRACKING', 'consent allowed and load tracked -> Intugine trip started', cyan);
    if (result.ended)
      event(
        'TRACKING',
        'load left the tracked statuses -> Intugine trip ended, cursor removed',
        cyan,
      );

    // Poll dispatcher: running trips not polled for POLL_INTERVAL_MIN.
    for (const row of await store.activeDue(now, POLL_INTERVAL_MIN * MIN, 100)) {
      const prior = published.length;
      try {
        const counts = await pollJob.run(
          {
            rowId: row.id,
            intugineTripId: row.intugineTripId!,
            tenantId: row.tenantId,
            vehicleId: row.vehicleId,
            tripId: row.tripId,
            operator: row.operator,
          },
          now.getTime(),
        );
        const fresh = published.slice(prior);
        event(
          'POLL',
          `GET /status -> ${counts.accepted} new fix(es)` +
            (counts.no_fix + counts.invalid
              ? `, dropped ${counts.no_fix} unlocated + ${counts.invalid} malformed`
              : '') +
            (counts.stale ? `, ${counts.stale} already seen` : ''),
          fresh.length ? green : dim,
        );
        for (const p of fresh) {
          const owner = p.tripId
            ? 'trip'
            : (p.flags as Record<string, unknown>)?.geofenceTripId
              ? 'geofence-only'
              : 'vehicle';
          console.log(
            dim(
              `            ${IST(Date.parse(p.recordedAt))}  ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}  cell fix  owner=${owner}`,
            ),
          );
        }
      } catch (err) {
        event(
          'POLL',
          `poll failed (${(err as Error).message}); retried at the next interval, cursor unchanged`,
          red,
        );
      }
    }

    const truck = truckAt(clockMin);
    console.log(
      dim(
        `${IST(now.getTime())}  ${bar(truck.doneKm)} ${truck.doneKm.toFixed(0).padStart(3)}/${ROUTE_KM.toFixed(0)} km  near ${truck.near}  [${status}]`,
      ),
    );
    if (DELAY_MS) await sleep(DELAY_MS);
  }

  return report();
}

async function cleanupOnly() {
  await cleanupDb();
  await dataSource!.destroy();
  console.log(
    "Removed the demo tenant's rows (load, driver, vehicle, sim_trips, location_points).",
  );
  return true;
}

// ---------------------------------------------------------------- the checklist
async function report(): Promise<boolean> {
  const row: Pick<SimTripRow, 'state'> | undefined = dataSource
    ? (
        await dataSource.query(`SELECT state FROM tracking.sim_trips WHERE load_id = $1`, [LOAD_ID])
      )[0]
    : (store as MemoryStore).rows[0];
  const stored = dataSource
    ? Number(
        (
          await dataSource.query(
            `SELECT count(*)::int AS n FROM tracking.location_points
             WHERE tenant_id = $1 AND trip_id = $2 AND source = 'sim'`,
            [TENANT, LOAD_ID],
          )
        )[0].n,
      )
    : null;
  const times = published.map((p) => Date.parse(p.recordedAt));
  const approach = published.filter((p) => publishedWhileApproaching.has(p));
  const driving = published.filter((p) => Date.parse(p.recordedAt) >= T0 + DEPART * MIN);
  const last = published[published.length - 1];
  const lastTruck = truckAt(Math.round((Date.parse(last?.recordedAt ?? '') - T0) / MIN));

  const checks: [string, boolean, string][] = [
    [
      'Consent asked while the load was only assigned',
      calls.consent >= 1 && consentAllowedSeenAtMin !== null,
      `${calls.consent} consent call(s)`,
    ],
    [
      'Driver texted at most once an hour (no SMS storm)',
      calls.consent <= Math.ceil(DRIVER_APPROVES_AT_MIN / CONSENT_CHECK_MIN) + 1,
      `${calls.consent} call(s) in ${DRIVER_APPROVES_AT_MIN + CONSENT_CHECK_MIN} min`,
    ],
    [
      'Trip not started before the driver approved',
      tripStartedAtMin !== null && tripStartedAtMin >= DRIVER_APPROVES_AT_MIN,
      `started at +${tripStartedAtMin} min, approved at +${DRIVER_APPROVES_AT_MIN}`,
    ],
    ['Exactly one billed trip started', calls.start === 1, `${calls.start}`],
    [
      'Exactly one trip ended, after delivery',
      calls.end === 1 && tripEndedAtMin !== null && tripEndedAtMin >= DELIVERED,
      `ended at +${tripEndedAtMin} min, delivered at +${DELIVERED}`,
    ],
    ['Row finished as ended', row?.state === 'ended', `state ${row?.state}`],
    [
      'Poll cursor removed when the trip ended',
      !cursors.has(INTUGINE_TRIP),
      `${cursors.size} left`,
    ],
    ['Fixes were stored', published.length > 0, `${published.length} fixes`],
    ['No duplicate or out-of-order fixes', times.every((t, i) => i === 0 || t > times[i - 1]), ''],
    [
      'No unlocated (0,0) or malformed rows stored',
      published.every((p) => p.lat !== 0 || p.lng !== 0),
      '',
    ],
    [
      'A 429 was survived with no gap in the data',
      failedOnce && published.length > 0,
      'later poll caught up',
    ],
    [
      'Fixes polled before loading belong to the trip (tracking runs from assignment)',
      approach.length > 0 && approach.every((p) => p.tripId === LOAD_ID),
      `${approach.length} fixes`,
    ],
    [
      'Fixes after leaving the station belong to the trip',
      driving.length > 0 && driving.every((p) => p.tripId === LOAD_ID),
      `${driving.length} fixes`,
    ],
    [
      'Every fix is a low-accuracy cell fix with no speed/heading',
      published.every(
        (p) =>
          p.source === 'sim' &&
          p.speedKmh === null &&
          p.heading === null &&
          (p.flags as Record<string, unknown>).lowAccuracy === true,
      ),
      '',
    ],
    [
      'tracking_source was never changed by this service',
      trackingSource === 'sim',
      trackingSource ?? 'null',
    ],
  ];
  if (stored !== null) {
    checks.push([
      'Every fix is in tracking.location_points (source sim, tagged with the load)',
      stored === published.length,
      `${stored} rows in the table, ${published.length} published`,
    ]);
  }
  console.log(bold('\nChecklist'));
  for (const [name, ok, note] of checks) {
    console.log(`  ${ok ? green('PASS') : red('FAIL')}  ${name}${note ? dim(`  (${note})`) : ''}`);
  }
  console.log(
    dim(
      `\n${published.length} fixes stored; last fix ${IST(Date.parse(last?.recordedAt ?? ''))} at ${last?.lat.toFixed(4)}, ${last?.lng.toFixed(4)} ` +
        `(truck was ${lastTruck.near}). Intugine calls: consent ${calls.consent}, start ${calls.start}, status ${calls.status}, end ${calls.end}.`,
    ),
  );
  if (dataSource) {
    console.log(
      dim(
        `\nLook at them:\n  SELECT recorded_at, lat, lng, flags FROM tracking.location_points\n  WHERE tenant_id = '${TENANT}' AND source = 'sim' ORDER BY recorded_at;\n` +
          `  SELECT state, intugine_trip_id, started_at, ended_at, end_reason FROM tracking.sim_trips WHERE load_id = '${LOAD_ID}';\n` +
          `Remove them: npx tsx scripts/sim-demo.ts --cleanup`,
      ),
    );
  }
  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? green(bold('\nAll checks passed.')) : red(bold('\nSome checks FAILED.')));
  return ok;
}

main()
  .then(async (ok) => {
    await dataSource?.destroy().catch(() => undefined);
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

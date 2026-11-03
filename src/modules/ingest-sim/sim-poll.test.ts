import type { JobsOptions } from 'bullmq';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedPoint, PointPublisher } from '../points';
import type { ActiveTripIndex, TripRef } from '../trips';
import { SimPollDispatcher } from './sim-poll.dispatcher';
import { ownerFor, SimPollJob, type SimCursorStore, type SimPollJobData } from './sim-poll.job';
import { MemoryStore } from './sim-trip.memory-store';

const MIN = 60_000;
const T0 = Date.parse('2026-10-29T08:00:00Z');
const logger = pino({ level: 'silent' });

const data: SimPollJobData = {
  rowId: 'row-1',
  intugineTripId: 'INT-1',
  tenantId: 'ten',
  vehicleId: 'veh-1',
  tripId: 'load-1',
  operator: 'airtel',
};

const trip = (over: Partial<TripRef> = {}): TripRef => ({
  tripId: 'load-1',
  tenantId: 'ten',
  vehicleId: 'veh-1',
  startedAtMs: T0,
  loadStatus: 'in_transit_unloading',
  trackingSource: 'sim',
  ...over,
});

const location = (minutes: number, over: Record<string, unknown> = {}) => ({
  _id: `loc-${minutes}`,
  tripId: 'INT-1',
  loc: [18.78 + minutes / 1000, 74.27],
  createdAt: new Date(T0 + minutes * MIN).toISOString(),
  through: 'cell',
  ...over,
});

function setup(opts: { trip?: TripRef | undefined; rows?: unknown[] } = {}) {
  const store = new MemoryStore();
  const cursors = new Map<string, number>();
  const cursorStore: SimCursorStore = {
    get: async (id) => cursors.get(id) ?? 0,
    set: async (id, ms) => void cursors.set(id, ms),
    delete: async (id) => void cursors.delete(id),
  };
  const published: NormalizedPoint[] = [];
  const publisher = {
    publish: async (points: NormalizedPoint[]) => void published.push(...points),
  } as unknown as PointPublisher;
  const activeTrips = {
    getTripRefsForVehicles: async () =>
      new Map(opts.trip === undefined && 'trip' in opts ? [] : [['veh-1', opts.trip ?? trip()]]),
  } as unknown as ActiveTripIndex;
  const provider = { fetchLocations: vi.fn(async () => opts.rows ?? []) };
  const job = new SimPollJob(provider, store, cursorStore, activeTrips, publisher, { limit: 50 });
  return { job, store, cursors, published, provider };
}

describe('SimPollJob', () => {
  it('publishes new locations oldest first, stamped with the load, and moves the cursor', async () => {
    const { job, store, cursors, published, provider } = setup({
      rows: [location(30), location(10), location(20)], // Intugine returns newest first
    });
    const result = await job.run(data, T0 + 40 * MIN);
    expect(provider.fetchLocations).toHaveBeenCalledWith('INT-1', 50);
    expect(result.accepted).toBe(3);
    expect(published.map((p) => p.recordedAt)).toEqual(
      [10, 20, 30].map((m) => new Date(T0 + m * MIN).toISOString()),
    );
    expect(published[0]).toMatchObject({
      source: 'sim',
      sourceRef: 'INT-1',
      tripId: 'load-1',
      tenantId: 'ten',
      vehicleId: 'veh-1',
      speedKmh: null,
      flags: { lowAccuracy: true, through: 'cell', operator: 'airtel' },
    });
    expect(cursors.get('INT-1')).toBe(T0 + 30 * MIN);
    expect(store.polled.get('row-1')).toMatchObject({
      lastPointAt: new Date(T0 + 30 * MIN),
    });
    expect(store.polled.get('row-1')?.error).toBeUndefined();
  });

  it('does not publish a location twice', async () => {
    const { job, published } = setup({ rows: [location(10), location(20)] });
    await job.run(data, T0 + 30 * MIN);
    const second = await job.run(data, T0 + 50 * MIN);
    expect(second).toMatchObject({ accepted: 0, stale: 2 });
    expect(published).toHaveLength(2);
  });

  it('returns nothing before consent is approved and just stamps the poll', async () => {
    const { job, store, published } = setup({ rows: [] });
    const result = await job.run(data, T0);
    expect(result).toEqual({ accepted: 0, stale: 0, no_fix: 0, invalid: 0 });
    expect(published).toHaveLength(0);
    expect(store.polled.get('row-1')).toMatchObject({ at: new Date(T0) });
    expect(store.polled.get('row-1')?.lastPointAt).toBeUndefined();
  });

  it('skips malformed rows and unlocated positions without losing the rest', async () => {
    const { job, published } = setup({
      rows: [
        location(10),
        { loc: [1] },
        location(15, { loc: [0, 0] }),
        location(20, { createdAt: 'nope' }),
      ],
    });
    const result = await job.run(data, T0 + 30 * MIN);
    expect(result).toMatchObject({ accepted: 1, invalid: 1, no_fix: 2 });
    expect(published).toHaveLength(1);
  });

  it('keeps the cursor and records the error when the call fails, and still stamps the poll', async () => {
    const { job, store, provider, cursors } = setup();
    provider.fetchLocations.mockRejectedValue(new Error('Intugine 503'));
    await expect(job.run(data, T0)).rejects.toThrow('503');
    expect(cursors.size).toBe(0);
    expect(store.polled.get('row-1')).toMatchObject({ error: 'Intugine 503' });
  });

  it('leaves the cursor alone when publishing fails, so the next poll retries', async () => {
    const { cursors, store } = setup();
    const failing = new SimPollJob(
      { fetchLocations: async () => [location(10)] },
      store,
      {
        get: async () => 0,
        set: async (id, ms) => void cursors.set(id, ms),
        delete: async () => {},
      },
      { getTripRefsForVehicles: async () => new Map() } as unknown as ActiveTripIndex,
      {
        publish: async () => {
          throw new Error('redis down');
        },
      } as unknown as PointPublisher,
      { limit: 50 },
    );
    await expect(failing.run(data, T0 + 20 * MIN)).rejects.toThrow('redis down');
    expect(cursors.size).toBe(0);
  });

  it('publishes a plain vehicle point when the load is no longer on SIM', async () => {
    const { job, published } = setup({
      rows: [location(10)],
      trip: trip({ trackingSource: 'gps' }),
    });
    await job.run(data, T0 + 20 * MIN);
    expect(published[0].tripId).toBeNull();
  });
});

describe('ownerFor', () => {
  const owner = (t: TripRef | undefined, ms = T0 + 10 * MIN) => ownerFor(data, t, ms);

  it('owns the point only for the load the Intugine trip was started for', () => {
    expect(owner(trip()).tripId).toBe('load-1');
    expect(owner(trip({ tripId: 'other-load' })).tripId).toBeNull();
    expect(owner(trip({ tenantId: 'other-tenant' })).tripId).toBeNull();
    expect(owner(undefined).tripId).toBeNull();
  });

  it('ignores points recorded well before tracking started', () => {
    expect(owner(trip(), T0 - 11 * MIN).tripId).toBeNull();
    expect(owner(trip(), T0 - 5 * MIN).tripId).toBe('load-1');
  });

  it('joins the trip from truck assignment (the drive to the plant is tracked)', () => {
    const result = owner(trip({ loadStatus: 'truck_assigned' }));
    expect(result.tripId).toBe('load-1');
    expect(result.geofenceTripId).toBeUndefined();
  });

  it('flags a fix after delivery instead of joining the trip', () => {
    const result = owner(trip({ loadStatus: 'delivered_ok' }));
    expect(result.tripId).toBeNull();
    expect(result.geofenceTripId).toBe('load-1');
  });
});

describe('SimPollDispatcher', () => {
  async function dispatch(setupRows: (store: MemoryStore) => Promise<void>, now = T0 + 30 * MIN) {
    const store = new MemoryStore();
    await setupRows(store);
    const jobs: Array<{ data: SimPollJobData; options?: JobsOptions }> = [];
    const queue = {
      enqueue: async (_name: string, payload: unknown, options?: JobsOptions) =>
        void jobs.push({ data: payload as SimPollJobData, options }),
    };
    const dispatcher = new SimPollDispatcher(store, queue, { pollIntervalMs: 20 * MIN }, logger);
    const count = await dispatcher.dispatch(new Date(now));
    return { count, jobs, store };
  }

  const addActive = async (store: MemoryStore, tripId: string, intugineTripId: string) => {
    const row = (await store.insert({
      tenantId: 'ten',
      tripId,
      vehicleId: `veh-${tripId}`,
      driverId: null,
      phone: `98765432${tripId.length}${intugineTripId.length}`,
    }))!;
    row.state = 'active';
    row.intugineTripId = intugineTripId;
    return row;
  };

  it('enqueues one job per running trip with a fixed id, spread over the tick', async () => {
    const { count, jobs } = await dispatch(async (store) => {
      await addActive(store, 'a', 'INT-A');
      await addActive(store, 'bb', 'INT-B');
    });
    expect(count).toBe(2);
    expect(jobs.map((j) => j.options?.jobId)).toEqual(['sim-INT-A', 'sim-INT-B']);
    expect(jobs.map((j) => j.options?.delay)).toEqual([0, 1000]);
    expect(jobs[0].data).toEqual({
      rowId: 'row-1',
      intugineTripId: 'INT-A',
      tenantId: 'ten',
      vehicleId: 'veh-a',
      tripId: 'a',
      operator: null,
    });
    expect(jobs[0].options).toMatchObject({ attempts: 1, removeOnComplete: true });
  });

  it('skips trips polled within the interval, and trips that are not running', async () => {
    const { count, jobs } = await dispatch(async (store) => {
      const recent = await addActive(store, 'a', 'INT-A');
      const old = await addActive(store, 'bb', 'INT-B');
      await addActive(store, 'ccc', 'INT-C'); // never polled
      store.polled.set(recent.id, { at: new Date(T0 + 20 * MIN) }); // 10 min ago
      store.polled.set(old.id, { at: new Date(T0 + 5 * MIN) }); // 25 min ago
      const waiting = (await store.insert({
        tenantId: 'ten',
        tripId: 'd',
        vehicleId: 'v',
        driverId: null,
        phone: '9000000000',
      }))!;
      waiting.state = 'consented';
    });
    expect(count).toBe(2);
    expect(jobs.map((j) => j.options?.jobId).sort()).toEqual(['sim-INT-B', 'sim-INT-C']);
  });
});

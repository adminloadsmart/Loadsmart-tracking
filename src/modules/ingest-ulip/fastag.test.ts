import type { JobsOptions } from 'bullmq';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { MainLoad } from '../main-data';
import type { LoadStatus } from '../trips/trip-state';
import { FastagLifecycleService } from './fastag-lifecycle.service';
import { FastagPollDispatcher } from './fastag-poll.dispatcher';
import { FastagPollJob, type FastagPollJobData } from './fastag-poll.job';
import { MemoryFastagStore } from './fastag-trip.memory-store';
import { UlipError } from './ulip.client';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-28T00:00:00Z');
const logger = pino({ level: 'silent' });

function load(over: Partial<MainLoad> = {}): MainLoad {
  return {
    id: 'load-1',
    tenantId: 'ten',
    vehicleId: 'veh-1',
    vehicleNumber: 'HR84A4138',
    status: 'in_transit_unloading' as LoadStatus,
    startedAt: new Date(T0),
    endedAt: null,
    ...over,
  } as MainLoad;
}

function lifecycle(loads: MainLoad[], store = new MemoryFastagStore()) {
  const mainData = {
    loadsByStatus: vi.fn(async (_s: unknown, statuses: readonly LoadStatus[]) =>
      loads.filter((l) => statuses.includes(l.status)),
    ),
    load: vi.fn(async (_s: unknown, id: string) => loads.find((l) => l.id === id) ?? null),
  };
  return { service: new FastagLifecycleService(mainData, store, logger), store, mainData };
}

describe('FastagLifecycleService', () => {
  it('opens a row from the assignment time for a tracked load with a truck', async () => {
    const { service, store } = lifecycle([
      load({ status: 'truck_assigned' as LoadStatus }),
      load({ id: 'no-truck', vehicleNumber: null, vehicleId: null }),
      load({ id: 'created', status: 'created' as LoadStatus }),
    ]);
    const result = await service.run(new Date(T0 + HOUR));
    expect(result).toMatchObject({ started: 1, closed: 0 });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      loadId: 'load-1',
      vehicleNumber: 'HR84A4138',
      state: 'active',
      windowStart: new Date(T0),
    });
  });

  it('follows the load whatever its tracking source, and does not duplicate the row', async () => {
    const { service, store } = lifecycle([load({ trackingSource: 'gps' } as Partial<MainLoad>)]);
    await service.run(new Date(T0));
    await service.run(new Date(T0 + 5 * MIN));
    expect(store.rows).toHaveLength(1);
  });

  it('closes the row at the delivery time once the load leaves the tracked statuses', async () => {
    const loads = [load()];
    const { service, store } = lifecycle(loads);
    await service.run(new Date(T0));
    loads[0] = load({
      status: 'delivered_ok' as LoadStatus,
      endedAt: new Date(T0 + 20 * HOUR),
    });
    const result = await service.run(new Date(T0 + 22 * HOUR));
    expect(result.closed).toBe(1);
    expect(store.rows[0]).toMatchObject({
      state: 'closing',
      windowEnd: new Date(T0 + 20 * HOUR),
    });
  });

  it('closes at now when the load has gone from main', async () => {
    const loads = [load()];
    const { service, store } = lifecycle(loads);
    await service.run(new Date(T0));
    loads.length = 0;
    await service.run(new Date(T0 + HOUR));
    expect(store.rows[0]).toMatchObject({ state: 'closing', windowEnd: new Date(T0 + HOUR) });
  });

  it('starts a new window for a replaced truck and closes the old truck’s', async () => {
    const loads = [load()];
    const { service, store } = lifecycle(loads);
    await service.run(new Date(T0));
    loads[0] = load({ vehicleNumber: 'DL1AB1234', vehicleId: 'veh-2' });
    const now = new Date(T0 + 3 * HOUR);
    await service.run(now);
    expect(store.rows.map((r) => [r.vehicleNumber, r.state])).toEqual([
      ['HR84A4138', 'closing'],
      ['DL1AB1234', 'active'],
    ]);
    expect(store.rows[0].windowEnd).toEqual(now);
    expect(store.rows[1].windowStart).toEqual(now);
  });

  it('skips a failing load without stopping the rest', async () => {
    const store = new MemoryFastagStore();
    const insert = store.insert.bind(store);
    store.insert = vi.fn(async (input) => {
      if (input.loadId === 'bad') throw new Error('db down');
      return insert(input);
    });
    const { service } = lifecycle([load({ id: 'bad' }), load({ id: 'good' })], store);
    expect(await service.run(new Date(T0))).toMatchObject({ started: 1, skipped: 1 });
  });
});

const txn = (hoursAfterT0: number, seqNo: string, over: Record<string, unknown> = {}) => ({
  // India time, so subtract the offset to line it up with T0 (UTC).
  readerReadTime: new Date(T0 + hoursAfterT0 * HOUR + 330 * MIN)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', ''),
  seqNo,
  laneDirection: 'S',
  tollPlazaGeocode: '29.07,77.06',
  tollPlazaName: `Plaza ${seqNo}`,
  vehicleType: 'VC5',
  vehicleRegNo: 'HR84A4138',
  ...over,
});

const jobData = (over: Partial<FastagPollJobData> = {}): FastagPollJobData => ({
  rowId: 'row-1',
  tenantId: 'ten',
  loadId: 'load-1',
  vehicleId: 'veh-1',
  vehicleNumber: 'HR84A4138',
  windowStart: new Date(T0).toISOString(),
  windowEnd: null,
  attempts: 0,
  ...over,
});

async function pollSetup(
  rows: unknown[] | Error,
  data = jobData(),
  state: 'active' | 'closing' = 'active',
) {
  const store = new MemoryFastagStore();
  await store.insert({
    tenantId: 'ten',
    loadId: 'load-1',
    vehicleId: 'veh-1',
    vehicleNumber: 'HR84A4138',
    windowStart: new Date(T0),
  });
  if (state === 'closing') await store.markClosing('row-1', new Date(data.windowEnd!));
  const provider = {
    fetchCrossings: vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  };
  return { store, provider, job: new FastagPollJob(provider, store, store), data };
}

describe('FastagPollJob', () => {
  it('stores the crossings inside the window and drops the rest', async () => {
    const { job, store, provider, data } = await pollSetup([
      txn(-30, 'before'), // an earlier trip of the same truck
      txn(1, 'a'),
      txn(5, 'b'),
      txn(2, 'c', { tollPlazaGeocode: 'garbage' }),
      { readerReadTime: 'bad', seqNo: 'x' },
    ]);
    const result = await job.run(data, T0 + 10 * HOUR);
    expect(provider.fetchCrossings).toHaveBeenCalledWith('HR84A4138');
    expect(result).toEqual({
      received: 5,
      stored: 3,
      known: 0,
      outsideWindow: 1,
      invalid: 1,
    });
    // oldest first, location kept null when unusable
    expect(store.crossings.map((c) => c.seqNo)).toEqual(['a', 'c', 'b']);
    expect(store.crossings[1].crossing).toMatchObject({ lat: null, lng: null });
    expect(store.rows[0].lastPolledAt).toEqual(new Date(T0 + 10 * HOUR));
  });

  it('does not store a crossing twice when ULIP repeats it', async () => {
    const rows = [txn(1, 'a'), txn(1, 'a'), txn(2, 'b')];
    const { job, store, data } = await pollSetup(rows);
    expect((await job.run(data, T0 + 5 * HOUR)).stored).toBe(2);
    const again = await job.run(data, T0 + 6 * HOUR);
    expect(again).toMatchObject({ stored: 0, known: 2 });
    expect(store.crossings).toHaveLength(2);
  });

  it('keeps only crossings up to the window end, and finishes a closing load', async () => {
    const end = new Date(T0 + 4 * HOUR).toISOString();
    const { job, store, data } = await pollSetup(
      [txn(1, 'a'), txn(3, 'b'), txn(6, 'after-delivery')],
      jobData({ windowEnd: end }),
      'closing',
    );
    const result = await job.run(data, T0 + 6 * HOUR);
    expect(result).toMatchObject({ stored: 2, outsideWindow: 1 });
    expect(store.rows[0].state).toBe('ended');
  });

  it('records a failed poll, rethrows, and leaves an active load active', async () => {
    const { job, store, data } = await pollSetup(new UlipError('ULIP 500', 500));
    await expect(job.run(data, T0 + HOUR)).rejects.toThrow('ULIP 500');
    expect(store.rows[0]).toMatchObject({
      state: 'active',
      attempts: 1,
      lastError: 'ULIP 500',
      lastPolledAt: new Date(T0 + HOUR),
    });
  });

  it('gives up on a finished load after too many failed polls, but not before', async () => {
    const end = new Date(T0 + 4 * HOUR).toISOString();
    const make = (attempts: number) =>
      pollSetup(new UlipError('ULIP 500', 500), jobData({ windowEnd: end, attempts }), 'closing');
    const early = await make(3);
    await expect(early.job.run(early.data)).rejects.toThrow();
    expect(early.store.rows[0].state).toBe('closing');
    const last = await make(9);
    await expect(last.job.run(last.data)).rejects.toThrow();
    expect(last.store.rows[0].state).toBe('ended');
  });
});

describe('FastagPollDispatcher', () => {
  function setup(store: MemoryFastagStore) {
    const added: Array<{ data: FastagPollJobData; opts: JobsOptions }> = [];
    const queue = {
      enqueue: vi.fn(async (_name: string, data: FastagPollJobData, opts: JobsOptions) => {
        added.push({ data, opts });
      }),
    };
    const dispatcher = new FastagPollDispatcher(
      store,
      queue as never,
      { pollIntervalMs: 15 * MIN, finalDelayMs: 30 * MIN },
      logger,
    );
    return { dispatcher, added };
  }
  const open = async (store: MemoryFastagStore, loadId: string) =>
    store.insert({
      tenantId: 'ten',
      loadId,
      vehicleId: `v-${loadId}`,
      vehicleNumber: `N-${loadId}`,
      windowStart: new Date(T0),
    });

  it('polls a new load at once and again only after the interval', async () => {
    const store = new MemoryFastagStore();
    await open(store, 'l1');
    const { dispatcher, added } = setup(store);
    expect(await dispatcher.dispatch(new Date(T0))).toBe(1);
    expect(added[0]).toMatchObject({
      data: { rowId: 'row-1', loadId: 'l1', vehicleNumber: 'N-l1', windowEnd: null },
      opts: { jobId: 'ulip-row-1', attempts: 1, delay: 0 },
    });

    await store.markPolled('row-1', new Date(T0), {});
    expect(await dispatcher.dispatch(new Date(T0 + 10 * MIN))).toBe(0);
    expect(await dispatcher.dispatch(new Date(T0 + 15 * MIN))).toBe(1);
  });

  it('spaces the calls of one tick', async () => {
    const store = new MemoryFastagStore();
    for (const id of ['a', 'b', 'c']) await open(store, id);
    const { dispatcher, added } = setup(store);
    await dispatcher.dispatch(new Date(T0));
    expect(added.map((a) => a.opts.delay)).toEqual([0, 1000, 2000]);
  });

  it('polls a finished load once, after the final delay, with its window end', async () => {
    const store = new MemoryFastagStore();
    await open(store, 'l1');
    await store.markPolled('row-1', new Date(T0 + 59 * MIN), {}); // last normal poll
    await store.markClosing('row-1', new Date(T0 + HOUR), 'load_ended');
    const { dispatcher, added } = setup(store);

    // Too early: the delay after the end has not passed (and the poll before it doesn't count).
    expect(await dispatcher.dispatch(new Date(T0 + HOUR + 20 * MIN))).toBe(0);
    expect(await dispatcher.dispatch(new Date(T0 + HOUR + 30 * MIN))).toBe(1);
    expect(added[0].data.windowEnd).toBe(new Date(T0 + HOUR).toISOString());

    // Once that poll succeeds the row is ended and never dispatched again.
    await store.markPolled('row-1', new Date(T0 + HOUR + 31 * MIN), { finish: 'done' });
    expect(await dispatcher.dispatch(new Date(T0 + 5 * HOUR))).toBe(0);
  });

  it('retries a failed final poll only after the interval', async () => {
    const store = new MemoryFastagStore();
    await open(store, 'l1');
    await store.markClosing('row-1', new Date(T0), 'load_ended');
    const failedAt = new Date(T0 + 31 * MIN);
    await store.markPolled('row-1', failedAt, { error: 'boom' });
    const { dispatcher } = setup(store);
    expect(await dispatcher.dispatch(new Date(failedAt.getTime() + 5 * MIN))).toBe(0);
    expect(await dispatcher.dispatch(new Date(failedAt.getTime() + 15 * MIN))).toBe(1);
  });
});

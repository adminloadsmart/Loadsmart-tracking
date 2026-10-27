import type { JobsOptions } from 'bullmq';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { MainDataRepository, MainGpsDeviceBinding } from '../main-data';
import type { ActiveTripIndex, OnTripDevice } from '../trips';
import { chunk, MAX_IMEIS_PER_CALL, RoadcastDispatcher } from './roadcast-dispatcher';
import type { RoadcastPollJobData } from './roadcast-poll.job';

const logger = pino({ level: 'silent' });
const TICK_MS = 10_000;
const IDLE_MS = 5 * 60_000;
const SLOTS = IDLE_MS / TICK_MS;

function device(i: number, tenantId: string): MainGpsDeviceBinding {
  return { imei: String(866221070400000 + i), vehicleId: `v-${i}`, tenantId };
}

/** Each org's sweep slot in the fake: its position in `orgSlots`. */
function setup(bindings: MainGpsDeviceBinding[], orgSlots: Record<string, number>) {
  const onTrip: OnTripDevice[] = [];
  const sweepCalls: number[] = [];
  let sweepFails = false;
  const mainData = {
    gpsDeviceBindings: async ({ slot, slots }: { slot: number; slots: number }) => {
      expect(slots).toBe(SLOTS);
      sweepCalls.push(slot);
      if (sweepFails) throw new Error('db down');
      return bindings.filter((b) => orgSlots[b.tenantId] === slot);
    },
  } as unknown as MainDataRepository;
  const activeTrips = {
    onTripDevicesByTenant: async () => {
      const byTenant = new Map<string, OnTripDevice[]>();
      for (const d of onTrip) byTenant.set(d.tenantId, [...(byTenant.get(d.tenantId) ?? []), d]);
      return byTenant;
    },
  } as unknown as ActiveTripIndex;
  let jobs: Array<{ data: RoadcastPollJobData; options?: JobsOptions }> = [];
  const queue = {
    enqueue: async (_name: string, data: unknown, options?: JobsOptions) => {
      jobs.push({ data: data as RoadcastPollJobData, options });
    },
  };
  const dispatcher = new RoadcastDispatcher(
    mainData,
    activeTrips,
    queue,
    { intervalMs: TICK_MS, idleIntervalMs: IDLE_MS },
    logger,
  );
  async function tick() {
    jobs = [];
    await dispatcher.dispatch();
    return jobs;
  }
  return { tick, onTrip, sweepCalls, failSweep: () => (sweepFails = true) };
}

const vehiclesOf = (job: { data: RoadcastPollJobData }) =>
  job.data.devices.map((d) => d.vehicleId).sort();

describe('RoadcastDispatcher', () => {
  it('calls an org with trucks on a trip every tick, with only those IMEIs', async () => {
    const a = [device(1, 'org-a'), device(2, 'org-a')];
    const { tick, onTrip } = setup([...a, device(3, 'org-b')], { 'org-a': 7, 'org-b': 9 });
    onTrip.push(a[1]);

    const jobs = await tick(); // slot 0: nobody's sweep
    expect(jobs.map(vehiclesOf)).toEqual([['v-2']]);
    expect(jobs[0].options?.jobId).toBe('roadcast-org-a-0');
  });

  it("sweeps each org with all its IMEIs exactly once per idle interval, on the org's own tick", async () => {
    const bindings = [device(1, 'org-a'), device(2, 'org-a'), device(3, 'org-b')];
    const { tick, onTrip, sweepCalls } = setup(bindings, { 'org-a': 3, 'org-b': 20 });
    onTrip.push(bindings[1]); // org-a's v-2 is on a trip

    const perTick: string[][][] = [];
    for (let i = 0; i < SLOTS * 2; i++) perTick.push((await tick()).map(vehiclesOf));

    // The sweep read visits every slot in turn — 1/30 of orgs per tick.
    expect(sweepCalls.slice(0, SLOTS)).toEqual([...Array(SLOTS).keys()]);
    // org-a: v-2 every tick; on its slot (3, 33), all of its trucks in that same single call.
    expect(perTick[3]).toEqual([['v-1', 'v-2']]);
    expect(perTick[33]).toEqual([['v-1', 'v-2']]);
    expect(perTick[4]).toEqual([['v-2']]);
    // org-b has nothing on a trip: called only on its slot.
    expect(perTick[20]).toEqual([['v-2'], ['v-3']]);
    const orgBCalls = perTick.filter((jobs) => jobs.some((ids) => ids.includes('v-3')));
    expect(orgBCalls).toHaveLength(2);
  });

  it('keeps polling on-trip trucks when the sweep read fails', async () => {
    const bindings = [device(1, 'org-a')];
    const { tick, onTrip, failSweep } = setup(bindings, { 'org-a': 0 });
    onTrip.push(bindings[0]);
    failSweep();
    expect((await tick()).map(vehiclesOf)).toEqual([['v-1']]);
  });

  it('spreads the calls across the tick instead of bursting', async () => {
    const orgs = ['org-a', 'org-b', 'org-c', 'org-d'];
    const { tick, onTrip } = setup([], {});
    orgs.forEach((org, i) => onTrip.push(device(i, org)));
    const jobs = await tick();
    expect(jobs.map((j) => j.options?.delay)).toEqual([0, 2500, 5000, 7500]);
    expect(jobs[0].options).toMatchObject({ attempts: 1, removeOnFail: true });
  });

  it('splits an org with more IMEIs than one call takes', async () => {
    const { tick, onTrip } = setup([], {});
    for (let i = 0; i < MAX_IMEIS_PER_CALL + 5; i++) onTrip.push(device(i, 'org-a'));
    const jobs = await tick();
    expect(jobs.map((j) => j.data.devices.length)).toEqual([MAX_IMEIS_PER_CALL, 5]);
    expect(jobs.map((j) => j.options?.jobId)).toEqual(['roadcast-org-a-0', 'roadcast-org-a-1']);
  });

  it('makes no call when nothing is on a trip and no org is due a sweep', async () => {
    const { tick } = setup([device(1, 'org-a')], { 'org-a': 5 });
    expect(await tick()).toEqual([]);
  });

  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

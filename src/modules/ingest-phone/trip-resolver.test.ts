import { describe, expect, it } from 'vitest';
import type { ActiveTripIndex, TripRef } from '../trips';
import { toNormalizedPoint } from './driver-point.contract';
import { Limiter, LimiterBusyError } from '../../shared/utils/concurrency';
import { TripResolver } from './trip-resolver';
import type { TripRepository } from './trip.repository';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ref = (loadStatus: string): TripRef => ({
  tripId: 'trip-1',
  tenantId: TENANT,
  vehicleId: 'veh-1',
  startedAtMs: null,
  loadStatus,
  trackingSource: null,
  postingType: null,
});
const resolverFor = (trip: TripRef) =>
  new TripResolver(
    { getTripRefForDriver: async () => trip } as unknown as ActiveTripIndex,
    {} as TripRepository,
  );

describe('TripResolver', () => {
  const now = Date.now();
  const recordedAt = new Date(now).toISOString();

  it('stamps the trip on a tracked load', async () => {
    const [trip] = await resolverFor(ref('in_transit_unloading')).resolve(
      'd1',
      [TENANT],
      [recordedAt],
      now,
    );
    expect(trip).toEqual({ tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' });
  });

  it('stamps the trip on an assigned load, from the approach to the plant', async () => {
    const [trip] = await resolverFor(ref('truck_assigned')).resolve(
      'd1',
      [TENANT],
      [recordedAt],
      now,
    );
    expect(trip).toEqual({ tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' });
    const point = toNormalizedPoint(
      { lat: 30.9, lng: 75.85, recordedAt } as Parameters<typeof toNormalizedPoint>[0],
      { ...trip!, driverId: 'd1' },
      recordedAt,
    );
    expect(point.tripId).toBe('trip-1');
  });

  it('keeps a delivered load off the trip, while it leaves the delivery point', async () => {
    for (const status of ['delivered_ok', 'closed']) {
      const [trip] = await resolverFor(ref(status)).resolve('d1', [TENANT], [recordedAt], now);
      expect(trip).toEqual({
        tripId: null,
        tenantId: TENANT,
        vehicleId: 'veh-1',
        geofenceTripId: 'trip-1',
      });
    }
  });

  it('an offline batch flushed after delivery still lands on the trip it was recorded on', async () => {
    const old = new Date(now - 30 * 60_000).toISOString();
    const resolver = new TripResolver(
      { getTripRefForDriver: async () => ref('delivered_ok') } as unknown as ActiveTripIndex,
      {
        findTripsForDriverAt: async () => [
          { recordedAt: old, tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' },
        ],
      } as unknown as TripRepository,
    );
    const [trip] = await resolver.resolve('d1', [TENANT], [old], now);
    expect(trip).toEqual({ tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' });
  });

  it("only tracks a trip through the source its load's tracking_source names", async () => {
    const withSource = (trackingSource: string | null) => ({
      ...ref('in_transit_unloading'),
      trackingSource,
    });
    const resolve = (trackingSource: string | null) =>
      resolverFor(withSource(trackingSource)).resolve('d1', [TENANT], [recordedAt], now);
    expect((await resolve('driver_app'))[0]).toMatchObject({ tripId: 'trip-1' });
    expect((await resolve(null))[0]).toMatchObject({ tripId: 'trip-1' });
    expect((await resolve('fastag'))[0]).toMatchObject({ tripId: 'trip-1' });
    // A GPS-tracked load ignores the phone.
    expect((await resolve('gps'))[0]).toBeNull();
    expect((await resolve('sim'))[0]).toBeNull();
  });

  it.each(['market_fleet', 'indent'])(
    "takes a %s driver's points though the shipper's tenant isn't theirs",
    async (postingType) => {
      const placed = { ...ref('in_transit_unloading'), postingType, trackingSource: 'driver_app' };
      const [trip] = await resolverFor(placed).resolve('d1', [], [recordedAt], now);
      expect(trip).toEqual({ tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' });
    },
  );

  it('still needs the tenant for an own-fleet (or not yet known) load', async () => {
    for (const postingType of ['own_fleet', null]) {
      const own = { ...ref('in_transit_unloading'), postingType };
      const [trip] = await resolverFor(own).resolve('d1', ['other-tenant'], [recordedAt], now);
      expect(trip).toBeNull();
    }
  });

  it('says why a point matched no trip', async () => {
    const detailed = (trip: TripRef | null) =>
      new TripResolver(
        { getTripRefForDriver: async () => trip } as unknown as ActiveTripIndex,
        {} as TripRepository,
      ).resolveDetailed('d1', [TENANT], [recordedAt], now);
    expect((await detailed(null))[0]).toEqual({ trip: null, dropReason: 'no_active_trip' });
    expect((await detailed({ ...ref('in_transit_unloading'), trackingSource: 'sim' }))[0]).toEqual({
      trip: null,
      dropReason: 'source_mismatch',
    });
    expect(
      (await detailed({ ...ref('in_transit_unloading'), startedAtMs: now + 3_600_000 }))[0],
    ).toEqual({ trip: null, dropReason: 'outside_window' });
    expect((await detailed(ref('in_transit_unloading')))[0]).toMatchObject({ dropReason: null });
  });

  describe('offline batch (older points, no active trip in Redis)', () => {
    const old = new Date(now - 60 * 60_000).toISOString();
    const fallbackFor = (approach: boolean) =>
      new TripResolver(
        { getTripRefForDriver: async () => null } as unknown as ActiveTripIndex,
        {
          findTripsForDriverAt: async () => [
            {
              recordedAt: old,
              tripId: 'trip-9',
              tenantId: TENANT,
              vehicleId: 'veh-9',
              trackingSource: null,
              approach,
            },
          ],
        } as unknown as TripRepository,
      );

    it('puts a point from after tracking started on the trip', async () => {
      const [trip] = await fallbackFor(false).resolve('d1', [TENANT], [old], now);
      expect(trip).toEqual({ tripId: 'trip-9', tenantId: TENANT, vehicleId: 'veh-9' });
    });

    it('keeps a point from the drive to the plant off the trip, as its approach', async () => {
      const [trip] = await fallbackFor(true).resolve('d1', [TENANT], [old], now);
      expect(trip).toEqual({
        tripId: null,
        tenantId: TENANT,
        vehicleId: 'veh-9',
        geofenceTripId: 'trip-9',
      });
    });
  });
});

describe('TripResolver Postgres fallback under a reconnect storm', () => {
  it('runs a few at once and refuses the rest at once (the app retries)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    let peak = 0;
    const repository = {
      findTripsForDriverAt: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
        return [];
      },
    } as unknown as TripRepository;
    const resolver = new TripResolver(
      { getTripRefForDriver: async () => null } as unknown as ActiveTripIndex,
      repository,
      new Limiter('test', 2, 2),
    );
    const now = Date.now();
    const old = [new Date(now - 60 * 60_000).toISOString()]; // offline batch: goes to the fallback
    const flushes = Array.from({ length: 6 }, (_, i) =>
      resolver.resolve(`driver-${i}`, [TENANT], old, now),
    );
    const settled = Promise.allSettled(flushes);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const results = await settled;
    expect(peak).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(2);
    expect(refused[0].reason).toBeInstanceOf(LimiterBusyError);
  });
});

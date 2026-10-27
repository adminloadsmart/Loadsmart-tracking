import { describe, expect, it } from 'vitest';
import type { ActiveTripIndex, TripRef } from '../trips';
import { toNormalizedPoint } from './driver-point.contract';
import { TripResolver } from './trip-resolver';
import type { TripRepository } from './trip.repository';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ref = (loadStatus: string): TripRef => ({
  tripId: 'trip-1',
  tenantId: TENANT,
  vehicleId: 'veh-1',
  startedAtMs: null,
  loadStatus,
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
    const [trip] = await resolverFor(ref('in_transit')).resolve('d1', TENANT, [recordedAt], now);
    expect(trip).toEqual({ tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' });
  });

  it('keeps an assigned load off the trip, as the approach to the plant', async () => {
    const [trip] = await resolverFor(ref('assigned')).resolve('d1', TENANT, [recordedAt], now);
    expect(trip).toEqual({
      tripId: null,
      tenantId: TENANT,
      vehicleId: 'veh-1',
      geofenceTripId: 'trip-1',
    });
    const point = toNormalizedPoint(
      { lat: 30.9, lng: 75.85, recordedAt } as Parameters<typeof toNormalizedPoint>[0],
      { ...trip!, driverId: 'd1' },
      recordedAt,
    );
    expect(point.tripId).toBeNull();
    expect(point.flags).toMatchObject({ geofenceTripId: 'trip-1' });
  });

  it('keeps a delivered load off the trip, while it leaves the delivery point', async () => {
    for (const status of ['delivered', 'closed']) {
      const [trip] = await resolverFor(ref(status)).resolve('d1', TENANT, [recordedAt], now);
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
      { getTripRefForDriver: async () => ref('delivered') } as unknown as ActiveTripIndex,
      {
        findTripsForDriverAt: async () => [
          { recordedAt: old, tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' },
        ],
      } as unknown as TripRepository,
    );
    const [trip] = await resolver.resolve('d1', TENANT, [old], now);
    expect(trip).toEqual({ tripId: 'trip-1', tenantId: TENANT, vehicleId: 'veh-1' });
  });
});

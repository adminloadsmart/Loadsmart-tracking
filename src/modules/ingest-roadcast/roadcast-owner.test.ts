import { describe, expect, it } from 'vitest';
import type { TripRef } from '../trips';
import { ownerFor } from './roadcast-poll.job';

const TENANT = '11111111-1111-4111-8111-111111111111';
const device = { imei: '866221070401935', vehicleId: 'veh-1', tenantId: TENANT };
const trip = (trackingSource: string | null): TripRef => ({
  tripId: 'trip-1',
  tenantId: TENANT,
  vehicleId: 'veh-1',
  startedAtMs: null,
  loadStatus: 'in_transit_unloading',
  trackingSource,
});

describe('ownerFor and tracking_source', () => {
  it.each([['gps'], [null], ['fastag']])('a %s load takes the device fix', (source) => {
    expect(ownerFor(device, trip(source), Date.now()).tripId).toBe('trip-1');
  });

  it.each([['driver_app'], ['sim']])('a %s load does not', (source) => {
    expect(ownerFor(device, trip(source), Date.now()).tripId).toBeNull();
  });
});

describe('ownerFor outside the tracked window', () => {
  it.each([['truck_assigned'], ['in_transit_loading'], ['delivered_ok'], ['closed']])(
    'a %s load carries the trip only as geofenceTripId, never tripId',
    (loadStatus) => {
      const owner = ownerFor(device, { ...trip('gps'), loadStatus }, Date.now());
      expect(owner.tripId).toBeNull();
      expect(owner.geofenceTripId).toBe('trip-1');
    },
  );
});

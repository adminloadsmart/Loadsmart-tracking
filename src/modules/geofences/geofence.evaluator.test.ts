import { describe, expect, it } from 'vitest';
import type { MainGeofence, MainTripPoints } from '../main-data';
import {
  evaluateVehicle,
  GeofenceFix,
  GeofenceTransition,
  tripEventFor,
} from './geofence.evaluator';

const VEHICLE = '22222222-2222-4222-8222-222222222222';
const TRIP = '33333333-3333-4333-8333-333333333333';
const PICKUP = '44444444-4444-4444-8444-444444444444';
const DROP = '55555555-5555-4555-8555-555555555555';
const T0 = Date.parse('2026-10-19T10:00:00.000Z');
/** ~1 m of latitude in degrees. */
const M = 1 / 111_195;

const plant: MainGeofence = {
  id: 'geo-plant',
  tenantId: 'tenant-1',
  name: 'Ludhiana Plant',
  type: 'loading_point',
  shape: 'circle',
  lat: 30.9,
  lng: 75.85,
  radiusM: 300,
  polygon: null,
  appliesToAllVehicles: true,
  vehicleIds: [],
  loadingPointId: PICKUP,
  customerDeliveryPointId: null,
};

/** A fix `metres` north of the plant, `seconds` after T0. */
const fix = (seconds: number, metres: number, tripId: string | null = TRIP): GeofenceFix => ({
  t: T0 + seconds * 1000,
  lat: 30.9 + metres * M,
  lng: 75.85,
  tripId,
});

describe('evaluateVehicle', () => {
  it('records the first sighting without an event', () => {
    const result = evaluateVehicle(VEHICLE, [fix(0, 0)], [plant], {});
    expect(result.transitions).toEqual([]);
    expect(result.state[plant.id]).toEqual({ inside: true, enteredAt: T0, lastT: T0 });
  });

  it('raises enter, then exit, as the truck drives in and out', () => {
    const fixes = [fix(0, 1000), fix(60, 100), fix(120, 50), fix(600, 900)];
    const result = evaluateVehicle(VEHICLE, fixes, [plant], {});
    expect(result.transitions.map((t) => [t.event, t.t])).toEqual([
      ['enter', T0 + 60_000],
      ['exit', T0 + 600_000],
    ]);
    expect(result.state[plant.id]).toEqual({ inside: false, enteredAt: null, lastT: T0 + 600_000 });
  });

  it('keeps the entry time while the truck stays inside', () => {
    const result = evaluateVehicle(VEHICLE, [fix(0, 1000), fix(60, 10), fix(120, 20)], [plant], {});
    expect(result.state[plant.id]).toMatchObject({ inside: true, enteredAt: T0 + 60_000 });
  });

  it('continues from stored state and skips fixes not newer than it', () => {
    const stored = { [plant.id]: { inside: false, enteredAt: null, lastT: T0 + 60_000 } };
    const result = evaluateVehicle(VEHICLE, [fix(30, 0), fix(60, 0)], [plant], stored);
    expect(result.transitions).toEqual([]);
    expect(result.changed).toEqual([]);
    const later = evaluateVehicle(VEHICLE, [fix(90, 0)], [plant], stored);
    expect(later.transitions.map((t) => t.event)).toEqual(['enter']);
  });

  it('only checks geofences that apply to the vehicle', () => {
    const otherTrucks = { ...plant, appliesToAllVehicles: false, vehicleIds: ['someone-else'] };
    const result = evaluateVehicle(VEHICLE, [fix(0, 1000), fix(60, 0)], [otherTrucks], {});
    expect(result.transitions).toEqual([]);
    expect(result.state).toEqual({});
  });

  it('tests polygons', () => {
    const square: MainGeofence = {
      ...plant,
      shape: 'polygon',
      radiusM: null,
      polygon: [
        { lat: 30.899, lng: 75.849 },
        { lat: 30.901, lng: 75.849 },
        { lat: 30.901, lng: 75.851 },
        { lat: 30.899, lng: 75.851 },
      ],
    };
    const result = evaluateVehicle(VEHICLE, [fix(0, 1000), fix(60, 0)], [square], {});
    expect(result.transitions.map((t) => t.event)).toEqual(['enter']);
  });
});

describe('tripEventFor', () => {
  const points: MainTripPoints = {
    vehicleNumber: 'PB10AB1234',
    pickupLoadingPointId: PICKUP,
    dropCustomerDeliveryPointId: DROP,
    dropLoadingPointId: null,
  };
  const transition = (
    event: 'enter' | 'exit',
    geofence: MainGeofence = plant,
    tripId: string | null = TRIP,
  ): GeofenceTransition => ({ geofence, event, t: T0, lat: 30.9, lng: 75.85, tripId });
  const dropFence: MainGeofence = {
    ...plant,
    id: 'geo-drop',
    type: 'unloading_point',
    loadingPointId: null,
    customerDeliveryPointId: DROP,
  };

  it('entering the pickup while assigned is the arrival at the plant', () => {
    expect(tripEventFor(transition('enter'), 'truck_assigned', points)).toBe(
      'trip.arrived_at_pickup',
    );
    expect(tripEventFor(transition('enter'), 'in_transit_loading', points)).toBe(
      'trip.arrived_at_pickup',
    );
    expect(tripEventFor(transition('enter'), 'reached_loading', points)).toBeNull();
  });

  it('leaving the pickup once loading is confirmed is the departure', () => {
    expect(tripEventFor(transition('exit'), 'loaded', points)).toBe('trip.departed_pickup');
    expect(tripEventFor(transition('exit'), 'in_transit_unloading', points)).toBe(
      'trip.departed_pickup',
    );
    // Stepping out before loading is confirmed isn't the departure.
    expect(tripEventFor(transition('exit'), 'reached_loading', points)).toBeNull();
  });

  it('entering the drop while in transit is the arrival at the drop', () => {
    expect(tripEventFor(transition('enter', dropFence), 'in_transit_unloading', points)).toBe(
      'trip.arrived_at_drop',
    );
    expect(tripEventFor(transition('enter', dropFence), 'truck_assigned', points)).toBeNull();
  });

  it('leaving the drop once there — before or after the E-POD — is the departure', () => {
    for (const status of ['reached_unloading', 'delivered_ok', 'closed']) {
      expect(tripEventFor(transition('exit', dropFence), status, points)).toBe(
        'trip.departed_drop',
      );
    }
    // Driving out of the drop's geofence before reaching it isn't a departure.
    expect(tripEventFor(transition('exit', dropFence), 'in_transit_unloading', points)).toBeNull();
    // Nor is leaving another customer's delivery point.
    const otherDrop = { ...dropFence, customerDeliveryPointId: 'another-drop' };
    expect(tripEventFor(transition('exit', otherDrop), 'delivered_ok', points)).toBeNull();
  });

  it("a posted load's drop at the shipper's own loading point counts", () => {
    const ownDrop = { ...dropFence, loadingPointId: 'own-site', customerDeliveryPointId: null };
    const posted = { ...points, dropCustomerDeliveryPointId: null, dropLoadingPointId: 'own-site' };
    expect(tripEventFor(transition('enter', ownDrop), 'in_transit_unloading', posted)).toBe(
      'trip.arrived_at_drop',
    );
  });

  it("ignores geofences not linked to this trip's points, and fixes with no trip", () => {
    const otherPlant = { ...plant, loadingPointId: 'another-plant' };
    expect(tripEventFor(transition('enter', otherPlant), 'truck_assigned', points)).toBeNull();
    expect(tripEventFor(transition('enter', plant, null), 'truck_assigned', points)).toBeNull();
    expect(
      tripEventFor(transition('enter', { ...plant, type: 'yard' }), 'truck_assigned', points),
    ).toBeNull();
  });
});

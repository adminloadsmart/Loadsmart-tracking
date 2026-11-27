import { describe, expect, it } from 'vitest';
import type { MainGeofence, MainTripPoints } from '../main-data';
import {
  advanceDwell,
  dwellEventFor,
  evaluateVehicle,
  GeofenceDwell,
  GeofenceFix,
  GeofenceTransition,
  tripEventFor,
  tripPlaceOf,
} from './geofence.evaluator';
import { containsPoint, mayContain } from './geofence.geo';

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
const fix = (
  seconds: number,
  metres: number,
  tripId: string | null = TRIP,
  extra: Partial<GeofenceFix> = {},
): GeofenceFix => ({
  t: T0 + seconds * 1000,
  lat: 30.9 + metres * M,
  lng: 75.85,
  tripId,
  ...extra,
});

describe('evaluateVehicle', () => {
  it('records the first sighting without an event', () => {
    const result = evaluateVehicle(VEHICLE, [fix(0, 0)], [plant], {});
    expect(result.transitions).toEqual([]);
    expect(result.state[plant.id]).toMatchObject({ inside: true, enteredAt: T0, lastT: T0 });
  });

  it('raises enter, then exit, as the truck drives in and out', () => {
    const fixes = [fix(0, 1000), fix(60, 100), fix(120, 50), fix(600, 900)];
    const result = evaluateVehicle(VEHICLE, fixes, [plant], {});
    expect(result.transitions.map((t) => [t.event, t.t])).toEqual([
      ['enter', T0 + 60_000],
      ['exit', T0 + 600_000],
    ]);
    // Only visits in progress are kept: the ended one is deleted, the vehicle's lastT moves on.
    expect(result.state).toEqual({});
    expect(result.removed).toEqual([plant.id]);
    expect(result.meta.lastT).toBe(T0 + 600_000);
    expect(result.dwells).toEqual([]);
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

  it('entering the pickup is no longer the arrival: that waits for the stop (dwellEventFor)', () => {
    for (const status of ['truck_assigned', 'in_transit_loading', 'reached_loading']) {
      expect(tripEventFor(transition('enter'), status, points)).toBeNull();
    }
  });

  it('leaving the pickup once loading is confirmed is the departure', () => {
    expect(tripEventFor(transition('exit'), 'loaded', points)).toBe('trip.departed_pickup');
    expect(tripEventFor(transition('exit'), 'in_transit_unloading', points)).toBe(
      'trip.departed_pickup',
    );
    // Stepping out before loading is confirmed isn't the departure.
    expect(tripEventFor(transition('exit'), 'reached_loading', points)).toBeNull();
  });

  it('entering the drop while in transit is announced at once, not yet the arrival', () => {
    expect(tripEventFor(transition('enter', dropFence), 'in_transit_unloading', points)).toBe(
      'trip.entered_drop_geofence',
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
      'trip.entered_drop_geofence',
    );
  });

  it("ignores geofences not linked to this trip's points, and fixes with no trip", () => {
    const otherPlant = { ...plant, loadingPointId: 'another-plant' };
    expect(tripEventFor(transition('exit', otherPlant), 'loaded', points)).toBeNull();
    expect(tripEventFor(transition('exit', plant, null), 'loaded', points)).toBeNull();
    expect(
      tripEventFor(transition('exit', { ...plant, type: 'yard' }), 'loaded', points),
    ).toBeNull();
  });
});

describe('dwell: arrival after the stop wait, detention after 24 h', () => {
  const stopped = { speedKmh: 0 };
  const moving = { speedKmh: 30 };
  const MIN = 60;

  it('a stopped truck arrives once it has been stopped 10 min inside, at a deterministic time', () => {
    const fixes = [
      fix(0, 1000, TRIP, moving),
      fix(60, 100, TRIP, stopped),
      fix(5 * MIN, 50, TRIP, stopped),
      fix(11 * MIN, 50, TRIP, stopped),
    ];
    const result = evaluateVehicle(VEHICLE, fixes, [plant], {});
    expect(result.dwells).toHaveLength(1);
    expect(result.dwells[0]).toMatchObject({
      kind: 'arrival',
      since: T0 + 60_000,
      t: T0 + 60_000 + 10 * 60_000,
      tripId: TRIP,
    });
    // Not raised a second time.
    const again = evaluateVehicle(
      VEHICLE,
      [fix(14 * MIN, 50, TRIP, stopped)],
      [plant],
      result.state,
    );
    expect(again.dwells).toEqual([]);
  });

  it('driving through, or moving again before the wait is over, is not an arrival', () => {
    const fixes = [
      fix(0, 1000, TRIP, moving),
      fix(60, 100, TRIP, stopped),
      fix(5 * MIN, 80, TRIP, moving), // moved: the stop starts over
      fix(12 * MIN, 60, TRIP, stopped),
      fix(20 * MIN, 60, TRIP, stopped),
    ];
    const result = evaluateVehicle(VEHICLE, fixes, [plant], {});
    expect(result.dwells).toEqual([]);
    expect(result.state[plant.id].stoppedSince).toBe(T0 + 12 * 60_000);
  });

  it('ignition off counts as stopped, whatever the speed says', () => {
    const fixes = [
      fix(0, 1000, TRIP, moving),
      fix(60, 100, TRIP, { speedKmh: 8, ignition: false }),
      fix(12 * MIN, 100, TRIP, { speedKmh: 8, ignition: false }),
    ];
    expect(evaluateVehicle(VEHICLE, fixes, [plant], {}).dwells).toHaveLength(1);
  });

  it('SIM fixes (no speed, no ignition): two close pings 20 min apart are the same stop', () => {
    const fixes = [fix(0, 1000), fix(60, 100), fix(21 * MIN, 120)];
    const result = evaluateVehicle(VEHICLE, fixes, [plant], {});
    expect(result.dwells.map((d) => d.kind)).toEqual(['arrival']);
    // A SIM ping that is a long way from the last one inside is movement, not a stop.
    const far: MainGeofence = { ...plant, radiusM: 5000 };
    const moved = evaluateVehicle(
      VEHICLE,
      [fix(0, 3000), fix(60, 2000), fix(21 * MIN, 4000)],
      [far],
      {},
    );
    expect(moved.dwells).toEqual([]);
  });

  it('a truck already inside at the first sighting arrives once the wait is over', () => {
    const result = evaluateVehicle(
      VEHICLE,
      [fix(0, 10, TRIP, stopped), fix(11 * MIN, 10, TRIP, stopped)],
      [plant],
      {},
    );
    expect(result.transitions).toEqual([]);
    expect(result.dwells.map((d) => d.kind)).toEqual(['arrival']);
  });

  it('leaving ends the visit: the next visit times from scratch', () => {
    const fixes = [
      fix(0, 10, TRIP, stopped),
      fix(5 * MIN, 2000, TRIP, moving),
      fix(8 * MIN, 10, TRIP, stopped),
      fix(15 * MIN, 10, TRIP, stopped),
    ];
    expect(evaluateVehicle(VEHICLE, fixes, [plant], {}).dwells).toEqual([]);
  });

  it('detention is raised once, 24 h after entering, even if the truck keeps moving inside', () => {
    const fixes = [
      fix(0, 1000, TRIP, moving),
      fix(60, 100, TRIP, moving),
      fix(23 * 3600, 100, TRIP, moving),
      fix(25 * 3600, 100, TRIP, moving),
      fix(26 * 3600, 100, TRIP, moving),
    ];
    const result = evaluateVehicle(VEHICLE, fixes, [plant], {});
    expect(result.dwells).toHaveLength(1);
    expect(result.dwells[0]).toMatchObject({
      kind: 'detention',
      since: T0 + 60_000,
      t: T0 + 60_000 + 24 * 3600_000,
    });
  });

  it('state stored before dwell existed keeps working: the stop is timed from the next fix', () => {
    const old = { [plant.id]: { inside: true, enteredAt: T0, lastT: T0 } };
    const first = evaluateVehicle(VEHICLE, [fix(11 * MIN, 10, TRIP, stopped)], [plant], old);
    expect(first.dwells).toEqual([]);
    const later = evaluateVehicle(
      VEHICLE,
      [fix(22 * MIN, 10, TRIP, stopped)],
      [plant],
      first.state,
    );
    expect(later.dwells.map((d) => d.kind)).toEqual(['arrival']);
  });

  it('applies the default radius to a circle with none of its own', () => {
    const noRadius: MainGeofence = { ...plant, radiusM: null };
    const result = evaluateVehicle(VEHICLE, [fix(0, 3000), fix(60, 200)], [noRadius], {});
    expect(result.transitions.map((t) => t.event)).toEqual(['enter']);
  });

  describe('advanceDwell (the clock, when no new fix arrives)', () => {
    const inside = evaluateVehicle(
      VEHICLE,
      [fix(0, 1000, TRIP, moving), fix(60, 100, TRIP, stopped)],
      [plant],
      {},
    ).state;
    const STALE = 45 * 60_000;

    it('arrives once the wait has passed, then not again', () => {
      expect(advanceDwell([plant], inside, T0 + 5 * 60_000, STALE).dwells).toEqual([]);
      const due = advanceDwell([plant], inside, T0 + 11 * 60_000 + 60_000, STALE);
      expect(due.dwells).toHaveLength(1);
      expect(due.dwells[0].t).toBe(T0 + 60_000 + 10 * 60_000);
      expect(advanceDwell([plant], due.state, T0 + 12 * 60_000 + 60_000, STALE).dwells).toEqual([]);
    });

    it('does not take a truck not seen for a long time to still be there', () => {
      expect(advanceDwell([plant], inside, T0 + 2 * 3600_000, STALE).dwells).toEqual([]);
    });

    it('produces the same event time as the per-fix check (so the two never double up)', () => {
      const byFix = evaluateVehicle(VEHICLE, [fix(12 * MIN, 100, TRIP, stopped)], [plant], inside);
      const byClock = advanceDwell([plant], inside, T0 + 12 * 60_000, STALE);
      expect(byFix.dwells[0].t).toBe(byClock.dwells[0].t);
    });
  });
});

describe('dwellEventFor', () => {
  const points: MainTripPoints = {
    vehicleNumber: 'PB10AB1234',
    pickupLoadingPointId: PICKUP,
    dropCustomerDeliveryPointId: DROP,
    dropLoadingPointId: null,
  };
  const dropFence: MainGeofence = {
    ...plant,
    id: 'geo-drop',
    type: 'unloading_point',
    loadingPointId: null,
    customerDeliveryPointId: DROP,
  };
  const dwell = (
    kind: 'arrival' | 'detention',
    geofence: MainGeofence = plant,
    tripId: string | null = TRIP,
  ): GeofenceDwell => ({ geofence, kind, t: T0, since: T0, lat: 30.9, lng: 75.85, tripId });

  it('an arrival at the pickup counts on the approach only', () => {
    for (const status of ['truck_assigned', 'in_transit_loading']) {
      expect(dwellEventFor(dwell('arrival'), status, points)).toEqual({
        type: 'trip.arrived_at_pickup',
        point: 'loading',
      });
    }
    expect(dwellEventFor(dwell('arrival'), 'reached_loading', points)).toBeNull();
  });

  it('an arrival at the drop counts while in transit only', () => {
    expect(dwellEventFor(dwell('arrival', dropFence), 'in_transit_unloading', points)).toEqual({
      type: 'trip.arrived_at_drop',
      point: 'unloading',
    });
    expect(dwellEventFor(dwell('arrival', dropFence), 'reached_unloading', points)).toBeNull();
  });

  it('detention counts at either of the trip’s own points, while the truck is there', () => {
    expect(dwellEventFor(dwell('detention'), 'reached_loading', points)).toEqual({
      type: 'trip.detention_detected',
      point: 'loading',
    });
    expect(dwellEventFor(dwell('detention', dropFence), 'reached_unloading', points)).toEqual({
      type: 'trip.detention_detected',
      point: 'unloading',
    });
    expect(dwellEventFor(dwell('detention'), 'delivered_ok', points)).toBeNull();
  });

  it('ignores other places and fixes with no trip', () => {
    expect(
      dwellEventFor(
        dwell('arrival', { ...plant, loadingPointId: 'elsewhere' }),
        'truck_assigned',
        points,
      ),
    ).toBeNull();
    expect(dwellEventFor(dwell('arrival', plant, null), 'truck_assigned', points)).toBeNull();
    expect(
      dwellEventFor(dwell('detention', { ...plant, type: 'yard' }), 'reached_loading', points),
    ).toBeNull();
  });
});

describe('trips created from the tracking screen', () => {
  const created: MainTripPoints = {
    vehicleNumber: 'PB10AB1234',
    pickupLoadingPointId: PICKUP,
    dropCustomerDeliveryPointId: DROP,
    dropLoadingPointId: null,
    createdTrip: true,
  };
  const dropFence: MainGeofence = {
    ...plant,
    id: 'geo-drop',
    type: 'unloading_point',
    loadingPointId: null,
    customerDeliveryPointId: DROP,
  };
  const transition = (
    event: 'enter' | 'exit',
    geofence: MainGeofence,
    tripId: string = TRIP,
  ): GeofenceTransition => ({ geofence, event, t: T0, lat: 30.9, lng: 75.85, tripId });
  const dwell = (kind: 'arrival' | 'detention', geofence: MainGeofence): GeofenceDwell => ({
    geofence,
    kind,
    t: T0,
    since: T0,
    lat: 30.9,
    lng: 75.85,
    tripId: TRIP,
  });

  it('arrives at and departs the pickup while heading to it', () => {
    expect(dwellEventFor(dwell('arrival', plant), 'in_transit_loading', created)).toEqual({
      type: 'trip.arrived_at_pickup',
      point: 'loading',
    });
    expect(tripEventFor(transition('exit', plant), 'in_transit_loading', created)).toBe(
      'trip.departed_pickup',
    );
  });

  it('still reaches the drop if the truck was never seen leaving the pickup', () => {
    expect(tripEventFor(transition('enter', dropFence), 'in_transit_loading', created)).toBe(
      'trip.entered_drop_geofence',
    );
    expect(dwellEventFor(dwell('arrival', dropFence), 'in_transit_loading', created)).toEqual({
      type: 'trip.arrived_at_drop',
      point: 'unloading',
    });
  });

  it('matches an inbound pickup at a customer address (load trips do not)', () => {
    const inbound: MainTripPoints = {
      ...created,
      pickupLoadingPointId: null,
      pickupCustomerDeliveryPointId: DROP,
      dropCustomerDeliveryPointId: null,
      dropLoadingPointId: PICKUP,
    };
    expect(tripPlaceOf(dropFence, inbound)).toBe('pickup');
    expect(tripPlaceOf(plant, inbound)).toBe('drop');
    expect(tripPlaceOf(dropFence, { ...inbound, createdTrip: false })).toBeNull();
  });

  it('uses the default radius for a circle saved with 0 m', () => {
    const zero = { ...plant, radiusM: 0 };
    const result = evaluateVehicle(VEHICLE, [fix(0, 5000), fix(60, 100)], [zero], {});
    expect(result.transitions.map((t) => t.event)).toEqual(['enter']);
  });
});

describe('evaluateVehicle: sparse state (only visits in progress are stored)', () => {
  const LIST_AT = T0 - 3600_000;
  const far = { ...plant, id: 'geo-far', lat: 28.6, lng: 77.2 }; // Delhi, hundreds of km away

  it('outside → outside writes no memberships, only the vehicle meta', () => {
    const result = evaluateVehicle(
      VEHICLE,
      [fix(0, 1000), fix(60, 1200)],
      [plant, far],
      {},
      undefined,
      {},
      LIST_AT,
    );
    expect(result.changed).toEqual([]);
    expect(result.state).toEqual({});
    expect(result.meta).toEqual({ lastT: T0 + 60_000, listAt: LIST_AT });
  });

  it('a geofence with no entry, already in the last evaluated list, is known outside: entering it is an enter', () => {
    const first = evaluateVehicle(VEHICLE, [fix(0, 1000)], [plant], {}, undefined, {}, LIST_AT);
    const later = evaluateVehicle(
      VEHICLE,
      [fix(60, 0)],
      [plant],
      first.state,
      undefined,
      first.meta,
      LIST_AT,
    );
    expect(later.transitions.map((t) => t.event)).toEqual(['enter']);
  });

  it('a geofence drawn after the last evaluated list is a first sighting: no enter for a truck already inside', () => {
    const first = evaluateVehicle(VEHICLE, [fix(0, 1000)], [far], {}, undefined, {}, LIST_AT);
    const drawnLater = { ...plant, createdAtMs: LIST_AT + 1000 };
    const later = evaluateVehicle(
      VEHICLE,
      [fix(60, 0)],
      [far, drawnLater],
      first.state,
      undefined,
      first.meta,
      LIST_AT + 2000,
    );
    expect(later.transitions).toEqual([]);
    expect(later.state[plant.id]).toMatchObject({ inside: true });
  });

  it("a fix older than the vehicle's newest (a second source arriving late) raises no false enter / exit", () => {
    const inside = evaluateVehicle(
      VEHICLE,
      [fix(0, 1000), fix(100, 0)],
      [plant],
      {},
      undefined,
      {},
      LIST_AT,
    );
    expect(inside.transitions.map((t) => t.event)).toEqual(['enter']);
    // Phone fix recorded at t=90 (outside, before the Roadcast t=100 that is already applied).
    const late = evaluateVehicle(
      VEHICLE,
      [fix(90, 1000)],
      [plant],
      inside.state,
      undefined,
      inside.meta,
      LIST_AT,
    );
    expect(late.transitions).toEqual([]);
    expect(late.changed).toEqual([]);
    expect(late.state[plant.id]).toMatchObject({ inside: true });
  });

  it('state in the old format (an entry per geofence) still reads right, and its outside entries are dropped', () => {
    const old = {
      [plant.id]: { inside: false, enteredAt: null, lastT: T0 },
      [far.id]: { inside: false, enteredAt: null, lastT: T0 },
    };
    const result = evaluateVehicle(
      VEHICLE,
      [fix(60, 0)],
      [plant, far],
      old,
      undefined,
      {},
      LIST_AT,
    );
    expect(result.transitions.map((t) => t.event)).toEqual(['enter']);
    expect(result.removed).toEqual([far.id]);
    expect(result.changed).toEqual([plant.id]);
  });
});

describe('mayContain (bounding-box prefilter)', () => {
  it('never rules out a point containsPoint accepts — circles of every radius, at the border', () => {
    for (const radiusM of [50, 300, 2000, 25_000]) {
      for (const lat of [8.5, 22, 30.9, 34.1]) {
        const g: MainGeofence = { ...plant, lat, lng: 77, radiusM };
        for (let deg = 0; deg < 360; deg += 7.5) {
          const rad = (deg * Math.PI) / 180;
          // Just inside the border, with a destination-point formula on the sphere.
          const d = (radiusM - 0.01) / 6_371_008.8;
          const φ1 = (lat * Math.PI) / 180;
          const φ2 = Math.asin(
            Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(rad),
          );
          const λ2 =
            (77 * Math.PI) / 180 +
            Math.atan2(
              Math.sin(rad) * Math.sin(d) * Math.cos(φ1),
              Math.cos(d) - Math.sin(φ1) * Math.sin(φ2),
            );
          const p = { lat: (φ2 * 180) / Math.PI, lng: (λ2 * 180) / Math.PI };
          expect(containsPoint(g, p)).toBe(true);
          expect(mayContain(g, p)).toBe(true);
        }
      }
    }
  });

  it('uses the default radius for a circle without one, and the vertices for a polygon', () => {
    const noRadius: MainGeofence = { ...plant, radiusM: null };
    expect(mayContain(noRadius, { lat: 30.9 + 1900 * M, lng: 75.85 }, 2000)).toBe(true);
    expect(mayContain(noRadius, { lat: 30.9 + 2100 * M, lng: 75.85 }, 2000)).toBe(false);
    const square: MainGeofence = {
      ...plant,
      shape: 'polygon',
      polygon: [
        { lat: 30.899, lng: 75.849 },
        { lat: 30.901, lng: 75.849 },
        { lat: 30.901, lng: 75.851 },
        { lat: 30.899, lng: 75.851 },
      ],
    };
    expect(mayContain(square, { lat: 30.901, lng: 75.851 })).toBe(true);
    expect(mayContain(square, { lat: 30.91, lng: 75.85 })).toBe(false);
  });

  it('rules out far-away geofences', () => {
    expect(mayContain(plant, { lat: 28.6, lng: 77.2 })).toBe(false);
  });
});

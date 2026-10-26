import type { MainGeofence, MainTripPoints } from '../main-data';
import { IN_TRANSIT_STATUS, isApproachStatus } from '../trips/trip-state';
import { containsPoint } from './geofence.geo';

/** One accepted, non-late fix as the geofence check sees it (device time). */
export interface GeofenceFix {
  t: number;
  lat: number;
  lng: number;
  /** The trip the fix belongs to — its `tripId`, or the assigned trip on the drive to the plant. */
  tripId: string | null;
}

/** Inside/outside of one geofence for one vehicle, as of its newest evaluated fix. */
export interface GeofenceMembership {
  inside: boolean;
  enteredAt: number | null;
  lastT: number;
}

/** Per vehicle: geofence id → membership. */
export type VehicleGeofenceState = Record<string, GeofenceMembership>;

export interface GeofenceTransition {
  geofence: MainGeofence;
  event: 'enter' | 'exit';
  t: number;
  lat: number;
  lng: number;
  tripId: string | null;
}

export const TRIP_EVENT_TYPES = [
  'trip.arrived_at_pickup',
  'trip.departed_pickup',
  'trip.arrived_at_drop',
] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];

const appliesTo = (geofence: MainGeofence, vehicleId: string) =>
  geofence.appliesToAllVehicles || geofence.vehicleIds.includes(vehicleId);

/**
 * Runs a vehicle's fixes (device-time order) through its geofences. Pure — the caller loads and
 * persists the state — so a redelivered batch recomputes the same transitions.
 *
 * Same rules the main backend's ping check had: only a change of inside/outside is an event; a
 * fix not newer than the stored state is skipped (late/duplicate); the first sighting of a
 * vehicle against a geofence records where it is but raises nothing (a truck parked inside when
 * the geofence is drawn hasn't "entered" it).
 */
export function evaluateVehicle(
  vehicleId: string,
  fixes: GeofenceFix[],
  geofences: MainGeofence[],
  stored: VehicleGeofenceState,
): { transitions: GeofenceTransition[]; state: VehicleGeofenceState; changed: string[] } {
  const state: VehicleGeofenceState = { ...stored };
  const transitions: GeofenceTransition[] = [];
  const changed = new Set<string>();

  for (const fix of fixes) {
    for (const geofence of geofences) {
      if (!appliesTo(geofence, vehicleId)) continue;
      const previous = state[geofence.id];
      if (previous && previous.lastT >= fix.t) continue;
      const inside = containsPoint(geofence, fix);
      changed.add(geofence.id);
      if (!previous) {
        state[geofence.id] = { inside, enteredAt: inside ? fix.t : null, lastT: fix.t };
        continue;
      }
      state[geofence.id] = {
        inside,
        enteredAt: inside ? (previous.inside ? previous.enteredAt : fix.t) : null,
        lastT: fix.t,
      };
      if (inside !== previous.inside) {
        transitions.push({
          geofence,
          event: inside ? 'enter' : 'exit',
          t: fix.t,
          lat: fix.lat,
          lng: fix.lng,
          tripId: fix.tripId,
        });
      }
    }
  }
  return { transitions, state, changed: [...changed] };
}

/**
 * The trip step a transition stands for, if any — only when the geofence is linked to this
 * trip's own pickup / drop point, and only from the status the main backend moves on from:
 * - enter the pickup's loading-point geofence on the approach (truck_assigned / in_transit_loading)
 *   → arrived at pickup (the main backend moves the load to reached_loading);
 * - leave it once the load is loaded (still "loaded", or already in_transit_unloading)
 *   → departed pickup (LS_N_0026);
 * - enter the drop's unloading-point geofence while in_transit_unloading → arrived at drop.
 */
export function tripEventFor(
  transition: GeofenceTransition,
  loadStatus: string | null,
  points: MainTripPoints | null,
): TripEventType | null {
  if (!transition.tripId || !points || !loadStatus) return null;
  const { geofence, event } = transition;
  if (geofence.type === 'loading_point') {
    const isPickup =
      !!geofence.loadingPointId && geofence.loadingPointId === points.pickupLoadingPointId;
    if (!isPickup) return null;
    if (event === 'enter' && isApproachStatus(loadStatus)) return 'trip.arrived_at_pickup';
    if (event === 'exit' && (loadStatus === 'loaded' || loadStatus === IN_TRANSIT_STATUS))
      return 'trip.departed_pickup';
    return null;
  }
  if (
    geofence.type === 'unloading_point' &&
    event === 'enter' &&
    loadStatus === IN_TRANSIT_STATUS
  ) {
    const isDrop =
      (!!geofence.customerDeliveryPointId &&
        geofence.customerDeliveryPointId === points.dropCustomerDeliveryPointId) ||
      (!!geofence.loadingPointId && geofence.loadingPointId === points.dropLoadingPointId);
    return isDrop ? 'trip.arrived_at_drop' : null;
  }
  return null;
}

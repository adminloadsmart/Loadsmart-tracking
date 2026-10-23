import type { MainGeofence, MainTripPoints } from '../main-data';
import { containsPoint } from './geofence.geo';

/** One accepted, non-late fix as the geofence check sees it (device time). */
export interface GeofenceFix {
  t: number;
  lat: number;
  lng: number;
  /** The trip the fix belongs to — its `tripId`, or (`flags.geofenceTripId`) the assigned trip on
   *  the drive to the plant / the delivered trip leaving the delivery point. */
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
  'trip.departed_drop',
] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];

/** Statuses a truck leaving its drop's geofence is departing from: reached it, or E-POD done. */
const AT_OR_PAST_DROP_STATUSES: readonly string[] = [
  'reached_delivery_point',
  'delivered',
  'closed',
];

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
 * - enter the pickup's loading-point geofence while assigned → arrived at pickup ("At plant");
 * - leave it once loading is confirmed (still "loading_confirmed", or already marked in transit)
 *   → departed pickup (LS_N_0026; the main backend moves a loading_confirmed load to in transit);
 * - enter the drop's unloading-point geofence while in transit → arrived at drop;
 * - leave it once there — before the E-POD or after (a delivered load is followed until then, see
 *   trips/trip-state isIndexed) → departed drop (ends unloading detention, LS_N_0032; completes
 *   the trip with the E-POD, LS_N_0033).
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
    if (event === 'enter' && loadStatus === 'assigned') return 'trip.arrived_at_pickup';
    if (event === 'exit' && (loadStatus === 'loading_confirmed' || loadStatus === 'in_transit'))
      return 'trip.departed_pickup';
    return null;
  }
  if (geofence.type === 'unloading_point') {
    const isDrop =
      (!!geofence.customerDeliveryPointId &&
        geofence.customerDeliveryPointId === points.dropCustomerDeliveryPointId) ||
      (!!geofence.loadingPointId && geofence.loadingPointId === points.dropLoadingPointId);
    if (!isDrop) return null;
    if (event === 'enter' && loadStatus === 'in_transit') return 'trip.arrived_at_drop';
    if (event === 'exit' && AT_OR_PAST_DROP_STATUSES.includes(loadStatus))
      return 'trip.departed_drop';
    return null;
  }
  return null;
}

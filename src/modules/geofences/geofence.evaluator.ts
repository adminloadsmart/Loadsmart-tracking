import type { MainGeofence, MainTripPoints } from '../main-data';
import { AFTER_DELIVERY_STATUSES, IN_TRANSIT_STATUS, isApproachStatus } from '../trips/trip-state';
import { haversineMeters } from '../processing/geo';
import { containsPoint } from './geofence.geo';

/** One accepted, non-late fix as the geofence check sees it (device time). */
export interface GeofenceFix {
  t: number;
  lat: number;
  lng: number;
  /** The trip the fix belongs to — its `tripId`, or (`flags.geofenceTripId`) the assigned trip on
   *  the drive to the plant / the delivered trip leaving the delivery point. */
  tripId: string | null;
  /** Speed when the source reports it (driver app, Roadcast; SIM does not). */
  speedKmh?: number | null;
  /** Ignition when the source reports it (Roadcast only). */
  ignition?: boolean | null;
}

/** Inside/outside of one geofence for one vehicle, as of its newest evaluated fix. The dwell
 *  fields are absent on state stored before they existed — read them as null. */
export interface GeofenceMembership {
  inside: boolean;
  enteredAt: number | null;
  lastT: number;
  /** Since when the truck has been continuously stopped (idle / ignition off) inside. */
  stoppedSince?: number | null;
  /** Set once the arrival (stopped for the arrival wait) has been raised for this visit. */
  arrivalAt?: number | null;
  /** Set once the detention has been raised for this visit. */
  detentionAt?: number | null;
  /** Last fix seen inside: where the truck is, and which trip it was on (for time-driven checks). */
  lat?: number;
  lng?: number;
  tripId?: string | null;
}

/** Thresholds of the dwell checks (Super Admin settings later; defaults from the env). */
export interface DwellOptions {
  /** Stopped inside this long = arrived (10 min). */
  arrivalWaitMs: number;
  /** Inside this long = detention (24 h). */
  detentionMs: number;
  /** Below this speed the truck counts as stopped (km/h). */
  stopSpeedKmh: number;
  /** With no speed or ignition (SIM): two inside fixes this close count as the same stop (m). */
  stopRadiusM: number;
  /** Circle geofences without a radius use this (m). */
  defaultRadiusM: number;
}

export const DEFAULT_DWELL_OPTIONS: DwellOptions = {
  arrivalWaitMs: 10 * 60_000,
  detentionMs: 24 * 60 * 60_000,
  stopSpeedKmh: 5,
  stopRadiusM: 150,
  defaultRadiusM: 2000,
};

/** A dwell milestone of a visit: the truck has now been stopped long enough to have arrived, or
 *  inside long enough to be in detention. `t` is deterministic (it does not depend on when the
 *  check ran), so a re-run produces the same event id. */
export interface GeofenceDwell {
  geofence: MainGeofence;
  kind: 'arrival' | 'detention';
  /** When the milestone was reached: stoppedSince + wait, or enteredAt + detention. */
  t: number;
  /** When the visit's stop began (arrival) or when the truck entered (detention). */
  since: number;
  lat: number;
  lng: number;
  tripId: string | null;
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
  /** The truck entered the drop's geofence (immediately: "will reach shortly"). */
  'trip.entered_drop_geofence',
  'trip.arrived_at_drop',
  'trip.departed_drop',
  /** Inside the loading or unloading geofence for more than the detention time. */
  'trip.detention_detected',
] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];

/** Statuses a truck leaving its drop's geofence is departing from: reached it, or delivered. */
const AT_OR_PAST_DROP_STATUSES: readonly string[] = [
  'reached_unloading',
  ...AFTER_DELIVERY_STATUSES,
];

const appliesTo = (geofence: MainGeofence, vehicleId: string) =>
  geofence.appliesToAllVehicles || geofence.vehicleIds.includes(vehicleId);

/** Whether the fix says the truck is stopped: ignition off, or under the stop speed; with
 *  neither (SIM), close to where it was last seen inside (or the first sighting). */
function isStopped(
  fix: GeofenceFix,
  previous: GeofenceMembership | undefined,
  options: DwellOptions,
): boolean {
  if (fix.ignition === false) return true;
  if (fix.speedKmh != null) return fix.speedKmh < options.stopSpeedKmh;
  if (!previous?.inside || previous.lat == null || previous.lng == null) return true;
  return haversineMeters(previous as { lat: number; lng: number }, fix) <= options.stopRadiusM;
}

/** The dwell milestones a visit has reached as of `t`, marking them raised on `membership`. */
function reachedDwells(
  geofence: MainGeofence,
  membership: GeofenceMembership,
  t: number,
  options: DwellOptions,
): GeofenceDwell[] {
  const dwells: GeofenceDwell[] = [];
  const at = {
    lat: membership.lat ?? 0,
    lng: membership.lng ?? 0,
    tripId: membership.tripId ?? null,
  };
  const stoppedSince = membership.stoppedSince ?? null;
  if (
    stoppedSince != null &&
    membership.arrivalAt == null &&
    t - stoppedSince >= options.arrivalWaitMs
  ) {
    const reached = stoppedSince + options.arrivalWaitMs;
    membership.arrivalAt = reached;
    dwells.push({ geofence, kind: 'arrival', t: reached, since: stoppedSince, ...at });
  }
  if (
    membership.enteredAt != null &&
    membership.detentionAt == null &&
    t - membership.enteredAt >= options.detentionMs
  ) {
    const reached = membership.enteredAt + options.detentionMs;
    membership.detentionAt = reached;
    dwells.push({ geofence, kind: 'detention', t: reached, since: membership.enteredAt, ...at });
  }
  return dwells;
}

/** Whether a membership still has a dwell milestone to reach (what the time-driven check scans for). */
export function hasPendingDwell(membership: GeofenceMembership): boolean {
  return membership.inside && (membership.arrivalAt == null || membership.detentionAt == null);
}

/**
 * Runs a vehicle's fixes (device-time order) through its geofences. Pure — the caller loads and
 * persists the state — so a redelivered batch recomputes the same transitions.
 *
 * Same rules the main backend's ping check had: only a change of inside/outside is an event; a
 * fix not newer than the stored state is skipped (late/duplicate); the first sighting of a
 * vehicle against a geofence records where it is but raises no enter (a truck parked inside when
 * the geofence is drawn hasn't "entered" it).
 *
 * On top of that, each visit is timed: the truck has *arrived* once it has been stopped inside for
 * the arrival wait, and is in *detention* once it has been inside for the detention time. Both are
 * raised once per visit, from the first sighting too (a truck already at the plant when it was
 * assigned has arrived).
 */
export function evaluateVehicle(
  vehicleId: string,
  fixes: GeofenceFix[],
  geofences: MainGeofence[],
  stored: VehicleGeofenceState,
  options: DwellOptions = DEFAULT_DWELL_OPTIONS,
): {
  transitions: GeofenceTransition[];
  dwells: GeofenceDwell[];
  state: VehicleGeofenceState;
  changed: string[];
} {
  const state: VehicleGeofenceState = { ...stored };
  const transitions: GeofenceTransition[] = [];
  const dwells: GeofenceDwell[] = [];
  const changed = new Set<string>();

  for (const fix of fixes) {
    for (const geofence of geofences) {
      if (!appliesTo(geofence, vehicleId)) continue;
      const previous = state[geofence.id];
      if (previous && previous.lastT >= fix.t) continue;
      const inside = containsPoint(geofence, fix, options.defaultRadiusM);
      changed.add(geofence.id);
      if (!inside) {
        state[geofence.id] = { inside: false, enteredAt: null, lastT: fix.t };
        if (previous?.inside) {
          transitions.push({
            geofence,
            event: 'exit',
            t: fix.t,
            lat: fix.lat,
            lng: fix.lng,
            tripId: fix.tripId,
          });
        }
        continue;
      }
      const wasInside = previous?.inside ?? false;
      const stopped = isStopped(fix, previous, options);
      const next: GeofenceMembership = {
        inside: true,
        enteredAt: wasInside ? previous!.enteredAt : fix.t,
        lastT: fix.t,
        stoppedSince: stopped ? (wasInside ? (previous!.stoppedSince ?? fix.t) : fix.t) : null,
        arrivalAt: wasInside ? (previous!.arrivalAt ?? null) : null,
        detentionAt: wasInside ? (previous!.detentionAt ?? null) : null,
        lat: fix.lat,
        lng: fix.lng,
        tripId: fix.tripId,
      };
      state[geofence.id] = next;
      if (previous && !wasInside) {
        transitions.push({
          geofence,
          event: 'enter',
          t: fix.t,
          lat: fix.lat,
          lng: fix.lng,
          tripId: fix.tripId,
        });
      }
      dwells.push(...reachedDwells(geofence, next, fix.t, options));
    }
  }
  return { transitions, dwells, state, changed: [...changed] };
}

/**
 * The time-driven half of the dwell check: a truck that stopped inside a geofence stops sending
 * movement, and SIM pings are 10-20 min apart, so the milestones are also checked against the
 * clock. Only a truck seen within `staleMs` is taken to still be there — a silent one is the
 * signal-lost rule's business, not proof of presence. Pure, like evaluateVehicle.
 */
export function advanceDwell(
  geofences: MainGeofence[],
  stored: VehicleGeofenceState,
  nowMs: number,
  staleMs: number,
  options: DwellOptions = DEFAULT_DWELL_OPTIONS,
): { dwells: GeofenceDwell[]; state: VehicleGeofenceState; changed: string[] } {
  const state: VehicleGeofenceState = { ...stored };
  const dwells: GeofenceDwell[] = [];
  const changed: string[] = [];
  for (const geofence of geofences) {
    const membership = state[geofence.id];
    if (!membership || !hasPendingDwell(membership)) continue;
    if (nowMs - membership.lastT > staleMs) continue;
    const next = { ...membership };
    const reached = reachedDwells(geofence, next, nowMs, options);
    if (reached.length === 0) continue;
    state[geofence.id] = next;
    dwells.push(...reached);
    changed.push(geofence.id);
  }
  return { dwells, state, changed };
}

/**
 * The trip step a transition stands for, if any — only when the geofence is linked to this
 * trip's own pickup / drop point, and only from the status the main backend moves on from:
 * - leave the pickup's loading-point geofence once the load is loaded (still "loaded", or already
 *   in_transit_unloading) → departed pickup (LS_N_0026);
 * - enter the drop's unloading-point geofence while in_transit_unloading → entered the drop's
 *   geofence, sent at once ("will reach shortly"; the arrival itself waits, see dwellEventFor);
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
    if (event === 'exit' && (loadStatus === 'loaded' || loadStatus === IN_TRANSIT_STATUS))
      return 'trip.departed_pickup';
    return null;
  }
  if (geofence.type === 'unloading_point') {
    const isDrop =
      (!!geofence.customerDeliveryPointId &&
        geofence.customerDeliveryPointId === points.dropCustomerDeliveryPointId) ||
      (!!geofence.loadingPointId && geofence.loadingPointId === points.dropLoadingPointId);
    if (!isDrop) return null;
    if (event === 'enter' && loadStatus === IN_TRANSIT_STATUS) return 'trip.entered_drop_geofence';
    if (event === 'exit' && AT_OR_PAST_DROP_STATUSES.includes(loadStatus))
      return 'trip.departed_drop';
    return null;
  }
  return null;
}

/** Loading statuses a truck can be waiting inside the pickup's geofence in. */
const AT_PICKUP_STATUSES: readonly string[] = [
  'truck_assigned',
  'in_transit_loading',
  'reached_loading',
  'loaded',
];
/** Unloading statuses a truck can be waiting inside the drop's geofence in. */
const AT_DROP_STATUSES: readonly string[] = [IN_TRANSIT_STATUS, 'reached_unloading'];

/**
 * The trip step a dwell milestone stands for, if any — same linking rules as tripEventFor:
 * - stopped inside the pickup's geofence for the arrival wait, on the approach
 *   (truck_assigned / in_transit_loading) → arrived at pickup (main moves it to reached_loading);
 * - stopped inside the drop's geofence for the arrival wait, while in_transit_unloading
 *   → arrived at drop (main records it against the appointment slot);
 * - inside either for the detention time → detention detected; `point` says which one.
 */
export function dwellEventFor(
  dwell: GeofenceDwell,
  loadStatus: string | null,
  points: MainTripPoints | null,
): { type: TripEventType; point: 'loading' | 'unloading' } | null {
  if (!dwell.tripId || !points || !loadStatus) return null;
  const { geofence, kind } = dwell;
  if (geofence.type === 'loading_point') {
    const isPickup =
      !!geofence.loadingPointId && geofence.loadingPointId === points.pickupLoadingPointId;
    if (!isPickup) return null;
    if (kind === 'arrival' && isApproachStatus(loadStatus)) {
      return { type: 'trip.arrived_at_pickup', point: 'loading' };
    }
    if (kind === 'detention' && AT_PICKUP_STATUSES.includes(loadStatus)) {
      return { type: 'trip.detention_detected', point: 'loading' };
    }
    return null;
  }
  if (geofence.type === 'unloading_point') {
    const isDrop =
      (!!geofence.customerDeliveryPointId &&
        geofence.customerDeliveryPointId === points.dropCustomerDeliveryPointId) ||
      (!!geofence.loadingPointId && geofence.loadingPointId === points.dropLoadingPointId);
    if (!isDrop) return null;
    if (kind === 'arrival' && loadStatus === IN_TRANSIT_STATUS) {
      return { type: 'trip.arrived_at_drop', point: 'unloading' };
    }
    if (kind === 'detention' && AT_DROP_STATUSES.includes(loadStatus)) {
      return { type: 'trip.detention_detected', point: 'unloading' };
    }
  }
  return null;
}

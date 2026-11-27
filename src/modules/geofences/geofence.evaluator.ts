import type { MainGeofence, MainTripPoints } from '../main-data';
import { AFTER_DELIVERY_STATUSES, IN_TRANSIT_STATUS, isApproachStatus } from '../trips/trip-state';
import { haversineMeters } from '../processing/geo';
import { containsPoint, mayContain } from './geofence.geo';

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
  /** Fixes seen inside on this visit (a created trip completes on the second one at its drop). */
  fixes?: number;
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

/** Per vehicle: geofence id → membership. Only visits in progress (inside) are kept: a geofence
 *  with no entry is outside, or not yet seen (see VehicleGeofenceMeta). State written before that
 *  also holds outside entries; they read the same and are dropped as the vehicle is evaluated. */
export type VehicleGeofenceState = Record<string, GeofenceMembership>;

/** Per vehicle, beside the memberships. */
export interface VehicleGeofenceMeta {
  /** Device time of the newest evaluated fix: older ones are late / duplicates and skipped. */
  lastT: number | null;
  /** When the geofence list of the last evaluation was loaded: every geofence created before it
   *  was evaluated then, so having no entry means it is known to be outside. One created later
   *  is still unseen — its first sighting raises no event. */
  listAt: number | null;
}

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
  meta: Partial<VehicleGeofenceMeta> = {},
  /** When `geofences` was loaded — stored as the next evaluation's `meta.listAt`. */
  listAt: number | null = null,
): {
  transitions: GeofenceTransition[];
  dwells: GeofenceDwell[];
  /** Visits in progress only. */
  state: VehicleGeofenceState;
  /** Memberships to write. */
  changed: string[];
  /** Entries to delete: visits that ended, and outside entries of the old state format. */
  removed: string[];
  meta: VehicleGeofenceMeta;
} {
  const state: VehicleGeofenceState = {};
  let lastT = meta.lastT ?? null;
  for (const [id, membership] of Object.entries(stored)) {
    if (membership.inside) state[id] = membership;
    // The old format kept a per-geofence lastT: the newest of them is the vehicle's.
    lastT = lastT === null ? membership.lastT : Math.max(lastT, membership.lastT);
  }
  const transitions: GeofenceTransition[] = [];
  const dwells: GeofenceDwell[] = [];
  const changed = new Set<string>();
  const removed = new Set(Object.keys(stored).filter((id) => !stored[id].inside));
  // Outside geofences known from before: old-format entries, or created before the last list.
  const knownOutside = (geofence: MainGeofence) =>
    geofence.id in stored || (meta.listAt != null && (geofence.createdAtMs ?? 0) < meta.listAt);
  let evaluated = false;

  for (const fix of fixes) {
    if (lastT !== null && fix.t <= lastT) continue;
    for (const geofence of geofences) {
      if (!appliesTo(geofence, vehicleId)) continue;
      const previous = state[geofence.id];
      const wasInside = previous?.inside ?? false;
      // Cheap bounding-box test first: most geofences are nowhere near the truck.
      const inside =
        (wasInside || mayContain(geofence, fix, options.defaultRadiusM)) &&
        containsPoint(geofence, fix, options.defaultRadiusM);
      if (!inside) {
        if (wasInside) {
          delete state[geofence.id];
          changed.delete(geofence.id);
          removed.add(geofence.id);
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
      const stopped = isStopped(fix, previous, options);
      const next: GeofenceMembership = {
        inside: true,
        enteredAt: wasInside ? previous!.enteredAt : fix.t,
        lastT: fix.t,
        stoppedSince: stopped ? (wasInside ? (previous!.stoppedSince ?? fix.t) : fix.t) : null,
        arrivalAt: wasInside ? (previous!.arrivalAt ?? null) : null,
        detentionAt: wasInside ? (previous!.detentionAt ?? null) : null,
        fixes: wasInside ? (previous!.fixes ?? 1) + 1 : 1,
        lat: fix.lat,
        lng: fix.lng,
        tripId: fix.tripId,
      };
      state[geofence.id] = next;
      changed.add(geofence.id);
      removed.delete(geofence.id);
      // The first sighting of a geofence records where the truck is but is no "enter".
      if (!wasInside && (evaluated || knownOutside(geofence))) {
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
    lastT = fix.t;
    evaluated = true;
  }
  return {
    transitions,
    dwells,
    state,
    changed: [...changed],
    removed: [...removed],
    meta: { lastT, listAt: evaluated ? listAt : (meta.listAt ?? null) },
  };
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
 * Which of this trip's own places a geofence is: its pickup, its drop, or neither.
 * - A load's pickup is its loading point's geofence; its drop the customer delivery point's (or,
 *   for a posted load with no customer, the shipper's own loading point on an unloading geofence).
 * - A trip created from the tracking screen may also start at a customer address (an inbound
 *   trip) or end at a loading point.
 */
export function tripPlaceOf(
  geofence: MainGeofence,
  points: MainTripPoints,
): 'pickup' | 'drop' | null {
  const created = !!points.createdTrip;
  const loadingPoint = geofence.loadingPointId;
  const deliveryPoint = geofence.customerDeliveryPointId;
  if (geofence.type === 'loading_point') {
    if (!!loadingPoint && loadingPoint === points.pickupLoadingPointId) return 'pickup';
    if (created && !!loadingPoint && loadingPoint === points.dropLoadingPointId) return 'drop';
    return null;
  }
  if (geofence.type === 'unloading_point') {
    if (created && !!deliveryPoint && deliveryPoint === points.pickupCustomerDeliveryPointId)
      return 'pickup';
    const isDrop =
      (!!deliveryPoint && deliveryPoint === points.dropCustomerDeliveryPointId) ||
      (!!loadingPoint && loadingPoint === points.dropLoadingPointId);
    return isDrop ? 'drop' : null;
  }
  return null;
}

/** A created trip heading to, or at, its pickup (createdTripLoadStatus). */
const CREATED_TRIP_PICKUP_STATUSES: readonly string[] = ['in_transit_loading', 'reached_loading'];
/** Statuses a truck leaving its pickup's geofence departs from: a load once it is loaded (main
 *  moves it on from there), a created trip — which has no loading step — while heading to it. */
const departsPickupFrom = (created: boolean): readonly string[] =>
  created ? CREATED_TRIP_PICKUP_STATUSES : ['loaded', IN_TRANSIT_STATUS];
/** A created trip still counted as heading to its pickup (the truck never seen leaving it, e.g.
 *  created mid-journey) is taken to be on the road to the drop once it gets there. */
const towardsDropIn = (created: boolean): readonly string[] =>
  created ? [IN_TRANSIT_STATUS, ...CREATED_TRIP_PICKUP_STATUSES] : [IN_TRANSIT_STATUS];

/**
 * The trip step a transition stands for, if any — only when the geofence is this trip's own
 * pickup / drop (tripPlaceOf), and only from the status the main backend moves on from:
 * - leave the pickup's geofence once the load is loaded (still "loaded", or already
 *   in_transit_unloading) → departed pickup (LS_N_0026); a created trip departs while heading to
 *   it, and is on the road to its drop from then on;
 * - enter the drop's geofence while in_transit_unloading → entered the drop's geofence, sent at
 *   once ("will reach shortly"; the arrival itself waits, see dwellEventFor);
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
  const created = !!points.createdTrip;
  const place = tripPlaceOf(geofence, points);
  if (place === 'pickup') {
    if (event === 'exit' && departsPickupFrom(created).includes(loadStatus))
      return 'trip.departed_pickup';
    return null;
  }
  if (place === 'drop') {
    if (event === 'enter' && towardsDropIn(created).includes(loadStatus))
      return 'trip.entered_drop_geofence';
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
  const created = !!points.createdTrip;
  const place = tripPlaceOf(geofence, points);
  if (place === 'pickup') {
    if (kind === 'arrival' && isApproachStatus(loadStatus)) {
      return { type: 'trip.arrived_at_pickup', point: 'loading' };
    }
    if (kind === 'detention' && AT_PICKUP_STATUSES.includes(loadStatus)) {
      return { type: 'trip.detention_detected', point: 'loading' };
    }
    return null;
  }
  if (place === 'drop') {
    if (kind === 'arrival' && towardsDropIn(created).includes(loadStatus)) {
      return { type: 'trip.arrived_at_drop', point: 'unloading' };
    }
    const atDrop = created
      ? [...AT_DROP_STATUSES, ...CREATED_TRIP_PICKUP_STATUSES]
      : AT_DROP_STATUSES;
    if (kind === 'detention' && atDrop.includes(loadStatus)) {
      return { type: 'trip.detention_detected', point: 'unloading' };
    }
  }
  return null;
}

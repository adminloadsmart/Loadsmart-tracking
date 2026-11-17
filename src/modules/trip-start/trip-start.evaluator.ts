import { haversineMeters } from '../processing/geo';

/** One accepted, non-late fix of a trip, as the start check sees it (device time). */
export interface TripStartFix {
  t: number;
  lat: number;
  lng: number;
  source: string;
}

export interface TripStartOptions {
  /** The truck has started once it is this far from where it was when assigned (m). */
  distanceM: number;
  /** SIM positions are coarse and 10-20 min apart: this many distinct pings must be that far
   *  before the trip counts as started (a single odd cell-tower fix is not movement). */
  simMinPings: number;
}

export const DEFAULT_TRIP_START_OPTIONS: TripStartOptions = {
  distanceM: 3000,
  simMinPings: 2,
};

/** Per trip and truck assignment: where the truck was, and the pings seen since that were far. */
export interface TripStartState {
  /** The load's truck_assigned_at (epoch ms): a new assignment starts the check over. */
  assignment: number;
  vehicleId: string;
  anchor: { lat: number; lng: number; t: number };
  /** Consecutive pings beyond the start distance (cleared when one falls back inside). */
  far: Array<{ t: number; lat: number; lng: number; source: string }>;
  lastT: number;
  /** The start was raised for this assignment. */
  fired: boolean;
}

export interface TripStarted {
  /** When the truck was first seen beyond the start distance. */
  t: number;
  lat: number;
  lng: number;
  /** Straight-line distance from where it was assigned, at the confirming ping (m). */
  distanceM: number;
  source: string;
  pings: number;
  from: { lat: number; lng: number; t: number };
}

/**
 * Has this truck moved the start distance from where it was when the trip was assigned? Pure,
 * like the geofence evaluator: the caller loads and persists the state, so a redelivered batch
 * recomputes the same result.
 *
 * The first fix after the assignment is where the truck was. A GPS or phone fix beyond the
 * distance starts the trip at once; a SIM trip needs `simMinPings` distinct pings beyond it, in
 * a row. Raised once per assignment.
 */
export function evaluateTripStart(
  stored: TripStartState | null,
  context: { assignment: number; vehicleId: string },
  fixes: TripStartFix[],
  options: TripStartOptions = DEFAULT_TRIP_START_OPTIONS,
): { state: TripStartState | null; started: TripStarted | null } {
  let state: TripStartState | null =
    stored && stored.assignment === context.assignment && stored.vehicleId === context.vehicleId
      ? { ...stored, far: [...stored.far] }
      : null;
  let started: TripStarted | null = null;

  for (const fix of [...fixes].sort((a, b) => a.t - b.t)) {
    if (!state) {
      state = {
        assignment: context.assignment,
        vehicleId: context.vehicleId,
        anchor: { lat: fix.lat, lng: fix.lng, t: fix.t },
        far: [],
        lastT: fix.t,
        fired: false,
      };
      continue;
    }
    if (state.fired || fix.t <= state.lastT) continue;
    state.lastT = fix.t;
    const distanceM = haversineMeters(state.anchor, fix);
    if (distanceM < options.distanceM) {
      state.far = [];
      continue;
    }
    state.far.push({ t: fix.t, lat: fix.lat, lng: fix.lng, source: fix.source });
    const needed = fix.source === 'sim' ? options.simMinPings : 1;
    if (state.far.length >= needed) {
      state.fired = true;
      started = {
        t: state.far[0].t,
        lat: fix.lat,
        lng: fix.lng,
        distanceM,
        source: fix.source,
        pings: state.far.length,
        from: state.anchor,
      };
    }
  }
  return { state, started };
}

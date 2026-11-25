import { uuidV5 } from '../../shared/utils/uuid';
/** loads.loads.status in the main backend (its LOAD_STATUSES), in lifecycle order. */
export const LOAD_STATUSES = [
  'created',
  'bids_received',
  'truck_assigned',
  'in_transit_loading',
  'reached_loading',
  'loaded',
  'in_transit_unloading',
  'reached_unloading',
  'delivered_ok',
  'delivered_with_issues',
  'invoice_generated',
  'payment',
  'closed',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

export type TrackingState = 'pending' | 'active' | 'ended';

export const ACTIVE_STATUSES: readonly LoadStatus[] = [
  'truck_assigned',
  'in_transit_loading',
  'reached_loading',
  'loaded',
  'in_transit_unloading',
  'reached_unloading',
];
const ENDED_STATUSES: readonly LoadStatus[] = [
  'delivered_ok',
  'delivered_with_issues',
  'invoice_generated',
  'payment',
  'closed',
];

/**
 * A trip is tracked only through the source its load names in loads.tracking_source (gps → the
 * Roadcast device, driver_app → the phone, sim → SIM). Unset, or FASTag (no points of its own),
 * puts no restriction on the source.
 */
/**
 * A market or indent load: its driver works for the transporter, not the shipper, so their app
 * token never carries the load's tenant. The load naming them as its driver (loads.driver_id) is
 * what lets their points in. Unknown (null) counts as own fleet.
 */
export function isPlacedTruckLoad(postingType: string | null | undefined): boolean {
  return !!postingType && postingType !== 'own_fleet';
}

export function isTrackingSource(
  trackingSource: string | null | undefined,
  pointSource: 'driver_app' | 'roadcast' | 'sim',
): boolean {
  const wanted = { gps: 'roadcast', driver_app: 'driver_app', sim: 'sim' }[trackingSource ?? ''];
  return !wanted || wanted === pointSource;
}

/**
 * How far a load has got in the stages where a pending SIM consent is re-checked: 1 heading to
 * the plant (in_transit_loading), 2 at the plant (reached_loading, loaded), 3 on the road to the
 * drop (in_transit_unloading onwards). 0 before that. A skipped status counts as passed.
 */
export function consentStageOf(status: LoadStatus): number {
  switch (status) {
    case 'in_transit_loading':
      return 1;
    case 'reached_loading':
    case 'loaded':
      return 2;
    case 'in_transit_unloading':
    case 'reached_unloading':
      return 3;
    default:
      return 0;
  }
}

/** The truck is on the road between plant and delivery point — the rules that need movement. */
export const IN_TRANSIT_STATUS: LoadStatus = 'in_transit_unloading';

/**
 * The drive to the plant: a truck is on the load (truck_assigned) and, once the driver or staff
 * mark it, heading to loading (in_transit_loading). Tracked like the rest of the trip; the
 * geofence check uses the status to see the truck arrive at the plant.
 */
export const APPROACH_STATUSES: readonly LoadStatus[] = ['truck_assigned', 'in_transit_loading'];
export function isApproachStatus(status: string | null | undefined): boolean {
  return !!status && (APPROACH_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses a delivered load is in while it's followed to its exit from the delivery point — the
 * ended statuses (an own-fleet load can close right after its E-POD is accepted).
 */
export const AFTER_DELIVERY_STATUSES: readonly LoadStatus[] = ENDED_STATUSES;

/** How long a delivered load is followed for that exit (the main backend's LS_N_0032 / LS_N_0033
 *  stop waiting for it after the same time — its TRIP_COMPLETED_FALLBACK_MS). */
export const DELIVERED_FOLLOW_MS = 24 * 60 * 60_000;

/**
 * Indexed only for the geofence check, outside the tracked window: leaving the delivery point
 * after the E-POD. Points then carry the trip only as `flags.geofenceTripId` (not `tripId`), so
 * they never join the trip's track, distance or alert rules; the geofence check uses them to see
 * the truck leave the drop.
 */
export const GEOFENCE_ONLY_STATUSES: readonly LoadStatus[] = AFTER_DELIVERY_STATUSES;

/** Takes a raw status (e.g. read back from Redis), so callers don't have to cast it. */
export const isAfterDelivery = (status: string | null | undefined): boolean =>
  (AFTER_DELIVERY_STATUSES as readonly string[]).includes(status ?? '');

/** Takes a raw status (e.g. read back from Redis), so callers don't have to cast it. */
export const isGeofenceOnly = (status: string | null | undefined): boolean =>
  (GEOFENCE_ONLY_STATUSES as readonly string[]).includes(status ?? '');

/** Statuses the active-trip index follows: the tracked ones. A delivered load is followed too,
 *  until its truck leaves the delivery point (see isIndexed). */
export const INDEXED_STATUSES: readonly LoadStatus[] = ACTIVE_STATUSES;

/** Whether the active-trip index holds this load right now: an indexed status, or delivered but
 *  not yet seen leaving the delivery point, within DELIVERED_FOLLOW_MS of the E-POD. */
export function isIndexed(
  load: { status: LoadStatus; deliveredAt: Date | null; departedDropAt: Date | null },
  nowMs: number,
): boolean {
  if (INDEXED_STATUSES.includes(load.status)) return true;
  return (
    isAfterDelivery(load.status) &&
    !load.departedDropAt &&
    !!load.deliveredAt &&
    nowMs - load.deliveredAt.getTime() < DELIVERED_FOLLOW_MS
  );
}

/**
 * Tracking runs from truck assignment until delivery; after it, the load's tracking is done (the
 * vehicle timeline keeps going).
 */
export function trackingStateFor(status: LoadStatus, deleted: boolean): TrackingState {
  if (deleted || ENDED_STATUSES.includes(status)) return 'ended';
  if (ACTIVE_STATUSES.includes(status)) return 'active';
  return 'pending';
}

// Fixed namespace for market-vehicle ids — never change it, or every market truck gets a new id.
const MARKET_VEHICLE_NAMESPACE = '6f1c2a3e-8d4b-5f7a-9c1e-2b3d4f5a6b7c';

export function normalizePlate(plate: string): string {
  return plate.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Market trucks aren't in the vehicle master — a load only carries their free-text plate. Derive
 * a stable tracking vehicle id from tenant + normalized plate (UUIDv5, RFC 9562) so the same
 * truck maps to the same vehicle across loads and points partition consistently.
 */
export function marketVehicleId(tenantId: string, plate: string): string {
  return uuidV5(MARKET_VEHICLE_NAMESPACE, `${tenantId.toLowerCase()}:${normalizePlate(plate)}`);
}

/**
 * How a truck can be tracked, best first — the main backend's initialTrackingSource
 * (loads/utils/tracking-source.ts), applied here to trips created from the tracking screen: the
 * fleet vehicle's GPS device (has_gps + gps_enabled), else the driver's app (their account has
 * logged in at least once), else SIM on a valid mobile number, else FASTag on the plate.
 */
export function initialTrackingSource(truck: {
  hasGps: boolean;
  hasDriverApp: boolean;
  hasDriverNumber: boolean;
  hasVehicleNumber: boolean;
}): 'gps' | 'driver_app' | 'sim' | 'fastag' | null {
  if (truck.hasGps) return 'gps';
  if (truck.hasDriverApp) return 'driver_app';
  if (truck.hasDriverNumber) return 'sim';
  if (truck.hasVehicleNumber) return 'fastag';
  return null;
}

/**
 * The load status a trip created from the tracking screen counts as. It has no stages of its own:
 * an active one is on the road to its destination (so the in-transit rules — halts, signal loss,
 * arrival at the drop — apply), an ended or cancelled one is closed (out of the index).
 */
export function createdTripLoadStatus(status: 'active' | 'ended' | 'cancelled'): LoadStatus {
  return status === 'active' ? IN_TRANSIT_STATUS : 'closed';
}

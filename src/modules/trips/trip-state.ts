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
  'original_pod_received',
  'invoice_generated',
  'payment',
  'closed',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

export type TrackingState = 'pending' | 'active' | 'ended';

export const ACTIVE_STATUSES: readonly LoadStatus[] = [
  'reached_loading',
  'loaded',
  'in_transit_unloading',
  'reached_unloading',
];
const ENDED_STATUSES: readonly LoadStatus[] = [
  'delivered_ok',
  'delivered_with_issues',
  'original_pod_received',
  'invoice_generated',
  'payment',
  'closed',
];

/**
 * A trip is tracked only through the source its load names in loads.tracking_source (gps → the
 * Roadcast device, driver_app → the phone, sim → SIM). Unset, or FASTag (no points of its own),
 * puts no restriction on the source.
 */
export function isTrackingSource(
  trackingSource: string | null | undefined,
  pointSource: 'driver_app' | 'roadcast' | 'sim',
): boolean {
  const wanted = { gps: 'roadcast', driver_app: 'driver_app', sim: 'sim' }[trackingSource ?? ''];
  return !wanted || wanted === pointSource;
}

/** The truck is on the road between plant and delivery point — the rules that need movement. */
export const IN_TRANSIT_STATUS: LoadStatus = 'in_transit_unloading';

/**
 * The drive to the plant: a truck is on the load (truck_assigned) and, once the driver or staff
 * mark it, heading to loading (in_transit_loading). See GEOFENCE_ONLY_STATUSES.
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
 * Indexed only for the geofence check, outside the tracked window: the drive to the plant and
 * leaving the delivery point after the E-POD. Points then carry the trip only as
 * `flags.geofenceTripId` (not `tripId`), so they never join the trip's track, distance or alert
 * rules; the geofence check uses them to see the truck arrive at the plant / leave the drop.
 */
export const GEOFENCE_ONLY_STATUSES: readonly LoadStatus[] = [
  ...APPROACH_STATUSES,
  ...AFTER_DELIVERY_STATUSES,
];

/** Takes a raw status (e.g. read back from Redis), so callers don't have to cast it. */
export const isAfterDelivery = (status: string | null | undefined): boolean =>
  (AFTER_DELIVERY_STATUSES as readonly string[]).includes(status ?? '');

/** Takes a raw status (e.g. read back from Redis), so callers don't have to cast it. */
export const isGeofenceOnly = (status: string | null | undefined): boolean =>
  (GEOFENCE_ONLY_STATUSES as readonly string[]).includes(status ?? '');

/** Statuses the active-trip index follows: the tracked ones plus the approach. A delivered load
 *  is followed too, until its truck leaves the delivery point (see isIndexed). */
export const INDEXED_STATUSES: readonly LoadStatus[] = [...APPROACH_STATUSES, ...ACTIVE_STATUSES];

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
 * Tracking runs from reaching the plant until delivery: before that the truck is still on the
 * approach; after it, the load's tracking is done (the vehicle timeline keeps going).
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

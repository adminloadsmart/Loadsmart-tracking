import { uuidV5 } from '../../shared/utils/uuid';
/** loads.loads.status in the main backend (its LOAD_STATUSES), in lifecycle order. */
export const LOAD_STATUSES = [
  'created',
  'assigned',
  'loading_confirmed',
  'at_plant',
  'in_transit',
  'reached_delivery_point',
  'delivered',
  'closed',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

export type TrackingState = 'pending' | 'active' | 'ended';

export const ACTIVE_STATUSES: readonly LoadStatus[] = [
  'loading_confirmed',
  'at_plant',
  'in_transit',
  'reached_delivery_point',
];
const ENDED_STATUSES: readonly LoadStatus[] = ['delivered', 'closed'];

/**
 * Statuses the active-trip index follows: the tracked ones plus "assigned" — the drive to the
 * plant. A delivered load is followed too, until its truck leaves the delivery point (see
 * isIndexed).
 */
export const INDEXED_STATUSES: readonly LoadStatus[] = ['assigned', ...ACTIVE_STATUSES];

/** Statuses a delivered load is in while it's followed to its exit from the delivery point — an
 *  own-fleet load can close right after its E-POD is accepted. */
export const AFTER_DELIVERY_STATUSES: readonly LoadStatus[] = ['delivered', 'closed'];

/** How long a delivered load is followed for that exit (the main backend's LS_N_0032 / LS_N_0033
 *  stop waiting for it after the same time — its TRIP_COMPLETED_FALLBACK_MS). */
export const DELIVERED_FOLLOW_MS = 24 * 60 * 60_000;

/**
 * Indexed only for the geofence check, outside the tracked window: the drive to the plant
 * ("assigned") and leaving the delivery point after the E-POD. Points then carry the trip only as
 * `flags.geofenceTripId` (not `tripId`), so they never join the trip's track, distance or alert
 * rules; the geofence check uses them to see the truck arrive at the plant / leave the drop.
 */
export const GEOFENCE_ONLY_STATUSES: readonly LoadStatus[] = [
  'assigned',
  ...AFTER_DELIVERY_STATUSES,
];

/** Takes a raw status (e.g. read back from Redis), so callers don't have to cast it. */
export const isAfterDelivery = (status: string | null): boolean =>
  (AFTER_DELIVERY_STATUSES as readonly string[]).includes(status ?? '');

/** Takes a raw status (e.g. read back from Redis), so callers don't have to cast it. */
export const isGeofenceOnly = (status: string | null): boolean =>
  (GEOFENCE_ONLY_STATUSES as readonly string[]).includes(status ?? '');

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
 * Tracking runs from loading confirmation until delivery: before that the truck may not even be
 * at the plant yet; after it, the load's tracking is done (the vehicle timeline keeps going).
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

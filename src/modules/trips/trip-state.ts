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
 * plant. Points from that approach carry the trip only as `flags.approachTripId` (not `tripId`),
 * so they never join the trip's track, distance or alert rules; the geofence check uses them to
 * see the truck arrive at the plant.
 */
export const INDEXED_STATUSES: readonly LoadStatus[] = ['assigned', ...ACTIVE_STATUSES];
export const APPROACH_STATUS: LoadStatus = 'assigned';

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

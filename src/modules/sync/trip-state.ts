import { createHash } from 'crypto';
import { LoadStatus } from './sync.contract';

export type TrackingState = 'pending' | 'active' | 'ended';

const ACTIVE_STATUSES: readonly LoadStatus[] = [
  'loading_confirmed',
  'at_plant',
  'in_transit',
  'reached_delivery_point',
];
const ENDED_STATUSES: readonly LoadStatus[] = ['delivered', 'closed'];

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
  const namespace = Buffer.from(MARKET_VEHICLE_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(namespace)
    .update(`${tenantId.toLowerCase()}:${normalizePlate(plate)}`)
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

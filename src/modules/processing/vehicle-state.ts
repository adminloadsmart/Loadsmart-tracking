import type { PointSource } from '../points/point.contract';

export type Motion = 'moving' | 'halted';

/**
 * Last accepted position of one vehicle FROM ONE SOURCE. Kept per source because the phone and
 * the BR05 report slightly different positions — mixing them would look like jitter/jumps and
 * double-count distance. Choosing which source is authoritative for a trip is the waterfall's job
 * (Phase 6).
 */
export interface VehicleState {
  lat: number;
  lng: number;
  /** Epoch ms of the last accepted point (stationary points advance it too). */
  recordedAtMs: number;
  speedKmh: number | null;
  motion: Motion;
  /** Epoch ms since which speed has stayed below the moving threshold; null while moving. */
  slowSinceMs: number | null;
  tripId: string | null;
}

export interface StateKey {
  vehicleId: string;
  source: PointSource;
}

export const stateMapKey = ({ vehicleId, source }: StateKey) => `${vehicleId}|${source}`;

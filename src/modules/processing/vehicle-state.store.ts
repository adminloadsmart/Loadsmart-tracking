import type Redis from 'ioredis';
import type { PointSource } from '../points/point.contract';
import { StateKey, stateMapKey, VehicleState } from './vehicle-state';

export const vehicleSourceStateKey = (vehicleId: string, source: PointSource) =>
  `trk:veh:${vehicleId}:src:${source}`;
/** Latest accepted position of the vehicle from any source — what the live map reads (Phase 3). */
export const vehicleLatestKey = (vehicleId: string) => `trk:veh:${vehicleId}:latest`;
export const tripMetricsKey = (tripId: string) => `trk:trip:${tripId}:metrics`;
export const tripFraudKey = (tripId: string) => `trk:trip:${tripId}:fraud`;

export interface LatestPosition {
  lat: number;
  lng: number;
  recordedAt: string;
  source: PointSource;
  speedKmh: number | null;
  heading: number | null;
  motion: string;
  tripId: string | null;
}

export interface PersistInput {
  states: Map<string, VehicleState>;
  latest: Map<string, LatestPosition>;
  distance: Map<string, number>;
  mockLocationTrips: Set<string>;
}

/**
 * Redis-backed per-vehicle processing state. Read fresh for every batch (one pipeline) rather
 * than cached in memory, so a partition moving to another processor never sees stale state.
 * persist() is a MULTI/EXEC transaction: state and distance land together or not at all, so a
 * retried batch recomputes exactly the same increments.
 */
export class VehicleStateStore {
  constructor(private readonly redis: Redis) {}

  async load(keys: StateKey[]): Promise<Map<string, VehicleState>> {
    const unique = [...new Map(keys.map((key) => [stateMapKey(key), key])).values()];
    if (unique.length === 0) return new Map();

    const pipeline = this.redis.pipeline();
    for (const { vehicleId, source } of unique)
      pipeline.hgetall(vehicleSourceStateKey(vehicleId, source));
    const results = (await pipeline.exec()) ?? [];

    const states = new Map<string, VehicleState>();
    unique.forEach((key, index) => {
      const [err, raw] = results[index] ?? [];
      if (err) throw err;
      const hash = raw as Record<string, string>;
      if (!hash || !hash.recordedAtMs) return;
      states.set(stateMapKey(key), {
        lat: Number(hash.lat),
        lng: Number(hash.lng),
        recordedAtMs: Number(hash.recordedAtMs),
        speedKmh: hash.speedKmh ? Number(hash.speedKmh) : null,
        motion: hash.motion === 'moving' ? 'moving' : 'halted',
        slowSinceMs: hash.slowSinceMs ? Number(hash.slowSinceMs) : null,
        tripId: hash.tripId || null,
      });
    });
    return states;
  }

  async persist({ states, latest, distance, mockLocationTrips }: PersistInput): Promise<void> {
    if (
      states.size === 0 &&
      latest.size === 0 &&
      distance.size === 0 &&
      mockLocationTrips.size === 0
    ) {
      return;
    }
    const multi = this.redis.multi();
    for (const [key, state] of states) {
      const [vehicleId, source] = key.split('|') as [string, PointSource];
      multi.hset(vehicleSourceStateKey(vehicleId, source), {
        lat: state.lat,
        lng: state.lng,
        recordedAtMs: state.recordedAtMs,
        speedKmh: state.speedKmh ?? '',
        motion: state.motion,
        slowSinceMs: state.slowSinceMs ?? '',
        tripId: state.tripId ?? '',
      });
    }
    for (const [vehicleId, position] of latest) {
      multi.hset(vehicleLatestKey(vehicleId), {
        lat: position.lat,
        lng: position.lng,
        recordedAt: position.recordedAt,
        source: position.source,
        speedKmh: position.speedKmh ?? '',
        heading: position.heading ?? '',
        motion: position.motion,
        tripId: position.tripId ?? '',
      });
    }
    for (const [key, meters] of distance) {
      const [tripId, source] = key.split('|');
      multi.hincrbyfloat(tripMetricsKey(tripId), `distance_m:${source}`, meters);
    }
    for (const tripId of mockLocationTrips) multi.sadd(tripFraudKey(tripId), 'mock_location');

    const results = await multi.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }
}

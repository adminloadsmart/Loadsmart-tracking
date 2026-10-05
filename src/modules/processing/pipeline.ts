import type { NormalizedPoint } from '../points/point.contract';
import { cleanPoint, measureMovement, nextMotion, ProcessingOptions, RejectReason } from './steps';
import { stateMapKey, VehicleState } from './vehicle-state';

export interface ProcessedPoint {
  point: NormalizedPoint;
  rejected: RejectReason | null;
}

export interface PipelineResult {
  points: ProcessedPoint[];
  /** Updated state per vehicle|source (only keys that changed). */
  states: Map<string, VehicleState>;
  /** Metres to add per trip and source: key `${tripId}|${source}`. */
  distance: Map<string, number>;
  /** Trips whose phone reported a mock location. */
  mockLocationTrips: Set<string>;
}

/**
 * Runs clean → movement → motion → distance over one stream batch. Pure: takes the stored state
 * in, returns new state and side effects out, so the caller can persist everything atomically and
 * a redelivered batch recomputes the same result.
 *
 * Points are processed per vehicle|source in recordedAt order. A point not newer than the
 * current state is LATE (offline batch flushed after newer fixes, or a redelivery): it is stored
 * for the track but never moves the state or adds distance — that is what makes replays free.
 */
export function runPipeline(
  points: NormalizedPoint[],
  initialStates: Map<string, VehicleState>,
  nowMs: number,
  options: ProcessingOptions,
): PipelineResult {
  const states = new Map(initialStates);
  const changed = new Map<string, VehicleState>();
  const distance = new Map<string, number>();
  const mockLocationTrips = new Set<string>();
  const results = new Map<NormalizedPoint, ProcessedPoint>();

  const ordered = [...points].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));

  for (const point of ordered) {
    const key = stateMapKey(point);
    const previous = states.get(key) ?? null;
    const recordedAtMs = Date.parse(point.recordedAt);
    const flags: Record<string, unknown> = { ...(point.flags ?? {}) };

    const rejected = cleanPoint(point, previous, nowMs, options);
    if (rejected) {
      flags.rejected = rejected;
      if (rejected === 'mock_location' && point.tripId) mockLocationTrips.add(point.tripId);
      results.set(point, { point: { ...point, flags }, rejected });
      continue;
    }

    if (previous && recordedAtMs <= previous.recordedAtMs) {
      flags.late = true;
      results.set(point, { point: { ...point, flags }, rejected: null });
      continue;
    }

    const movement = measureMovement(point, previous, options);
    const { motion, slowSinceMs } = nextMotion(previous, recordedAtMs, movement.speedKmh, options);
    flags.motion = motion;
    if (movement.stationary) flags.stationary = true;

    // Distance only between consecutive fixes of the same trip from a GPS source.
    if (
      movement.distanceM > 0 &&
      point.tripId &&
      point.source !== 'sim' &&
      previous?.tripId === point.tripId
    ) {
      const distanceKey = `${point.tripId}|${point.source}`;
      distance.set(distanceKey, (distance.get(distanceKey) ?? 0) + movement.distanceM);
    }

    const next: VehicleState = {
      // A stationary fix keeps the anchor position (so drift can't creep), but time advances.
      lat: movement.stationary && previous ? previous.lat : point.lat,
      lng: movement.stationary && previous ? previous.lng : point.lng,
      recordedAtMs,
      speedKmh: movement.speedKmh,
      motion,
      slowSinceMs,
      tripId: point.tripId ?? null,
    };
    states.set(key, next);
    changed.set(key, next);
    results.set(point, { point: { ...point, flags }, rejected: null });
  }

  return {
    // Original stream order for the caller.
    points: points.map((point) => results.get(point)!),
    states: changed,
    distance,
    mockLocationTrips,
  };
}

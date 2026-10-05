import type { NormalizedPoint } from '../points/point.contract';
import { haversineMeters, impliedSpeedKmh } from './geo';
import { Motion, VehicleState } from './vehicle-state';

export interface ProcessingOptions {
  /** Phone fixes with a worse reported accuracy are rejected. */
  maxAccuracyM: number;
  /** Implied speed between consecutive fixes above this is a GPS jump, not driving. */
  maxPlausibleSpeedKmh: number;
  /** Device clocks ahead of server time by more than this are rejected. */
  maxFutureSkewMs: number;
  /** Below this speed the vehicle is "slow"; slow for haltAfterMs means halted. */
  movingSpeedKmh: number;
  haltAfterMs: number;
  /** At walking speed, moves smaller than max(2 × accuracy, this) are jitter, not travel. */
  minJitterRadiusM: number;
}

export const DEFAULT_PROCESSING_OPTIONS: ProcessingOptions = {
  maxAccuracyM: 50,
  maxPlausibleSpeedKmh: 150,
  maxFutureSkewMs: 10 * 60_000,
  movingSpeedKmh: 5,
  haltAfterMs: 3 * 60_000,
  minJitterRadiusM: 30,
};

export type RejectReason = 'low_accuracy' | 'mock_location' | 'future_timestamp' | 'gps_jump';

/**
 * Step 1 — clean. Returns why the fix is unusable, or null. Accuracy/mock rules apply to the
 * phone (the only source that reports them); the jump check applies to every GPS source and only
 * against an EARLIER accepted fix (late points can't be judged against a newer anchor).
 */
export function cleanPoint(
  point: NormalizedPoint,
  previous: VehicleState | null,
  nowMs: number,
  options: ProcessingOptions,
): RejectReason | null {
  const recordedAtMs = Date.parse(point.recordedAt);
  if (recordedAtMs - nowMs > options.maxFutureSkewMs) return 'future_timestamp';

  if (point.source === 'driver_app') {
    if (point.flags?.isMock === true) return 'mock_location';
    if (point.accuracyM != null && point.accuracyM > options.maxAccuracyM) return 'low_accuracy';
  }

  if (point.source !== 'sim' && previous && recordedAtMs > previous.recordedAtMs) {
    const speed = impliedSpeedKmh(
      haversineMeters(previous, point),
      recordedAtMs - previous.recordedAtMs,
    );
    if (speed !== null && speed > options.maxPlausibleSpeedKmh) return 'gps_jump';
  }
  return null;
}

export interface Movement {
  /** Metres travelled since the previous accepted fix (0 when stationary or first fix). */
  distanceM: number;
  stationary: boolean;
  /** Reported speed, or the speed implied by the move when the device didn't report one. */
  speedKmh: number | null;
}

/**
 * Step 2 — movement. A parked phone drifts 5-30 m between fixes, often swinging back and forth;
 * counting that as travel would inflate trip distance by kilometres a day. At walking speed, a
 * move inside twice the fix's error radius (two fixes' error circles can sit that far apart) is
 * treated as no move at all. The anchor stays put while stationary, so slow real progress is
 * still counted once it leaves the radius — nothing is lost, only noise is dropped.
 */
export function measureMovement(
  point: NormalizedPoint,
  previous: VehicleState | null,
  options: ProcessingOptions,
): Movement {
  if (!previous) return { distanceM: 0, stationary: false, speedKmh: point.speedKmh ?? null };

  const distanceM = haversineMeters(previous, point);
  const elapsedMs = Date.parse(point.recordedAt) - previous.recordedAtMs;
  const speedKmh = point.speedKmh ?? impliedSpeedKmh(distanceM, elapsedMs);
  const jitterRadiusM = Math.max(2 * (point.accuracyM ?? 0), options.minJitterRadiusM);
  const slow = speedKmh === null || speedKmh < 3.6;

  if (distanceM < jitterRadiusM && slow) return { distanceM: 0, stationary: true, speedKmh };
  return { distanceM, stationary: false, speedKmh };
}

/** Step 3 — motion state: halted only after staying slow for haltAfterMs, so a red light isn't a halt. */
export function nextMotion(
  previous: VehicleState | null,
  recordedAtMs: number,
  speedKmh: number | null,
  options: ProcessingOptions,
): { motion: Motion; slowSinceMs: number | null } {
  if (speedKmh !== null && speedKmh >= options.movingSpeedKmh) {
    return { motion: 'moving', slowSinceMs: null };
  }
  const slowSinceMs = previous?.slowSinceMs ?? recordedAtMs;
  if (recordedAtMs - slowSinceMs >= options.haltAfterMs) return { motion: 'halted', slowSinceMs };
  return { motion: previous?.motion ?? 'halted', slowSinceMs };
}

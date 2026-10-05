import { num } from './rule-helpers';
import type { ProgressState } from './rules/progress-gps.rule';

export interface DelayInput {
  nowMs: number;
  routeLengthM: number;
  startMs: number;
  promisedMs: number;
  progress: ProgressState | null;
  params: Record<string, number | boolean | string>;
}

export interface DelayEstimate {
  remainingKm: number;
  speedKmh: number;
  basis: 'observed' | 'planned';
  etaMs: number;
  delayMin: number;
}

const MIN_SPEED_KMH = 1; // a truck halted for 3 h must not make the ETA infinite

/**
 * DELAY-GPS projection (rule sheet), pure:
 *  - remaining km = route km from the furthest progress reached to the drop;
 *  - speed = route km covered over the last 3 h ÷ elapsed hours, halts included (a long halt
 *    already worsens the ETA — no separate halt term), once 50 km is covered; before that the
 *    planned speed = route km ÷ planned transit time;
 *  - ETA = now + remaining ÷ speed; delay = ETA − promised.
 */
export function evaluateDelay(input: DelayInput): DelayEstimate {
  const { nowMs, routeLengthM, startMs, promisedMs, progress, params } = input;
  const furthest = progress?.furthestAlongM ?? 0;
  const remainingKm = Math.max(0, routeLengthM - furthest) / 1000;

  const plannedHours = (promisedMs - startMs) / 3_600_000;
  const plannedSpeed =
    plannedHours > 0 ? routeLengthM / 1000 / plannedHours : num(params, 'fallbackKmPerDay') / 24;

  let speed = plannedSpeed;
  let basis: DelayEstimate['basis'] = 'planned';
  const covered = progress ? (furthest - progress.baselineAlongM) / 1000 : 0;
  if (progress && covered >= num(params, 'minCoveredKm') && progress.samples.length > 0) {
    const windowStart = nowMs - num(params, 'speedWindowH') * 3_600_000;
    const from = progress.samples.find((sample) => sample.t >= windowStart) ?? progress.samples[0];
    const hours = (nowMs - from.t) / 3_600_000;
    if (hours >= 0.25) {
      speed = (furthest - from.alongM) / 1000 / hours;
      basis = 'observed';
    }
  }
  speed = Math.max(speed, MIN_SPEED_KMH);

  const etaMs = nowMs + (remainingKm / speed) * 3_600_000;
  return {
    remainingKm: Math.round(remainingKm * 10) / 10,
    speedKmh: Math.round(speed * 10) / 10,
    basis,
    etaMs,
    delayMin: Math.round((etaMs - promisedMs) / 60_000),
  };
}

/** Promised delivery: the route's / load's promise, else start + route km at 350 km/day. */
export function promisedTime(
  routePromisedMs: number | null,
  tripPromisedMs: number | null,
  startMs: number,
  routeLengthM: number,
  params: Record<string, number | boolean | string>,
): number {
  if (routePromisedMs) return routePromisedMs;
  if (tripPromisedMs) return tripPromisedMs;
  return startMs + (routeLengthM / 1000 / num(params, 'fallbackKmPerDay')) * 86_400_000;
}

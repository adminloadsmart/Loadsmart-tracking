import { num } from './rule-helpers';
import type { RouteTime } from '../routes/route-time';
import type { ProgressState } from './rules/progress-gps.rule';

export interface DelayInput {
  nowMs: number;
  routeLengthM: number;
  /** Expected (car, no stops) time along the route, per segment. */
  routeTime: RouteTime;
  promisedMs: number;
  progress: ProgressState | null;
  params: Record<string, number | boolean | string>;
}

export interface DelayEstimate {
  remainingKm: number;
  /** Effective speed over what is left (remaining km ÷ remaining hours), for display. */
  speedKmh: number;
  /** How much longer than Google's car time this truck takes (rests and halts included). */
  paceFactor: number;
  /** planned: prior only · blended: some observation · observed: observation weighs ≥ 50 %. */
  basis: 'observed' | 'blended' | 'planned';
  etaMs: number;
  delayMin: number;
}

type Params = Record<string, number | boolean | string>;
const clampPace = (pace: number, p: Params) =>
  Math.min(num(p, 'maxPace'), Math.max(num(p, 'minPace'), pace));

/**
 * Prior pace for a route: chosen so the whole route takes routeKm ÷ plannedKmPerDay — the
 * planning rate — while Google's profile still decides WHERE along the route that time goes.
 * Never derived from the promise (a 6 h promise on 1,486 km would mean 248 km/h).
 */
export function priorPace(routeLengthM: number, routeTime: RouteTime, p: Params): number {
  const plannedS = (routeLengthM / 1000 / num(p, 'plannedKmPerDay')) * 86_400;
  return clampPace(routeTime.totalS > 0 ? plannedS / routeTime.totalS : 1, p);
}

/**
 * DELAY-GPS projection, pure — the way a navigation app does it, adapted to trucks:
 *  - time still ahead = Google's expected time from the furthest progress to the drop, summed over
 *    the segments ahead (a highway km is faster than a city or ghat km);
 *  - × pace factor: the prior (see priorPace) blended with the pace observed over the last 12 h
 *    (actual hours ÷ Google hours for the stretch covered, halts included), weighted by hours
 *    observed: pace = (prior·K + observed·h) / (K + h), clamped;
 *  - ETA = now + time ahead × pace; delay = ETA − promised.
 */
export function evaluateDelay(input: DelayInput): DelayEstimate {
  const { nowMs, routeLengthM, routeTime, promisedMs, progress, params: p } = input;
  const furthest = progress?.furthestAlongM ?? 0;
  const remainingKm = Math.max(0, routeLengthM - furthest) / 1000;
  const prior = priorPace(routeLengthM, routeTime, p);

  let pace = prior;
  let basis: DelayEstimate['basis'] = 'planned';
  if (progress && progress.samples.length > 0) {
    const windowStart = nowMs - num(p, 'speedWindowH') * 3_600_000;
    const from = progress.samples.find((sample) => sample.t >= windowStart) ?? progress.samples[0];
    const hours = (nowMs - from.t) / 3_600_000;
    if (hours >= 0.25) {
      const expectedS = routeTime.at(furthest) - routeTime.at(from.alongM);
      // Barely moved over the window (halted): as slow as allowed, weighted by how long.
      const observed =
        furthest - from.alongM >= 1000 && expectedS > 0
          ? clampPace((hours * 3600) / expectedS, p)
          : num(p, 'maxPace');
      const k = num(p, 'priorWeightH');
      pace = clampPace((prior * k + observed * hours) / (k + hours), p);
      basis = hours / (k + hours) >= 0.5 ? 'observed' : 'blended';
    }
  }

  const remainingS = routeTime.remainingFrom(furthest) * pace;
  const etaMs = nowMs + remainingS * 1000;
  const speedKmh =
    remainingS > 0
      ? remainingKm / (remainingS / 3600)
      : routeLengthM / 1000 / ((routeTime.totalS * pace) / 3600);
  return {
    remainingKm: Math.round(remainingKm * 10) / 10,
    speedKmh: Math.round(speedKmh * 10) / 10,
    paceFactor: Math.round(pace * 100) / 100,
    basis,
    etaMs,
    delayMin: Math.round((etaMs - promisedMs) / 60_000),
  };
}

/**
 * "Already late" (past promised, not delivered) alerts at once; its severity follows how late it
 * is, on the same thresholds as a projected delay: Critical from 240 min, Warning before that.
 */
export function alreadyLateSeverity(
  delayMin: number,
  params: Record<string, number | boolean | string>,
): 'warning' | 'critical' {
  return delayMin >= num(params, 'criticalDelayMin') ? 'critical' : 'warning';
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

/**
 * LS_N_0030's decision for one evaluation: due once the delay has been over the company's limit
 * on `consecutive` evaluations in a row, and after the first notice only once the delay is at
 * least double the one last notified.
 */
export function lateNoticeDue(
  state: { lateConsec: number; lateNotifiedMin: number },
  delayMin: number,
  thresholdMin: number,
  consecutive: number,
): { lateConsec: number; due: boolean } {
  const lateConsec = delayMin > thresholdMin ? state.lateConsec + 1 : 0;
  if (lateConsec < consecutive) return { lateConsec, due: false };
  const doubled = state.lateNotifiedMin === 0 || delayMin >= 2 * state.lateNotifiedMin;
  return { lateConsec, due: doubled };
}

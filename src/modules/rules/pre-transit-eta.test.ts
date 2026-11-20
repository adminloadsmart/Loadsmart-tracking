import { describe, expect, it } from 'vitest';
import { RouteGeometry } from '../routes/route-geometry';
import { RouteTime } from '../routes/route-time';
import { RULE_DEFAULTS } from './defaults';
import { estimatePreTransit, type PreTransitInput } from './pre-transit-eta';

const NOW = Date.UTC(2026, 10, 20, 6, 0);
const PARAMS = RULE_DEFAULTS['DELAY-GPS']!.params;
const HOUR = 3_600_000;
/** 700 km plant → drop; Google's car time 12 h (≈ 58 km/h). */
const ROUTE_M = 700_000;
const ROUTE_TIME = RouteTime.of(ROUTE_M, 12 * 3600);
/** The whole route at 350 km/day = 48 h, whatever Google's car time. */
const ROUTE_H = 700 / (350 / 24);
/** A straight ~111 km approach leg due north from (28.6, 77.2); Google says 2 h for it. */
const APPROACH_GEOMETRY = new RouteGeometry(
  Array.from({ length: 101 }, (_, i) => ({ lat: 28.6 + i * 0.01, lng: 77.2 })),
);
const APPROACH = { geometry: APPROACH_GEOMETRY, durationS: 7200 };
const PLANT = APPROACH_GEOMETRY.end;

const input = (over: Partial<PreTransitInput> = {}): PreTransitInput => ({
  nowMs: NOW,
  stage: 'truck_assigned',
  routeLengthM: ROUTE_M,
  routeTime: ROUTE_TIME,
  atPlantAtMs: null,
  position: { lat: 28.6, lng: 77.2 },
  approach: APPROACH,
  loadingPoint: PLANT,
  params: PARAMS,
  ...over,
});

describe('estimatePreTransit', () => {
  it('heading to the plant: Google approach time × 1.3 + full dwell + route at the prior pace', () => {
    const est = estimatePreTransit(input())!;
    expect(est.approachKm).toBeCloseTo(APPROACH_GEOMETRY.lengthM / 1000, 0);
    expect(est.approachMin).toBe(Math.round(120 * 1.3));
    expect(est.dwellMin).toBe(240);
    expect(est.paceFactor).toBeCloseTo(ROUTE_H / 12, 2);
    const expected = NOW + 2 * 1.3 * HOUR + 240 * 60_000 + ROUTE_H * HOUR;
    expect(est.etaMs).toBeCloseTo(expected, -4);
  });

  it('progress along the approach leg shortens it', () => {
    const halfway = estimatePreTransit(input({ position: { lat: 29.1, lng: 77.2 } }))!;
    expect(halfway.approachKm).toBeCloseTo(APPROACH_GEOMETRY.lengthM / 2000, 0);
    expect(halfway.approachMin).toBeCloseTo(60 * 1.3, -1);
  });

  it('off the approach leg (> 5 km): straight line to the plant × 1.3 at approachKmh', () => {
    // ~20 km east of the halfway point, so ~sqrt(55.6² + 20²) ≈ 59 km from the plant.
    const est = estimatePreTransit(input({ position: { lat: 29.1, lng: 77.405 } }))!;
    expect(est.approachKm).toBeGreaterThan(59 * 1.3 - 2);
    expect(est.approachKm).toBeLessThan(59 * 1.3 + 2);
    expect(est.approachMin).toBeCloseTo(((est.approachKm / 30) * 60) | 0, -1);
  });

  it('no approach leg drawn: falls back to the loading point', () => {
    const est = estimatePreTransit(input({ approach: null, position: { lat: 29.6, lng: 77.2 } }))!;
    expect(est.approachKm).toBeCloseTo(0, 0);
  });

  it('heading to the plant without a position: no ETA', () => {
    expect(estimatePreTransit(input({ position: null }))).toBeNull();
    expect(estimatePreTransit(input({ stage: 'in_transit_loading', position: null }))).toBeNull();
  });

  it('nowhere to measure the approach to: no ETA', () => {
    expect(estimatePreTransit(input({ approach: null, loadingPoint: null }))).toBeNull();
  });

  it('at the plant: dwell counts down from atPlantAt, no approach, no position needed', () => {
    const est = estimatePreTransit(
      input({ stage: 'reached_loading', atPlantAtMs: NOW - 90 * 60_000, position: null }),
    )!;
    expect(est.approachKm).toBe(0);
    expect(est.dwellMin).toBe(150);
    expect(est.etaMs).toBeCloseTo(NOW + ROUTE_H * HOUR + 150 * 60_000, -4);
  });

  it('at the plant past the dwell allowance: dwell 0, never negative', () => {
    const est = estimatePreTransit(
      input({ stage: 'reached_loading', atPlantAtMs: NOW - 10 * HOUR }),
    )!;
    expect(est.dwellMin).toBe(0);
  });

  it('at the plant with no atPlantAt: the full dwell', () => {
    expect(estimatePreTransit(input({ stage: 'reached_loading' }))!.dwellMin).toBe(240);
  });

  it('loaded: only the plant → drop route, at the speed the in-transit prior also uses', () => {
    const est = estimatePreTransit(input({ stage: 'loaded', position: null }))!;
    expect(est).toMatchObject({ approachKm: 0, dwellMin: 0, remainingKm: 700 });
    expect(est.speedKmh).toBeCloseTo(350 / 24, 1);
    expect(est.etaMs).toBeCloseTo(NOW + ROUTE_H * HOUR, -4);
  });
});

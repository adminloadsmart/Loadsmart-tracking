import { describe, expect, it } from 'vitest';
import { RouteGeometry } from '../routes/route-geometry';
import { RULE_DEFAULTS } from './defaults';
import { estimatePreTransit, type PreTransitInput } from './pre-transit-eta';

const NOW = Date.UTC(2026, 10, 20, 6, 0);
const PARAMS = RULE_DEFAULTS['DELAY-GPS']!.params;
/** 350 km/day → 14.583 km/h. */
const RATE_KMH = 350 / 24;
const HOUR = 3_600_000;
/** A straight ~111 km approach leg due north from (28.6, 77.2); its end is the loading point. */
const APPROACH = new RouteGeometry(
  Array.from({ length: 101 }, (_, i) => ({ lat: 28.6 + i * 0.01, lng: 77.2 })),
);
const PLANT = APPROACH.end;

const input = (over: Partial<PreTransitInput> = {}): PreTransitInput => ({
  nowMs: NOW,
  stage: 'truck_assigned',
  routeLengthM: 700_000,
  atPlantAtMs: null,
  position: { lat: 28.6, lng: 77.2 },
  approach: APPROACH,
  loadingPoint: PLANT,
  params: PARAMS,
  ...over,
});

describe('estimatePreTransit', () => {
  it('heading to the plant: approach left on the drawn leg + full dwell + plant → drop route', () => {
    const est = estimatePreTransit(input())!;
    expect(est.approachKm).toBeCloseTo(APPROACH.lengthM / 1000, 0);
    expect(est.dwellMin).toBe(240);
    expect(est.remainingKm).toBeCloseTo(APPROACH.lengthM / 1000 + 700, 0);
    const expected = NOW + ((APPROACH.lengthM / 1000 + 700) / RATE_KMH) * HOUR + 240 * 60_000;
    expect(est.etaMs).toBeCloseTo(expected, -3);
  });

  it('progress along the approach leg shortens it', () => {
    const halfway = estimatePreTransit(input({ position: { lat: 29.1, lng: 77.2 } }))!;
    expect(halfway.approachKm).toBeCloseTo(APPROACH.lengthM / 2000, 0);
  });

  it('off the approach leg (> 5 km): straight line to the loading point × 1.3', () => {
    // ~20 km east of the halfway point, so ~sqrt(55.6² + 20²) ≈ 59 km from the plant.
    const est = estimatePreTransit(input({ position: { lat: 29.1, lng: 77.405 } }))!;
    expect(est.approachKm).toBeGreaterThan(59 * 1.3 - 2);
    expect(est.approachKm).toBeLessThan(59 * 1.3 + 2);
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
    expect(est.etaMs).toBeCloseTo(NOW + (700 / RATE_KMH) * HOUR + 150 * 60_000, -3);
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

  it('loaded: only the plant → drop route', () => {
    const est = estimatePreTransit(input({ stage: 'loaded', position: null }))!;
    expect(est).toMatchObject({ approachKm: 0, dwellMin: 0, remainingKm: 700 });
    expect(est.etaMs).toBeCloseTo(NOW + (700 / RATE_KMH) * HOUR, -3);
  });
});

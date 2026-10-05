import { describe, expect, it } from 'vitest';
import type { NormalizedPoint } from '../points/point.contract';
import { runPipeline } from './pipeline';
import { DEFAULT_PROCESSING_OPTIONS as OPTS } from './steps';
import { stateMapKey, VehicleState } from './vehicle-state';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const VEHICLE = '22222222-2222-4222-8222-222222222222';
const TRIP = '33333333-3333-4333-8333-333333333333';

/** A truck driving north at ~53 km/h: one fix every 15s, 0.002° (~222 m) apart. */
function drive(count: number, startIndex = 0, overrides: Partial<NormalizedPoint> = {}) {
  return Array.from({ length: count }, (_, k): NormalizedPoint => {
    const i = startIndex + k;
    return {
      tenantId: '11111111-1111-4111-8111-111111111111',
      vehicleId: VEHICLE,
      tripId: TRIP,
      source: 'driver_app',
      sourceRef: 'd1',
      recordedAt: new Date(T0 + i * 15_000).toISOString(),
      receivedAt: new Date(T0 + i * 15_000).toISOString(),
      lat: 28.6 + i * 0.002,
      lng: 77.2,
      speedKmh: 53,
      heading: 0,
      accuracyM: 8,
      flags: null,
      ...overrides,
    };
  });
}

const key = stateMapKey({ vehicleId: VEHICLE, source: 'driver_app' });
const now = T0 + 3_600_000;

describe('runPipeline', () => {
  it('accumulates trip distance between consecutive fixes and tracks state', () => {
    const result = runPipeline(drive(5), new Map(), now, OPTS);
    // 4 gaps of ~222.4 m (the first fix only anchors).
    expect(result.distance.get(`${TRIP}|driver_app`)).toBeCloseTo(4 * 222.4, -1);
    expect(result.states.get(key)).toMatchObject({
      lat: 28.608,
      recordedAtMs: T0 + 60_000,
      motion: 'moving',
    });
    expect(result.points.every((p) => p.rejected === null)).toBe(true);
  });

  it('is replay-safe: re-running a batch against its own resulting state adds nothing', () => {
    const batch = drive(5);
    const first = runPipeline(batch, new Map(), now, OPTS);
    const replay = runPipeline(batch, first.states, now, OPTS);
    expect(replay.distance.size).toBe(0);
    expect(replay.states.size).toBe(0);
    expect(replay.points.every((p) => p.point.flags?.late === true)).toBe(true);
  });

  it('continues distance across batches, and an out-of-order offline batch is stored but adds nothing', () => {
    const first = runPipeline(drive(3), new Map(), now, OPTS);
    const second = runPipeline(drive(2, 3), first.states, now, OPTS);
    expect(second.distance.get(`${TRIP}|driver_app`)).toBeCloseTo(2 * 222.4, -1);

    const lateBatch = runPipeline(drive(2, 0), second.states, now, OPTS);
    expect(lateBatch.distance.size).toBe(0);
    expect(lateBatch.points.map((p) => p.point.flags?.late)).toEqual([true, true]);
  });

  it('sorts a batch by recordedAt, so arrival order does not matter', () => {
    const batch = drive(4).reverse();
    const result = runPipeline(batch, new Map(), now, OPTS);
    expect(result.distance.get(`${TRIP}|driver_app`)).toBeCloseTo(3 * 222.4, -1);
    // Results come back in the original (stream) order.
    expect(result.points.map((p) => p.point.recordedAt)).toEqual(batch.map((p) => p.recordedAt));
  });

  it('rejects bad fixes without moving the state, and flags mock locations on the trip', () => {
    const [a, b, c] = drive(3);
    const result = runPipeline(
      [a, { ...b, flags: { isMock: true } }, { ...c, accuracyM: 500 }],
      new Map(),
      now,
      OPTS,
    );
    expect(result.points.map((p) => p.rejected)).toEqual([null, 'mock_location', 'low_accuracy']);
    expect(result.points[1].point.flags).toMatchObject({ rejected: 'mock_location' });
    expect(result.mockLocationTrips).toEqual(new Set([TRIP]));
    expect(result.states.get(key)?.recordedAtMs).toBe(T0);
    expect(result.distance.size).toBe(0);
  });

  it('a parked truck accumulates no distance from GPS drift', () => {
    const parked = Array.from({ length: 20 }, (_, i) => ({
      ...drive(1, i)[0],
      lat: 28.6 + (i % 2 ? 0.00008 : -0.00008), // ±9 m wobble
      speedKmh: 0.3,
    }));
    const result = runPipeline(parked, new Map(), now, OPTS);
    expect(result.distance.get(`${TRIP}|driver_app`) ?? 0).toBe(0);
    expect(result.states.get(key)?.motion).toBe('halted');
  });

  it('still counts slow real progress (traffic crawl) once it leaves the jitter radius', () => {
    // 2 km/h crawl: ~8 m per 15s fix, 12 fixes ≈ 89 m of real travel.
    const crawl = Array.from({ length: 12 }, (_, i) => ({
      ...drive(1, i)[0],
      lat: 28.6 + i * 0.0000745,
      speedKmh: 2,
    }));
    const counted =
      runPipeline(crawl, new Map(), now, OPTS).distance.get(`${TRIP}|driver_app`) ?? 0;
    // Counted in ≥30 m hops from the anchor: all but the last partial hop.
    expect(counted).toBeGreaterThan(55);
    expect(counted).toBeLessThan(95);
  });

  it('does not count the gap from a previous trip (or idle) into a new trip', () => {
    const previous: VehicleState = {
      lat: 20,
      lng: 75,
      recordedAtMs: T0 - 86_400_000,
      speedKmh: 0,
      motion: 'halted',
      slowSinceMs: null,
      tripId: null,
    };
    const result = runPipeline(drive(1), new Map([[key, previous]]), now, OPTS);
    expect(result.distance.size).toBe(0);
  });
});

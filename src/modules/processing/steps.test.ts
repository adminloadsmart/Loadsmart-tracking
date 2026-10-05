import { describe, expect, it } from 'vitest';
import type { NormalizedPoint } from '../points/point.contract';
import { haversineMeters } from './geo';
import {
  cleanPoint,
  DEFAULT_PROCESSING_OPTIONS as OPTS,
  measureMovement,
  nextMotion,
} from './steps';
import type { VehicleState } from './vehicle-state';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function point(overrides: Partial<NormalizedPoint> = {}): NormalizedPoint {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    vehicleId: '22222222-2222-4222-8222-222222222222',
    tripId: '33333333-3333-4333-8333-333333333333',
    source: 'driver_app',
    sourceRef: 'd1',
    recordedAt: at(0),
    receivedAt: at(0),
    lat: 28.6139,
    lng: 77.209,
    speedKmh: 40,
    heading: 0,
    accuracyM: 8,
    flags: null,
    ...overrides,
  };
}

function state(overrides: Partial<VehicleState> = {}): VehicleState {
  return {
    lat: 28.6139,
    lng: 77.209,
    recordedAtMs: T0,
    speedKmh: 40,
    motion: 'moving',
    slowSinceMs: null,
    tripId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

describe('haversineMeters', () => {
  it('matches known great-circle distances', () => {
    // Delhi (Connaught Place) → Dehradun clock tower: ~205 km as the crow flies.
    const d = haversineMeters({ lat: 28.6139, lng: 77.209 }, { lat: 30.3165, lng: 78.0322 });
    expect(d / 1000).toBeCloseTo(205.4, 1);
    // 0.001° latitude ≈ 111 m.
    expect(haversineMeters({ lat: 28, lng: 77 }, { lat: 28.001, lng: 77 })).toBeCloseTo(111.2, 0);
  });
});

describe('cleanPoint', () => {
  it('accepts a normal fix', () => {
    expect(cleanPoint(point(), null, T0, OPTS)).toBeNull();
  });

  it('rejects poor accuracy, mock locations and future timestamps (phone)', () => {
    expect(cleanPoint(point({ accuracyM: 51 }), null, T0, OPTS)).toBe('low_accuracy');
    expect(cleanPoint(point({ accuracyM: 50 }), null, T0, OPTS)).toBeNull();
    expect(cleanPoint(point({ flags: { isMock: true } }), null, T0, OPTS)).toBe('mock_location');
    expect(cleanPoint(point({ recordedAt: at(11 * 60_000) }), null, T0, OPTS)).toBe(
      'future_timestamp',
    );
    expect(cleanPoint(point({ recordedAt: at(9 * 60_000) }), null, T0, OPTS)).toBeNull();
  });

  it('rejects a GPS jump only against an earlier accepted fix', () => {
    // ~11 km in 60s = ~667 km/h.
    const jump = point({ recordedAt: at(60_000), lat: 28.7139 });
    expect(cleanPoint(jump, state(), T0 + 60_000, OPTS)).toBe('gps_jump');
    // ~1.1 km in 60s = ~67 km/h is plausible.
    expect(
      cleanPoint(point({ recordedAt: at(60_000), lat: 28.6239 }), state(), T0, OPTS),
    ).toBeNull();
    // A late point (older than the state) isn't judged against the newer anchor.
    expect(
      cleanPoint(point({ recordedAt: at(-60_000), lat: 28.7139 }), state(), T0, OPTS),
    ).toBeNull();
  });

  it('does not apply phone-only rules to other sources', () => {
    expect(cleanPoint(point({ source: 'sim', accuracyM: 2000 }), null, T0, OPTS)).toBeNull();
  });
});

describe('measureMovement', () => {
  it('treats drift inside the error circle at walking speed as stationary', () => {
    const drift = point({ recordedAt: at(15_000), lat: 28.61399, speedKmh: 0.5, accuracyM: 12 });
    expect(measureMovement(drift, state(), OPTS)).toMatchObject({ stationary: true, distanceM: 0 });
  });

  it('counts real movement', () => {
    const moved = point({ recordedAt: at(15_000), lat: 28.6159, speedKmh: 48 });
    const movement = measureMovement(moved, state(), OPTS);
    expect(movement.stationary).toBe(false);
    expect(movement.distanceM).toBeCloseTo(222.4, 0);
  });

  it('derives speed when the device reports none', () => {
    const moved = point({ recordedAt: at(60_000), lat: 28.6239, speedKmh: null });
    expect(measureMovement(moved, state(), OPTS).speedKmh).toBeCloseTo(66.7, 0);
  });
});

describe('nextMotion', () => {
  it('is moving above the threshold', () => {
    expect(nextMotion(state({ motion: 'halted' }), T0, 20, OPTS)).toEqual({
      motion: 'moving',
      slowSinceMs: null,
    });
  });

  it('stays moving through a short stop, halts after 3 minutes slow', () => {
    const stopped = nextMotion(state(), T0, 0, OPTS);
    expect(stopped).toEqual({ motion: 'moving', slowSinceMs: T0 });
    const stillSlow = nextMotion(state({ slowSinceMs: T0 }), T0 + 2 * 60_000, 1, OPTS);
    expect(stillSlow.motion).toBe('moving');
    const halted = nextMotion(state({ slowSinceMs: T0 }), T0 + 3 * 60_000, 1, OPTS);
    expect(halted.motion).toBe('halted');
  });
});

import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { phoneBatchSchema, phonePointSchema, toNormalizedPoint } from './driver-point.contract';
import { verifyDriverToken } from './driver-socket-auth';

const owner = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  tripId: '33333333-3333-4333-8333-333333333333',
  driverId: '44444444-4444-4444-8444-444444444444',
};

describe('phone point contract', () => {
  it('converts OS units (m/s) to the stream contract (km/h) and moves app metadata into flags', () => {
    const parsed = phonePointSchema.parse({
      pointId: '0192f5a1-0000-7000-8000-000000000001',
      lat: 28.61,
      lng: 77.2,
      accuracy: 6.5,
      speed: 13.9,
      bearing: 90,
      altitude: 216,
      recordedAt: '2026-10-05T15:30:00+05:30',
      isMock: false,
      batteryPct: 72,
      provider: 'fused',
      appState: 'background',
    });
    const point = toNormalizedPoint(parsed, owner, '2026-10-05T10:00:01.000Z');
    expect(point).toMatchObject({
      source: 'driver_app',
      sourceRef: owner.driverId,
      recordedAt: '2026-10-05T10:00:00.000Z',
      speedKmh: 50,
      heading: 90,
      accuracyM: 6.5,
      flags: {
        isMock: false,
        batteryPct: 72,
        provider: 'fused',
        appState: 'background',
        altitudeM: 216,
      },
    });
  });

  it('rejects out-of-range values and oversize batches', () => {
    expect(
      phonePointSchema.safeParse({ lat: 91, lng: 0, recordedAt: '2026-10-05T10:00:00Z' }).success,
    ).toBe(false);
    expect(phonePointSchema.safeParse({ lat: 1, lng: 1, recordedAt: 'yesterday' }).success).toBe(
      false,
    );
    const p = { lat: 1, lng: 1, recordedAt: '2026-10-05T10:00:00Z' };
    expect(phoneBatchSchema.safeParse(Array(200).fill(p)).success).toBe(true);
    expect(phoneBatchSchema.safeParse(Array(201).fill(p)).success).toBe(false);
    expect(phoneBatchSchema.safeParse([]).success).toBe(false);
  });
});

describe('verifyDriverToken', () => {
  const secret = 'test-secret-test-secret-test-secret';
  const sign = (payload: object, options: jwt.SignOptions = { expiresIn: 900 }) =>
    jwt.sign(payload, secret, { algorithm: 'HS256', ...options });

  it('accepts a tenant-selected driver access token', () => {
    const identity = verifyDriverToken(
      sign({ id: owner.driverId, tenantId: owner.tenantId, purpose: 'driver-access', jti: 'j1' }),
      secret,
    );
    expect(identity).toMatchObject({
      driverId: owner.driverId,
      tenantId: owner.tenantId,
      jti: 'j1',
    });
  });

  it.each([
    [
      'identity-only token',
      { id: owner.driverId, tenantId: null, purpose: 'driver-identity-access' },
    ],
    ['staff token', { id: owner.driverId, tenantId: owner.tenantId, purpose: 'access' }],
    ['no tenant', { id: owner.driverId, purpose: 'driver-access' }],
    ['no purpose', { id: owner.driverId, tenantId: owner.tenantId }],
  ])('rejects a %s', (_label, payload) => {
    expect(verifyDriverToken(sign(payload), secret)).toBeNull();
  });

  it('rejects expired, wrongly signed and non-HS256 tokens', () => {
    const payload = { id: owner.driverId, tenantId: owner.tenantId, purpose: 'driver-access' };
    expect(verifyDriverToken(sign(payload, { expiresIn: -10 }), secret)).toBeNull();
    expect(verifyDriverToken(jwt.sign(payload, 'other-secret'), secret)).toBeNull();
    expect(verifyDriverToken(jwt.sign(payload, secret, { algorithm: 'HS512' }), secret)).toBeNull();
  });
});

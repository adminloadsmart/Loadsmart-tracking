import { describe, expect, it } from 'vitest';
import { marketVehicleId, normalizePlate, trackingStateFor } from './trip-state';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('trackingStateFor', () => {
  it.each([
    ['created', 'pending'],
    ['assigned', 'pending'],
    ['loading_confirmed', 'active'],
    ['at_plant', 'active'],
    ['in_transit', 'active'],
    ['reached_delivery_point', 'active'],
    ['delivered', 'ended'],
    ['closed', 'ended'],
  ] as const)('%s -> %s', (status, state) => {
    expect(trackingStateFor(status, false)).toBe(state);
  });

  it('a deleted load is ended whatever its status', () => {
    expect(trackingStateFor('in_transit', true)).toBe('ended');
  });
});

describe('marketVehicleId', () => {
  it('is deterministic and ignores plate formatting', () => {
    const id = marketVehicleId(TENANT, 'MH12 AB-1234');
    expect(marketVehicleId(TENANT, 'mh12ab1234')).toBe(id);
    expect(normalizePlate(' mh-12 ab 1234')).toBe('MH12AB1234');
  });

  it('is a valid RFC 9562 version-5 UUID', () => {
    expect(marketVehicleId(TENANT, 'MH12AB1234')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('differs per tenant and per plate', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(marketVehicleId(other, 'MH12AB1234')).not.toBe(marketVehicleId(TENANT, 'MH12AB1234'));
    expect(marketVehicleId(TENANT, 'MH12AB1235')).not.toBe(marketVehicleId(TENANT, 'MH12AB1234'));
  });
});

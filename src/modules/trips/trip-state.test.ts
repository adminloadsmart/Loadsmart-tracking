import { describe, expect, it } from 'vitest';
import {
  DELIVERED_FOLLOW_MS,
  isIndexed,
  marketVehicleId,
  normalizePlate,
  trackingStateFor,
} from './trip-state';

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

describe('isIndexed', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const load = (status: string, deliveredAgoMs: number | null, departed = false) => ({
    status: status as Parameters<typeof isIndexed>[0]['status'],
    deliveredAt: deliveredAgoMs === null ? null : new Date(now - deliveredAgoMs),
    departedDropAt: departed ? new Date(now) : null,
  });

  it('indexes assigned and tracked loads, never created ones', () => {
    for (const status of ['assigned', 'loading_confirmed', 'at_plant', 'in_transit']) {
      expect(isIndexed(load(status, null), now)).toBe(true);
    }
    expect(isIndexed(load('created', null), now)).toBe(false);
  });

  it('follows a delivered load until its truck leaves the drop, for DELIVERED_FOLLOW_MS', () => {
    expect(isIndexed(load('delivered', 60_000), now)).toBe(true);
    expect(isIndexed(load('closed', 60_000), now)).toBe(true);
    expect(isIndexed(load('delivered', 60_000, true), now)).toBe(false);
    expect(isIndexed(load('delivered', DELIVERED_FOLLOW_MS + 1), now)).toBe(false);
  });
});

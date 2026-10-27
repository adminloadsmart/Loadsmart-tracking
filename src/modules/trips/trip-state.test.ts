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
    ['bids_received', 'pending'],
    ['truck_assigned', 'pending'],
    ['in_transit_loading', 'pending'],
    ['loaded', 'active'],
    ['reached_loading', 'active'],
    ['in_transit_unloading', 'active'],
    ['reached_unloading', 'active'],
    ['delivered_ok', 'ended'],
    ['delivered_with_issues', 'ended'],
    ['payment', 'ended'],
    ['closed', 'ended'],
  ] as const)('%s -> %s', (status, state) => {
    expect(trackingStateFor(status, false)).toBe(state);
  });

  it('a deleted load is ended whatever its status', () => {
    expect(trackingStateFor('in_transit_unloading', true)).toBe('ended');
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
    for (const status of ['truck_assigned', 'in_transit_loading', 'reached_loading', 'loaded']) {
      expect(isIndexed(load(status, null), now)).toBe(true);
    }
    expect(isIndexed(load('created', null), now)).toBe(false);
  });

  it('follows a delivered load until its truck leaves the drop, for DELIVERED_FOLLOW_MS', () => {
    expect(isIndexed(load('delivered_ok', 60_000), now)).toBe(true);
    expect(isIndexed(load('closed', 60_000), now)).toBe(true);
    expect(isIndexed(load('delivered_ok', 60_000, true), now)).toBe(false);
    expect(isIndexed(load('delivered_ok', DELIVERED_FOLLOW_MS + 1), now)).toBe(false);
  });
});

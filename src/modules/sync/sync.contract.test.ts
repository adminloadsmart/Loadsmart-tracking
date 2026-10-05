import { describe, expect, it } from 'vitest';
import { parseSnapshot } from './sync.contract';

const base = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  version: '1759650000000',
};

const load = {
  code: 'LOAD-0001',
  status: 'in_transit',
  sourceType: 'own_fleet',
  vehicleId: '44444444-4444-4444-8444-444444444444',
  vehicleNumber: 'MH12AB1234',
  driverId: null,
  driverNumber: '9876543210',
  driverName: null,
  transporterId: null,
  loadingPointId: null,
  deliveryPointId: null,
  milestones: {
    loadingConfirmedAt: '2026-10-05T08:00:00.000Z',
    atPlantAt: null,
    inTransitAt: null,
    reachedDeliveryPointAt: null,
    deliveredAt: null,
  },
};

describe('parseSnapshot', () => {
  it('parses a load snapshot into typed fields', () => {
    const snapshot = parseSnapshot({
      ...base,
      type: 'load',
      deleted: 'false',
      payload: JSON.stringify(load),
    });
    expect(snapshot).toMatchObject({ type: 'load', version: 1759650000000, deleted: false });
    expect(snapshot.payload).toMatchObject({ status: 'in_transit' });
  });

  it('parses a tombstone without a payload', () => {
    expect(parseSnapshot({ ...base, type: 'driver', deleted: 'true' })).toMatchObject({
      deleted: true,
      payload: null,
    });
  });

  it.each([
    [{ ...base, type: 'truck', deleted: 'false', payload: '{}' }, /invalid envelope/],
    [{ ...base, type: 'load', deleted: 'false' }, /payload is required/],
    [{ ...base, type: 'load', deleted: 'false', payload: '{' }, /not valid JSON/],
    [
      {
        ...base,
        type: 'load',
        deleted: 'false',
        payload: JSON.stringify({ ...load, status: 'lost' }),
      },
      /invalid load payload: status/,
    ],
    [{ ...base, id: 'nope', type: 'vehicle', deleted: 'true' }, /invalid envelope: id/],
  ])('rejects %#', (fields, message) => {
    expect(() => parseSnapshot(fields as Record<string, string>)).toThrow(message);
  });
});

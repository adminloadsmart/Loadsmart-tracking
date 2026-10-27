import { describe, expect, it } from 'vitest';
import { normalizedPointSchema } from '../points';
import {
  fixTimeMs,
  hasPosition,
  roadcastResponseSchema,
  roadcastRowSchema,
  toNormalizedPoint,
} from './roadcast.contract';

const OWNER = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  vehicleId: '22222222-2222-4222-8222-222222222222',
  tripId: null,
};
const RECEIVED_AT = '2026-10-23T05:17:00.000Z';

// Trimmed from a real pull-positions response.
const SAMPLE = {
  data: {
    PositionsPull: {
      extras: {
        deviceCount: 3,
        maxDeviceCap: 1000,
        pulledAt: '2026-10-23T05:16:59.684516623Z',
        rowCount: 2,
      },
      rows: [
        {
          deviceName: 'PB65V7155',
          deviceImei: '866221070401935',
          address: null,
          deviceId: '8d1a7e58-b462-44dc-b3b0-02000eca1a54',
          speed: 0,
          temperature: 0,
          ignition: false,
          distance: 0,
          motion: false,
          latitude: 30.641235,
          longitude: 76.83153499999999,
          gpsFixTimestamp: '2026-10-23T04:03:25Z',
          deviceTimestamp: '2026-10-23T05:13:28Z',
          serverTimestamp: '2026-10-23T05:13:28Z',
          course: 0,
          gpsBattery: 66,
          deviceCategory: 'Car',
          deviceStatus: 'online',
          deviceLastUpdate: '2026-10-23T05:16:29Z',
        },
        {
          deviceName: 'PB65V7255',
          deviceImei: '866221070405217',
          address: null,
          deviceId: 'e0b9ccb6-25cd-412d-bc90-a02ee27b750d',
          speed: 7.0194410000000005,
          temperature: 0,
          ignition: true,
          distance: 0,
          motion: true,
          latitude: 30.64107277777778,
          longitude: 76.82250166666665,
          gpsFixTimestamp: '2026-10-23T04:51:34Z',
          deviceTimestamp: '2026-10-23T05:16:45Z',
          serverTimestamp: '2026-10-23T05:16:45Z',
          course: 351,
          gpsBattery: 83,
          deviceCategory: 'Car',
          deviceStatus: 'online',
          deviceLastUpdate: '2026-10-23T05:16:45Z',
        },
      ],
    },
  },
};

const rows = roadcastResponseSchema
  .parse(SAMPLE)
  .data.PositionsPull.rows.map((row) => roadcastRowSchema.parse(row));

describe('Roadcast contract', () => {
  it('dates a position by its GPS fix, not the heartbeat', () => {
    expect(fixTimeMs(rows[0])).toBe(Date.parse('2026-10-23T04:03:25Z'));
    expect(fixTimeMs({ ...rows[0], gpsFixTimestamp: null })).toBe(
      Date.parse('2026-10-23T05:13:28Z'),
    );
    expect(fixTimeMs({ ...rows[0], gpsFixTimestamp: 'garbage', deviceTimestamp: null })).toBe(null);
  });

  it('normalizes a row into a valid point with the device flags', () => {
    const row = rows[1];
    const point = toNormalizedPoint(row, fixTimeMs(row)!, OWNER, RECEIVED_AT, 'kmh');
    expect(normalizedPointSchema.parse(point)).toEqual(point);
    expect(point).toMatchObject({
      source: 'roadcast',
      sourceRef: '866221070405217',
      recordedAt: '2026-10-23T04:51:34.000Z',
      lat: 30.64107277777778,
      lng: 76.82250166666665,
      speedKmh: 7.0194410000000005,
      heading: 351,
      accuracyM: null,
      flags: { ignition: true, motion: true, batteryPct: 83, deviceStatus: 'online' },
    });
  });

  it('converts knots and drops impossible speeds and headings', () => {
    const row = rows[1];
    const fix = fixTimeMs(row)!;
    expect(toNormalizedPoint(row, fix, OWNER, RECEIVED_AT, 'knots').speedKmh).toBeCloseTo(13, 0);
    const bad = { ...row, speed: 900, course: 400 };
    const point = toNormalizedPoint(bad, fix, OWNER, RECEIVED_AT, 'kmh');
    expect(point.speedKmh).toBeNull();
    expect(point.heading).toBeNull();
  });

  it('carries the approach trip in flags', () => {
    const point = toNormalizedPoint(
      rows[0],
      fixTimeMs(rows[0])!,
      { ...OWNER, geofenceTripId: 'trip-1' },
      RECEIVED_AT,
      'kmh',
    );
    expect(point.tripId).toBeNull();
    expect(point.flags).toMatchObject({ geofenceTripId: 'trip-1' });
  });

  it('rejects the 0,0 no-fix position and out-of-range coordinates', () => {
    expect(hasPosition(rows[0])).toBe(true);
    expect(hasPosition({ ...rows[0], latitude: 0, longitude: 0 })).toBe(false);
    expect(hasPosition({ ...rows[0], latitude: 91 })).toBe(false);
  });
});

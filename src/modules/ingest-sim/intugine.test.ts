import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntugineClient, IntugineError, jwtExpiryMs } from './intugine.client';
import {
  hasPosition,
  locationRowSchema,
  locationTimeMs,
  normalizePhone,
  toNormalizedPoint,
  toSimConsent,
} from './intugine.contract';

// Shapes copied from the Intugine Postman collection.
const consentRow = (result: Record<string, unknown>) => [{ code: 200, result }];
const statusRow = {
  _id: '6565a9099afa0d6ce8457814',
  createdAt: '2023-11-28T08:47:05.843Z',
  tel: '7354670095',
  loc: [13.165094, 77.68068],
  tripId: '654b4e42764fd012d146ad88',
  mode: 'automated',
  through: 'TELENITY_IVRALT',
  tracking_type: 'SIM',
  distance_remained: 1552727.5,
};

function jwt(expSeconds: number) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.sig`;
}

describe('toSimConsent', () => {
  it('maps the operator statuses', () => {
    expect(toSimConsent({ consent: 'ALLOWED', operator: 'airtel' }).status).toBe('allowed');
    expect(toSimConsent({ consent: 'Approved', operator: 'jio' }).status).toBe('allowed');
    expect(
      toSimConsent({
        consent: 'PENDING',
        operator: 'airtel',
        consent_suggestion: "Send 's' to 5114040",
      }),
    ).toEqual({ status: 'pending', operator: 'airtel', suggestion: "Send 's' to 5114040" });
    expect(
      toSimConsent({ consent: 'NOT REGISTERED IN MISSEDCALLALERT', operator: 'vodafone' }).status,
    ).toBe('not_registered');
  });

  it('marks operators Intugine cannot track as unsupported, and never guesses allowed', () => {
    expect(
      toSimConsent({
        consent: 'PENDING',
        operator: 'tata docomo',
        consent_suggestion: 'Other Operator: Trip will not be tracked.',
      }).status,
    ).toBe('unsupported');
    expect(toSimConsent({ consent: 'SOMETHING NEW', operator: 'airtel' }).status).toBe('pending');
    expect(toSimConsent({}).status).toBe('pending');
  });
});

describe('location rows', () => {
  it('turns a status row into a low-accuracy SIM point', () => {
    const row = locationRowSchema.parse(statusRow);
    const point = toNormalizedPoint(
      row,
      locationTimeMs(row)!,
      'T1',
      { tenantId: 'ten', vehicleId: 'veh', tripId: 'trip' },
      '2023-11-28T09:00:00.000Z',
      'airtel',
    );
    expect(point).toMatchObject({
      source: 'sim',
      sourceRef: 'T1',
      tripId: 'trip',
      recordedAt: '2023-11-28T08:47:05.843Z',
      lat: 13.165094,
      lng: 77.68068,
      speedKmh: null,
      heading: null,
      flags: {
        lowAccuracy: true,
        through: 'TELENITY_IVRALT',
        trackingType: 'SIM',
        operator: 'airtel',
      },
    });
  });

  it('carries the geofence-only trip only as a flag', () => {
    const row = locationRowSchema.parse(statusRow);
    const point = toNormalizedPoint(
      row,
      1,
      'T1',
      { tenantId: 't', vehicleId: 'v', tripId: null, geofenceTripId: 'trip' },
      '2023-11-28T09:00:00.000Z',
      null,
    );
    expect(point.tripId).toBeNull();
    expect(point.flags).toMatchObject({ geofenceTripId: 'trip' });
  });

  it('rejects malformed rows and 0,0 positions', () => {
    expect(locationRowSchema.safeParse({ ...statusRow, loc: [1] }).success).toBe(false);
    expect(hasPosition(locationRowSchema.parse({ ...statusRow, loc: [0, 0] }))).toBe(false);
    expect(locationTimeMs(locationRowSchema.parse({ ...statusRow, createdAt: 'nope' }))).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('reduces Indian numbers to 10 digits', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalizePhone('09876543210')).toBe('9876543210');
    expect(normalizePhone('9876543210')).toBe('9876543210');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('IntugineClient', () => {
  afterEach(() => vi.restoreAllMocks());

  const client = () =>
    new IntugineClient({
      url: 'https://sct.test/api/prod',
      username: 'u',
      password: 'p',
      timeoutMs: 1000,
      slowTimeoutMs: 2000,
    });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('logs in with Basic auth once, then sends the bearer token', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 86_400);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { token }))
      .mockImplementation(async () =>
        json(200, consentRow({ consent: 'PENDING', operator: 'airtel' })),
      );
    const c = client();
    expect((await c.checkConsent('9876543210')).status).toBe('pending');
    await c.checkConsent('9876543210');

    expect(fetch).toHaveBeenCalledTimes(3); // login + 2 consent calls
    const [loginUrl, loginInit] = fetch.mock.calls[0];
    expect(loginUrl).toBe('https://sct.test/api/prod/login');
    expect(loginInit?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe('https://sct.test/api/prod/consents?tel=9876543210');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  });

  it('logs in again once on a 401', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 86_400);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { token }))
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { token }))
      .mockResolvedValueOnce(json(200, [statusRow]));
    expect(await client().fetchLocations('T1', 5)).toEqual([statusRow]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('starts a trip with our load id and reads the trip id and consent', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 86_400);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { token }))
      .mockResolvedValueOnce(
        json(200, {
          msg: 'Trip started',
          tripId: '5c94c6f5f8f3812f67ba42dd',
          consentResults: [{ number: '9876543210', operator: 'airtel', consent: 'ALLOWED' }],
        }),
      );
    const result = await client().startTrip({
      tel: '9876543210',
      src: [18.78, 74.27],
      srcName: 'Plant',
      dest: [16.81, 81.53],
      destName: 'Depot',
      truckNumber: 'MH42BF0711',
      invoice: 'LD-1',
      loadId: 'load-uuid',
    });
    expect(result).toEqual({
      intugineTripId: '5c94c6f5f8f3812f67ba42dd',
      consent: { status: 'allowed', operator: 'airtel', suggestion: null },
    });
    const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(body).toMatchObject({
      tel: '9876543210',
      src: ['18.78', '74.27'],
      truck_number: 'MH42BF0711',
      invoice: 'LD-1',
      custom_load_id: 'load-uuid',
    });
  });

  it('reads the end-trip message and surfaces HTTP failures', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 86_400);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { token }))
      .mockResolvedValueOnce(json(200, { msg: 'Trip Completed', tripId: 'T1' }))
      .mockResolvedValueOnce(json(200, { msg: 'Trip has already ended', tripId: 'T1' }))
      .mockResolvedValueOnce(json(429, {}));
    const c = client();
    expect(await c.endTrip('T1')).toBe(true);
    expect(await c.endTrip('T1')).toBe(false);
    await expect(c.fetchLocations('T1', 1)).rejects.toMatchObject({
      rateLimited: true,
      status: 429,
    });
  });

  it('rejects a status body that is not a list', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 86_400);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { token }))
      .mockResolvedValueOnce(json(200, { errorCode: 403 }));
    await expect(client().fetchLocations('T1', 1)).rejects.toBeInstanceOf(IntugineError);
  });
});

describe('jwtExpiryMs', () => {
  it('reads exp, and returns null for junk', () => {
    expect(jwtExpiryMs(jwt(1701237265))).toBe(1701237265000);
    expect(jwtExpiryMs('not-a-jwt')).toBeNull();
  });
});

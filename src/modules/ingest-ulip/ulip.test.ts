import { afterEach, describe, expect, it, vi } from 'vitest';
import { UlipClient, UlipError } from './ulip.client';
import { extractTransactions, parseGeocode, readerTimeMs, toCrossing } from './ulip.contract';

// Shape copied from a live ULIP FASTAG/01 answer.
const txn = (over: Record<string, unknown> = {}) => ({
  readerReadTime: '2026-10-28 18:30:20.000',
  seqNo: '0010002610281831136871',
  laneDirection: 'S',
  tollPlazaGeocode: '29.071744,77.0601904',
  tollPlazaName: 'Bhagan Toll Plaza',
  vehicleType: 'VC5',
  vehicleRegNo: 'HR84A4138',
  ...over,
});
const answer = (txns: unknown, result = 'SUCCESS') => ({
  response: [
    {
      response: {
        result,
        respCode: result === 'SUCCESS' ? '000' : '999',
        ts: '2026-10-30T12:55:24',
        vehicle: { errCode: '000', vehltxnList: { totalMsg: '1', txn: txns } },
      },
      responseStatus: result,
      message: null,
    },
  ],
  error: 'false',
  code: '200',
  message: 'Success',
});

describe('extractTransactions', () => {
  it('returns the transactions of a SUCCESS answer', () => {
    expect(extractTransactions(answer([txn(), txn({ seqNo: '2' })]))).toEqual({
      ok: true,
      txns: [txn(), txn({ seqNo: '2' })],
    });
  });

  it('accepts a single transaction sent as an object, and none at all', () => {
    expect(extractTransactions(answer(txn()))).toEqual({ ok: true, txns: [txn()] });
    expect(extractTransactions(answer(undefined))).toEqual({ ok: true, txns: [] });
  });

  it('reports anything that is not SUCCESS, or not recognisable', () => {
    expect(extractTransactions(answer([], 'FAILURE'))).toMatchObject({
      ok: false,
      respCode: '999',
    });
    expect(extractTransactions({ nope: true })).toMatchObject({ ok: false });
    expect(extractTransactions({ response: [] })).toMatchObject({ ok: false });
  });
});

describe('readerTimeMs', () => {
  it('reads ULIP’s zone-less timestamp as India time', () => {
    expect(readerTimeMs('2026-10-28 18:30:20.000')).toBe(Date.parse('2026-10-28T13:00:20.000Z'));
    expect(readerTimeMs('2026-10-28 18:30:20')).toBe(Date.parse('2026-10-28T13:00:20Z'));
  });
  it('rejects anything else', () => {
    expect(readerTimeMs('yesterday')).toBeNull();
    expect(readerTimeMs('2026-13-45 99:99:99')).toBeNull();
    expect(readerTimeMs('')).toBeNull();
  });
});

describe('parseGeocode', () => {
  it('parses both precisions seen in ULIP', () => {
    expect(parseGeocode('29.071744,77.0601904')).toEqual({ lat: 29.071744, lng: 77.0601904 });
    expect(parseGeocode('27.79189039140145,78.2865520412782')).toEqual({
      lat: 27.79189039140145,
      lng: 78.2865520412782,
    });
  });
  it('returns null for missing, malformed, out-of-range or 0,0', () => {
    for (const bad of [undefined, null, '', '12', 'a,b', '1,2,3', ',5', '95,10', '10,200', '0,0']) {
      expect(parseGeocode(bad)).toBeNull();
    }
  });
});

describe('toCrossing', () => {
  it('maps a transaction', () => {
    expect(toCrossing(txn())).toMatchObject({
      seqNo: '0010002610281831136871',
      crossedAtMs: Date.parse('2026-10-28T13:00:20Z'),
      tollPlazaName: 'Bhagan Toll Plaza',
      lat: 29.071744,
      lng: 77.0601904,
      laneDirection: 'S',
      vehicleType: 'VC5',
    });
  });
  it('keeps a crossing whose location is unusable, and names a plaza without a name', () => {
    expect(toCrossing(txn({ tollPlazaGeocode: 'x', tollPlazaName: ' ' }))).toMatchObject({
      lat: null,
      lng: null,
      tollPlazaName: 'Unknown toll plaza',
    });
  });
  it('turns a numeric seqNo into text, and drops rows without an id or time', () => {
    expect(toCrossing(txn({ seqNo: 2700000004309146 }))?.seqNo).toBe('2700000004309146');
    expect(toCrossing(txn({ seqNo: '' }))).toBeNull();
    expect(toCrossing(txn({ readerReadTime: 'bad' }))).toBeNull();
    expect(toCrossing('junk')).toBeNull();
  });
});

describe('UlipClient', () => {
  afterEach(() => vi.unstubAllGlobals());
  const options = {
    url: 'https://ulip.test/v1/',
    username: 'u',
    password: 'p',
    timeoutMs: 1000,
    tokenTtlMs: 60_000,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const login = (token = 'TOK') => json({ response: { id: token }, code: '200' });

  it('logs in once, reuses the token and sends the plate', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(login())
      .mockImplementation(async () => json(answer([txn()])));
    vi.stubGlobal('fetch', fetchMock);
    const client = new UlipClient(options);

    expect(await client.fetchCrossings('HR84A4138')).toHaveLength(1);
    await client.fetchCrossings('HR84A4138');

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 login + 2 calls
    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toBe('https://ulip.test/v1/user/login');
    expect(JSON.parse(loginInit.body)).toEqual({ username: 'u', password: 'p' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://ulip.test/v1/FASTAG/01');
    expect(init.headers.Authorization).toBe('Bearer TOK');
    expect(JSON.parse(init.body)).toEqual({ vehiclenumber: 'HR84A4138' });
  });

  it('logs in again after a 401, once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(login('OLD'))
      .mockResolvedValueOnce(json({ message: 'expired' }, 401))
      .mockResolvedValueOnce(login('NEW'))
      .mockResolvedValueOnce(json(answer([])));
    vi.stubGlobal('fetch', fetchMock);

    expect(await new UlipClient(options).fetchCrossings('X')).toEqual([]);
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer NEW');
  });

  it('shares one login between concurrent calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(login())
      .mockImplementation(async () => json(answer([])));
    vi.stubGlobal('fetch', fetchMock);
    const client = new UlipClient(options);
    await Promise.all([client.fetchCrossings('A'), client.fetchCrossings('B')]);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/user/login')),
    ).toHaveLength(1);
  });

  it('throws UlipError for an HTTP failure, a bad login and a non-SUCCESS answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(login()).mockResolvedValueOnce(json({}, 429)),
    );
    await expect(new UlipClient(options).fetchCrossings('X')).rejects.toMatchObject({
      status: 429,
      rateLimited: true,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ response: {} })));
    await expect(new UlipClient(options).fetchCrossings('X')).rejects.toThrow('no token');

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(login())
        .mockResolvedValueOnce(json(answer([], 'FAILURE'))),
    );
    await expect(new UlipClient(options).fetchCrossings('X')).rejects.toBeInstanceOf(UlipError);
  });
});

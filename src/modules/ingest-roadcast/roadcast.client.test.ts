import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoadcastClient, RoadcastError } from './roadcast.client';

const client = new RoadcastClient({
  url: 'https://roadcast.test/pull',
  apiKey: 'k',
  timeoutMs: 1000,
});

function respond(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('RoadcastClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the IMEIs as a list with the API key, and returns the rows', async () => {
    const fetch = respond(200, { data: { PositionsPull: { rows: [{ deviceImei: '1' }] } } });
    expect(await client.pullPositions(['866221070401935', '866221070405217'])).toEqual([
      { deviceImei: '1' },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://roadcast.test/pull');
    expect(init?.headers).toMatchObject({ 'X-API-KEY': 'k' });
    expect(JSON.parse(String(init?.body))).toEqual({
      input: { deviceImeis: ['866221070401935', '866221070405217'] },
    });
  });

  it('flags a 429 as rate limited and rejects an unexpected body', async () => {
    respond(429, {});
    await expect(client.pullPositions(['1'])).rejects.toMatchObject({ rateLimited: true });
    respond(200, { errors: ['nope'] });
    await expect(client.pullPositions(['1'])).rejects.toBeInstanceOf(RoadcastError);
  });

  it('makes no call without IMEIs', async () => {
    const fetch = respond(200, {});
    expect(await client.pullPositions([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

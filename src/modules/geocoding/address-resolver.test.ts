import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { AddressResolver, type ReverseGeocoder } from './address-resolver';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    mget: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
    set: async (k: string, v: string) => void store.set(k, v),
  } as unknown as Redis;
}

describe('AddressResolver', () => {
  it('returns nulls when there is no geocoder', async () => {
    const resolver = new AddressResolver(fakeRedis(), null);
    expect(await resolver.resolve([{ lat: 1, lng: 2 }, null])).toEqual([null, null]);
  });

  it('looks each ~110 m cell up once and serves the rest from cache', async () => {
    const reverse = vi.fn(async () => 'Jind, Haryana');
    const geocoder: ReverseGeocoder = { name: 'fake', reverse };
    const resolver = new AddressResolver(fakeRedis(), geocoder);
    const points = [
      { lat: 29.31501, lng: 76.31501 },
      { lat: 29.31504, lng: 76.31498 },
      null,
    ];
    expect(await resolver.resolve(points)).toEqual(['Jind, Haryana', 'Jind, Haryana', null]);
    expect(await resolver.resolve(points)).toEqual(['Jind, Haryana', 'Jind, Haryana', null]);
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it('a failing lookup yields null, not an error', async () => {
    const geocoder: ReverseGeocoder = {
      name: 'fake',
      reverse: async () => {
        throw new Error('boom');
      },
    };
    const resolver = new AddressResolver(fakeRedis(), geocoder);
    expect(await resolver.resolve([{ lat: 1, lng: 2 }])).toEqual([null]);
  });
});

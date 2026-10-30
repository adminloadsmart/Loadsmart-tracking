import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { AddressResolver, GoogleReverseGeocoder, ReverseGeocoder } from './address-resolver';

export function createAddressResolver(deps: {
  redis: Redis;
  logger?: Logger;
  /** Without a key, no address is resolved (responses carry address: null). */
  googleMapsApiKey?: string;
  /** Override for tests (no network). */
  geocoder?: ReverseGeocoder | null;
}): AddressResolver {
  const geocoder =
    deps.geocoder !== undefined
      ? deps.geocoder
      : deps.googleMapsApiKey
        ? new GoogleReverseGeocoder(deps.googleMapsApiKey)
        : null;
  return new AddressResolver(deps.redis, geocoder, deps.logger);
}

export { AddressResolver, GoogleReverseGeocoder } from './address-resolver';
export type { ReverseGeocoder } from './address-resolver';

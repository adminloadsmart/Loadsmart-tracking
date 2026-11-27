import type Redis from 'ioredis';
import type { Logger } from 'pino';
import {
  AddressResolver,
  AddressResolverOptions,
  GoogleReverseGeocoder,
  ReverseGeocoder,
} from './address-resolver';

export function createAddressResolver(deps: {
  redis: Redis;
  logger?: Logger;
  /** Without a key, no address is resolved (responses carry address: null). */
  googleMapsApiKey?: string;
  /** Override for tests (no network). */
  geocoder?: ReverseGeocoder | null;
  /** Per-request and per-minute lookup caps (defaults in AddressResolver). */
  limits?: AddressResolverOptions;
}): AddressResolver {
  const geocoder =
    deps.geocoder !== undefined
      ? deps.geocoder
      : deps.googleMapsApiKey
        ? new GoogleReverseGeocoder(deps.googleMapsApiKey)
        : null;
  return new AddressResolver(deps.redis, geocoder, deps.logger, deps.limits);
}

/** The resolver caps from the GEOCODE_* settings. */
export function geocodeLimitsFromEnv(config: {
  geocodeMaxLookupsPerRequest: number;
  geocodeMaxLookupsPerMinute: number;
}): AddressResolverOptions {
  return {
    maxLookupsPerRequest: config.geocodeMaxLookupsPerRequest,
    maxLookupsPerMinute: config.geocodeMaxLookupsPerMinute,
  };
}

export { AddressResolver, GoogleReverseGeocoder } from './address-resolver';
export type { AddressResolverOptions, ReverseGeocoder } from './address-resolver';

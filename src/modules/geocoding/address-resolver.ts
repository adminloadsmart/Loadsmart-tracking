import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { LatLng } from '../processing/geo';

/** Turns coordinates into a human-readable address (Google Geocoding API in production). */
export interface ReverseGeocoder {
  readonly name: string;
  reverse(point: LatLng): Promise<string | null>;
}

const TIMEOUT_MS = 3_000;
const MAX_PARALLEL = 8;
// 3 decimals ≈ 110 m: a parked or slow truck, or an alert's anchor, resolves to one cached address.
const KEY_DECIMALS = 3;
const FOUND_TTL_S = 30 * 24 * 3600;
const MISSING_TTL_S = 3600;

/** Google Geocoding API, reverse lookup (same key as route planning). */
export class GoogleReverseGeocoder implements ReverseGeocoder {
  readonly name = 'google-geocoding';

  constructor(private readonly apiKey: string) {}

  async reverse(point: LatLng): Promise<string | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${point.lat},${point.lng}`);
    url.searchParams.set('language', 'en');
    url.searchParams.set('region', 'in');
    url.searchParams.set('key', this.apiKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Geocoding API ${response.status}`);
    const body = (await response.json()) as {
      status: string;
      results?: Array<{ formatted_address?: string }>;
    };
    if (body.status === 'ZERO_RESULTS') return null;
    if (body.status !== 'OK') throw new Error(`Geocoding API status ${body.status}`);
    return body.results?.[0]?.formatted_address ?? null;
  }
}

/**
 * Addresses for positions and alerts, cached in Redis by rounded coordinates so the Google API
 * is hit once per ~110 m cell. A lookup that fails (or no key) yields null — the response simply
 * has no address; it never fails a request.
 */
export class AddressResolver {
  constructor(
    private readonly redis: Redis,
    private readonly geocoder: ReverseGeocoder | null,
    private readonly logger?: Logger,
  ) {}

  /** Addresses in the same order as `points`; null where unknown. */
  async resolve(points: Array<LatLng | null>): Promise<Array<string | null>> {
    if (!this.geocoder) return points.map(() => null);
    const keys = points.map((p) => (p ? cacheKey(p) : null));
    const unique = [...new Set(keys.filter((k): k is string => k !== null))];
    const found = new Map<string, string | null>();
    try {
      const cached = unique.length ? await this.redis.mget(unique) : [];
      const missing: string[] = [];
      unique.forEach((key, i) => {
        const hit = cached[i];
        if (hit === null || hit === undefined) missing.push(key);
        else found.set(key, hit === '' ? null : hit);
      });
      const source = new Map(
        points.flatMap((p, i) => (p && keys[i] ? [[keys[i] as string, p] as const] : [])),
      );
      for (let i = 0; i < missing.length; i += MAX_PARALLEL) {
        await Promise.all(
          missing.slice(i, i + MAX_PARALLEL).map(async (key) => {
            found.set(key, await this.lookup(key, source.get(key) as LatLng));
          }),
        );
      }
    } catch (err) {
      this.logger?.warn({ err }, 'Address resolution failed');
    }
    return keys.map((k) => (k ? (found.get(k) ?? null) : null));
  }

  private async lookup(key: string, point: LatLng): Promise<string | null> {
    try {
      const address = await (this.geocoder as ReverseGeocoder).reverse(point);
      await this.redis.set(key, address ?? '', 'EX', address ? FOUND_TTL_S : MISSING_TTL_S);
      return address;
    } catch (err) {
      this.logger?.warn({ err }, 'Reverse geocoding failed');
      return null; // not cached: retried on the next request
    }
  }
}

function cacheKey(point: LatLng): string {
  return `trk:addr:${point.lat.toFixed(KEY_DECIMALS)}:${point.lng.toFixed(KEY_DECIMALS)}`;
}

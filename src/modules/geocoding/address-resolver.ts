import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { LatLng } from '../processing/geo';

/** Turns coordinates into a human-readable address (Google Geocoding API in production). */
export interface ReverseGeocoder {
  readonly name: string;
  reverse(point: LatLng): Promise<string | null>;
}

const TIMEOUT_MS = 3_000;
/** Google calls in flight at once, for the whole process. */
const MAX_PARALLEL = 8;
// 3 decimals ≈ 110 m: a parked or slow truck, or an alert's anchor, resolves to one cached address.
const KEY_DECIMALS = 3;
const FOUND_TTL_S = 30 * 24 * 3600;
const MISSING_TTL_S = 3600;

// A Google plus code ("XR3H+5WQ", or a short "5WQ+X2") and the comma after it.
const PLUS_CODE_RE =
  /(^|[\s,])[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}(?=[\s,]|$)\s*,?/gi;

/** Google's placeholder for a road with no name ("Unnamed Road, Madhya Pradesh 452016"). */
const UNNAMED_ROAD_RE = /(^|,)\s*unnamed road\s*(?=,|$),?/gi;

/**
 * Drops the parts that say nothing: the plus code and "Unnamed Road".
 * "XR3H+5WQ, Bhattian, Ludhiana, Punjab 141008, India" → "Bhattian, Ludhiana, Punjab 141008, India".
 */
export function stripPlusCode(address: string): string | null {
  const cleaned = address
    .replace(PLUS_CODE_RE, '$1')
    .replace(UNNAMED_ROAD_RE, '$1')
    .replace(/^[\s,]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || null;
}

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
      results?: Array<{ formatted_address?: string; types?: string[] }>;
    };
    if (body.status === 'ZERO_RESULTS') return null;
    if (body.status !== 'OK') throw new Error(`Geocoding API status ${body.status}`);
    // Google's first result is often just the plus code ("XR3H+5WQ, Ludhiana, …"): prefer a street
    // address, then strip any plus code still left in it.
    const results = body.results ?? [];
    // Prefer a result that names a place: not a bare plus code, not an "Unnamed Road".
    const named = results.filter((r) => !r.types?.includes('plus_code'));
    const best =
      named.find((r) => !/^\s*unnamed road\b/i.test(r.formatted_address ?? '')) ??
      named[0] ??
      results[0];
    return best?.formatted_address ? stripPlusCode(best.formatted_address) : null;
  }
}

export interface AddressResolverOptions {
  /** Google lookups one request may start; the rest of its misses are warmed in the background. */
  maxLookupsPerRequest?: number;
  /** How long a request waits for its lookups; later answers are still cached for the next one. */
  requestBudgetMs?: number;
  /** Google lookups per minute for this process (requests + warming); 0 = no limit. */
  maxLookupsPerMinute?: number;
  /** Misses queued for background warming; beyond it they wait for a later request. */
  warmQueueMax?: number;
}

const DEFAULTS: Required<AddressResolverOptions> = {
  maxLookupsPerRequest: 25,
  requestBudgetMs: 2_000,
  maxLookupsPerMinute: 300,
  warmQueueMax: 1_000,
};

/**
 * Addresses for positions and alerts, cached in Redis by rounded coordinates so the Google API
 * is hit once per ~110 m cell. A lookup that fails (or no key) yields null — the response simply
 * has no address; it never fails a request.
 *
 * Bounded for big lists (My Fleet asks for up to 5000 positions): a request starts at most
 * `maxLookupsPerRequest` lookups and waits at most `requestBudgetMs`; its other misses are warmed
 * in the background, so the next load has them. Lookups are shared — a cell already being looked
 * up (another viewer, the warmer) is waited on, not asked again — and capped process-wide, both in
 * parallel calls and per minute, so a cold cache never turns into a burst of Google calls.
 */
export class AddressResolver {
  private readonly options: Required<AddressResolverOptions>;
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly warmQueue = new Map<string, LatLng>();
  private warming = false;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private windowStartMs = 0;
  private windowCount = 0;

  constructor(
    private readonly redis: Redis,
    private readonly geocoder: ReverseGeocoder | null,
    private readonly logger?: Logger,
    options: AddressResolverOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Addresses in the same order as `points`; null where unknown (or not resolved in time). */
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
      const now = missing.slice(0, this.options.maxLookupsPerRequest);
      for (const key of missing.slice(this.options.maxLookupsPerRequest)) {
        this.warm(key, source.get(key) as LatLng);
      }
      const lookups = Promise.all(
        now.map(async (key) => {
          found.set(key, await this.lookupShared(key, source.get(key) as LatLng));
        }),
      );
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        lookups,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, this.options.requestBudgetMs))),
      ]);
      clearTimeout(timer);
    } catch (err) {
      this.logger?.warn({ err }, 'Address resolution failed');
    }
    // Cleaned here too, so addresses cached before plus codes were stripped come out clean.
    return keys.map((k) => {
      const address = k ? found.get(k) : null;
      return address ? stripPlusCode(address) : null;
    });
  }

  /** One lookup per cell at a time, whoever asks. */
  private lookupShared(key: string, point: LatLng): Promise<string | null> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const lookup = this.lookup(key, point).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }

  private warm(key: string, point: LatLng): void {
    if (this.inFlight.has(key) || this.warmQueue.has(key)) return;
    if (this.warmQueue.size >= this.options.warmQueueMax) return;
    this.warmQueue.set(key, point);
    if (!this.warming) void this.drainWarmQueue();
  }

  private async drainWarmQueue(): Promise<void> {
    this.warming = true;
    try {
      while (this.warmQueue.size > 0) {
        const [key, point] = this.warmQueue.entries().next().value as [string, LatLng];
        this.warmQueue.delete(key);
        // A request may have cached it meanwhile.
        if ((await this.redis.exists(key)) > 0) continue;
        // Over this minute's budget: wait for the next one instead of dropping the queue.
        const waitMs = this.msUntilRateSlot();
        if (waitMs > 0) await sleepUnref(waitMs);
        await this.lookupShared(key, point);
      }
    } catch (err) {
      this.logger?.warn({ err }, 'Address warming failed');
    } finally {
      this.warming = false;
    }
  }

  private async lookup(key: string, point: LatLng): Promise<string | null> {
    await this.acquire();
    try {
      if (!this.takeRateSlot()) return null; // over this minute's budget: retried later
      const address = await (this.geocoder as ReverseGeocoder).reverse(point);
      await this.redis.set(key, address ?? '', 'EX', address ? FOUND_TTL_S : MISSING_TTL_S);
      return address;
    } catch (err) {
      this.logger?.warn({ err }, 'Reverse geocoding failed');
      return null; // not cached: retried on the next request
    } finally {
      this.release();
    }
  }

  private msUntilRateSlot(): number {
    const limit = this.options.maxLookupsPerMinute;
    if (limit <= 0 || this.windowCount < limit) return 0;
    return Math.max(0, this.windowStartMs + 60_000 - Date.now());
  }

  private takeRateSlot(): boolean {
    const limit = this.options.maxLookupsPerMinute;
    if (limit <= 0) return true;
    const now = Date.now();
    if (now - this.windowStartMs >= 60_000) {
      this.windowStartMs = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= limit) return false;
    this.windowCount += 1;
    return true;
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_PARALLEL) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next)
      next(); // the slot passes straight to the next waiter
    else this.active -= 1;
  }
}

/** A wait that never keeps the process alive (warming is best effort). */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function cacheKey(point: LatLng): string {
  return `trk:addr:${point.lat.toFixed(KEY_DECIMALS)}:${point.lng.toFixed(KEY_DECIMALS)}`;
}

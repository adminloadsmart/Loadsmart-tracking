import type { LatLng } from '../processing/geo';

export interface ComputedRoute {
  polyline: string;
  distanceM: number;
  durationS: number | null;
}

/** Plans road routes (Google Routes API in production; a fixture in tests). */
export interface RouteProvider {
  readonly name: string;
  computeRoute(origin: LatLng, destination: LatLng): Promise<ComputedRoute | null>;
}

/** Turns an address into coordinates (Google Geocoding API in production). */
export interface Geocoder {
  readonly name: string;
  geocode(address: string): Promise<LatLng | null>;
}

const TIMEOUT_MS = 10_000;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Google Routes API v2 `computeRoutes` — truck-relevant settings: DRIVE, traffic-unaware (the
 * route is planned once per trip; live traffic would make it arbitrary), India region. Only the
 * fields we store are requested (field mask), which also keeps the SKU on the cheapest tier.
 */
export class GoogleRoutesProvider implements RouteProvider {
  readonly name = 'google-routes';

  constructor(private readonly apiKey: string) {}

  async computeRoute(origin: LatLng, destination: LatLng): Promise<ComputedRoute | null> {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: {
          location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
        },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        regionCode: 'IN',
        units: 'METRIC',
      }),
    });
    if (!response.ok) {
      throw new ProviderError(
        `Routes API ${response.status}: ${(await response.text()).slice(0, 300)}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const body = (await response.json()) as {
      routes?: Array<{
        distanceMeters?: number;
        duration?: string;
        polyline?: { encodedPolyline?: string };
      }>;
    };
    const route = body.routes?.[0];
    if (!route?.polyline?.encodedPolyline || !route.distanceMeters) return null;
    return {
      polyline: route.polyline.encodedPolyline,
      distanceM: route.distanceMeters,
      durationS: route.duration ? Number.parseFloat(route.duration) : null,
    };
  }
}

/** Google Geocoding API, biased to India. */
export class GoogleGeocoder implements Geocoder {
  readonly name = 'google-geocoding';

  constructor(private readonly apiKey: string) {}

  async geocode(address: string): Promise<LatLng | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('region', 'in');
    url.searchParams.set('key', this.apiKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      throw new ProviderError(
        `Geocoding API ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    const body = (await response.json()) as {
      status: string;
      results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
    };
    if (body.status === 'ZERO_RESULTS') return null;
    if (body.status !== 'OK') {
      throw new ProviderError(
        `Geocoding API status ${body.status}`,
        body.status === 'OVER_QUERY_LIMIT',
      );
    }
    const location = body.results?.[0]?.geometry?.location;
    return location ? { lat: location.lat, lng: location.lng } : null;
  }
}

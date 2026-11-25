import type { Logger } from 'pino';
import { Geocoder, ProviderError, RouteProvider } from './google.client';
import { haversineMeters } from '../processing/geo';
import { RoutesRepository, TripNeedingApproach, TripNeedingRoute } from './routes.repository';

const BATCH = 20;
/** A first point this close to the loading point has no approach leg worth drawing. */
const APPROACH_MIN_M = 1_000;

/**
 * Plans each active trip's road route ONCE (Google Routes API), from the loading point to the
 * delivery point — load trips and trips created from the tracking screen alike — geocoding a
 * point first when it has no coordinates (cached on a master place, so each address is geocoded
 * once). Runs on the scheduler leader;
 * failures back off exponentially (5 min … 6 h) and the trip's route_status says why
 * (no_api_key, no_origin, no_destination, not_found, error).
 */
export class RoutePlanner {
  constructor(
    private readonly repository: RoutesRepository,
    private readonly provider: RouteProvider | null,
    private readonly geocoder: Geocoder | null,
    private readonly logger: Logger,
  ) {}

  async planPending(): Promise<number> {
    const trips = await this.repository.tripsNeedingRoute(BATCH);
    let planned = 0;
    for (const trip of trips) {
      try {
        if (await this.plan(trip)) planned += 1;
      } catch (err) {
        const retryable = !(err instanceof ProviderError) || err.retryable;
        this.logger.warn({ err, tripId: trip.id, retryable }, 'Route planning failed');
        await this.repository.setRouteStatus(trip.id, 'error', true);
      }
    }
    await this.planApproaches();
    return planned;
  }

  /**
   * The approach leg — first tracked point → loading point — planned once per trip as soon as its first
   * point arrives (not waiting for the main route), display-only. Provider failures are left to retry on the next run; "no route" or "already
   * there" is stored as an empty row so it is not asked again.
   */
  private async planApproaches(): Promise<void> {
    if (!this.provider) return;
    const trips = await this.repository.tripsNeedingApproach(BATCH);
    for (const trip of trips) {
      try {
        await this.planApproach(this.provider, trip);
      } catch (err) {
        this.logger.warn({ err, tripId: trip.id }, 'Approach route planning failed');
      }
    }
  }

  private async planApproach(provider: RouteProvider, trip: TripNeedingApproach): Promise<void> {
    const route =
      haversineMeters(trip.origin, trip.destination) < APPROACH_MIN_M
        ? null
        : await provider.computeRoute(trip.origin, trip.destination);
    await this.repository.saveApproachRoute({
      tripId: trip.id,
      origin: trip.origin,
      route,
      provider: provider.name,
    });
  }

  private async plan(trip: TripNeedingRoute): Promise<boolean> {
    if (!this.provider) {
      await this.repository.setRouteStatus(trip.id, 'no_api_key', true);
      return false;
    }
    const origin = await this.locate(
      trip.origin_lat,
      trip.origin_lng,
      trip.origin_id,
      trip.origin_address,
    );
    if (!origin) {
      await this.repository.setRouteStatus(trip.id, 'no_origin', true);
      return false;
    }
    const destination = await this.locate(
      trip.destination_lat,
      trip.destination_lng,
      trip.destination_id,
      trip.destination_address,
    );
    if (!destination) {
      await this.repository.setRouteStatus(trip.id, 'no_destination', true);
      return false;
    }

    const route = await this.provider.computeRoute(origin, destination);
    if (!route) {
      await this.repository.setRouteStatus(trip.id, 'not_found', true);
      return false;
    }
    await this.repository.insertRoute({
      tripId: trip.id,
      kind: 'planned',
      polyline: route.polyline,
      distanceM: route.distanceM,
      durationS: route.durationS,
      timeProfile: route.timeProfile ?? null,
      provider: this.provider.name,
      promisedAt: trip.promised_delivery_at,
      createdBy: null,
    });
    await this.repository.setRouteStatus(trip.id, 'ok', false);
    return true;
  }

  /**
   * A point's coordinates: as stored, else geocoded from its address. A master place's geocode
   * is cached on it (so each address is geocoded once); a typed-in address (no id) is not.
   */
  private async locate(
    lat: number | null,
    lng: number | null,
    placeId: string | null,
    address: string | null,
  ): Promise<{ lat: number; lng: number } | null> {
    if (lat !== null && lng !== null) return { lat, lng };
    if (!address || !this.geocoder) return null;
    const point = await this.geocoder.geocode(address);
    if (point && placeId) {
      await this.repository.saveGeocode(placeId, point.lat, point.lng, this.geocoder.name);
    }
    return point;
  }
}

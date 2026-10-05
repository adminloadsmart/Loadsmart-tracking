import type { Logger } from 'pino';
import { Geocoder, ProviderError, RouteProvider } from './google.client';
import { RoutesRepository, TripNeedingRoute } from './routes.repository';

const BATCH = 20;

/**
 * Plans each active trip's road route ONCE (Google Routes API), from the loading point to the
 * delivery point — geocoding the delivery point first if the main backend has no coordinates for
 * it (cached on the place, so each address is geocoded once). Runs on the scheduler leader;
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
    return planned;
  }

  private async plan(trip: TripNeedingRoute): Promise<boolean> {
    if (!this.provider) {
      await this.repository.setRouteStatus(trip.id, 'no_api_key', true);
      return false;
    }
    if (trip.origin_lat === null || trip.origin_lng === null) {
      await this.repository.setRouteStatus(trip.id, 'no_origin', true);
      return false;
    }

    let destination =
      trip.destination_lat !== null && trip.destination_lng !== null
        ? { lat: trip.destination_lat, lng: trip.destination_lng }
        : null;
    if (!destination && trip.destination_id && trip.destination_address && this.geocoder) {
      destination = await this.geocoder.geocode(trip.destination_address);
      if (destination) {
        await this.repository.saveGeocode(
          trip.destination_id,
          destination.lat,
          destination.lng,
          this.geocoder.name,
        );
      }
    }
    if (!destination) {
      await this.repository.setRouteStatus(trip.id, 'no_destination', true);
      return false;
    }

    const route = await this.provider.computeRoute(
      { lat: trip.origin_lat, lng: trip.origin_lng },
      destination,
    );
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
      provider: this.provider.name,
      promisedAt: trip.promised_delivery_at,
      createdBy: null,
    });
    await this.repository.setRouteStatus(trip.id, 'ok', false);
    return true;
  }
}

import { isAfterDelivery, isGeofenceOnly, isTrackingSource, type ActiveTripIndex } from '../trips';
import { TripRepository } from './trip.repository';

export interface ResolvedTrip {
  /** Null outside the tracked window (the drive to the plant, leaving the drop after the E-POD) —
   *  see `geofenceTripId`. */
  tripId: string | null;
  tenantId: string;
  vehicleId: string;
  /** The trip the truck is heading to the plant for, or leaving the delivery point of: only the
   *  geofence check uses it. */
  geofenceTripId?: string;
}

// Mirrors TRIP_START_GRACE in trip.repository.ts.
const START_GRACE_MS = 10 * 60_000;
// Points recorded this recently are "live": if the driver has no active trip right now, they
// have none for these points either — skip the DB fallback (a phone left on between trips would
// otherwise query Postgres every 15s).
const LIVE_WINDOW_MS = 2 * 60_000;

/**
 * Maps a driver's points to the trip (and so the vehicle and tenant) they belong to.
 * Fast path: the Redis active-trip index (no Postgres). Fallback, older points only: one query
 * per batch against the trips read model, so an offline batch flushed after the trip ended still
 * lands on the right trip. Points matching no trip of the driver's tenants resolve to null.
 */
export class TripResolver {
  constructor(
    private readonly index: ActiveTripIndex,
    private readonly repository: TripRepository,
  ) {}

  async resolve(
    driverId: string,
    tenantIds: string[],
    recordedAts: string[],
    nowMs = Date.now(),
  ): Promise<Array<ResolvedTrip | null>> {
    const active = await this.index.getTripRefForDriver(driverId);
    const result: Array<ResolvedTrip | null> = recordedAts.map(() => null);
    const fallback: number[] = [];

    // A delivered load followed to its exit from the drop only claims live points: an offline
    // batch flushed after delivery still belongs to the trip it was recorded on (DB fallback).
    const followedAfterDelivery = !!active && isAfterDelivery(active.loadStatus);

    recordedAts.forEach((recordedAt, i) => {
      const recordedAtMs = Date.parse(recordedAt);
      const isLive = nowMs - recordedAtMs <= LIVE_WINDOW_MS;
      if (
        active &&
        active.vehicleId &&
        tenantIds.includes(active.tenantId) &&
        isTrackingSource(active.trackingSource, 'driver_app') &&
        (active.startedAtMs === null || recordedAtMs >= active.startedAtMs - START_GRACE_MS) &&
        (!followedAfterDelivery || isLive)
      ) {
        result[i] = isGeofenceOnly(active.loadStatus)
          ? {
              tripId: null,
              tenantId: active.tenantId,
              vehicleId: active.vehicleId,
              geofenceTripId: active.tripId,
            }
          : { tripId: active.tripId, tenantId: active.tenantId, vehicleId: active.vehicleId };
      } else if (nowMs - recordedAtMs > LIVE_WINDOW_MS) {
        fallback.push(i);
      }
    });

    if (fallback.length > 0) {
      const found = await this.repository.findTripsForDriverAt(
        driverId,
        tenantIds,
        fallback.map((i) => recordedAts[i]),
      );
      const byTime = new Map(found.map((trip) => [trip.recordedAt, trip]));
      for (const i of fallback) {
        const trip = byTime.get(recordedAts[i]);
        if (trip?.vehicleId && isTrackingSource(trip.trackingSource, 'driver_app')) {
          // Before tracking started it is the drive to the plant — the geofence check's, not the trip's.
          result[i] = trip.approach
            ? {
                tripId: null,
                tenantId: trip.tenantId,
                vehicleId: trip.vehicleId,
                geofenceTripId: trip.tripId,
              }
            : { tripId: trip.tripId, tenantId: trip.tenantId, vehicleId: trip.vehicleId };
        }
      }
    }
    return result;
  }
}

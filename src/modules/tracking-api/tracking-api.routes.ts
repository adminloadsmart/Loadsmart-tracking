import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.middleware';
import { TrackingApiController } from './tracking-api.controller';
import {
  createTripSchema,
  endTripSchema,
  listTripsSchema,
  timelineSchema,
  tripParamsSchema,
  tripTrackSchema,
  updateTripSchema,
  vehicleParamsSchema,
} from './tracking-api.validators';

/** Mounted at /v1 behind staff auth (see app.ts). */
export function createTrackingApiRoutes(controller: TrackingApiController): Router {
  const router = Router();

  // Static path before /:vehicleId so "live" is never parsed as an id.
  router.get('/vehicles/live', controller.fleetLive);
  router.get(
    '/vehicles/:vehicleId/location',
    validate(vehicleParamsSchema),
    controller.vehicleLocation,
  );
  router.get('/vehicles/:vehicleId/timeline', validate(timelineSchema), controller.vehicleTimeline);
  router.get('/vehicles/:vehicleId/stats', validate(vehicleParamsSchema), controller.vehicleStats);

  router.get('/trips', validate(listTripsSchema), controller.listTrips);
  // The Create trip drawer — a trip tracked without a load (tracking.trips).
  router.post('/trips', validate(createTripSchema), controller.createTrip);
  // Static path before /:tripId so "summary" is never parsed as an id.
  router.get('/trips/summary', controller.tripsSummary);
  router.get('/trips/:tripId', validate(tripParamsSchema), controller.trip);
  // Edit tracking: a created trip's truck, driver, destination or LR number.
  router.patch('/trips/:tripId', validate(updateTripSchema), controller.updateTrip);
  router.get('/trips/:tripId/route', validate(tripParamsSchema), controller.tripRoute);
  router.post('/trips/:tripId/end', validate(endTripSchema), controller.endTrip);
  router.get('/trips/:tripId/fastag', validate(tripParamsSchema), controller.tripFastag);
  router.get('/trips/:tripId/track', validate(tripTrackSchema), controller.tripTrack);

  return router;
}

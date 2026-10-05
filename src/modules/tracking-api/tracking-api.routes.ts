import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.middleware';
import { TrackingApiController } from './tracking-api.controller';
import {
  listTripsSchema,
  timelineSchema,
  tripParamsSchema,
  tripTrackSchema,
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

  router.get('/trips', validate(listTripsSchema), controller.listTrips);
  router.get('/trips/:tripId', validate(tripParamsSchema), controller.trip);
  router.get('/trips/:tripId/track', validate(tripTrackSchema), controller.tripTrack);

  return router;
}

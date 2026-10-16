import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { API_VERSION_PREFIX } from '../../shared/constants/api';
import { authenticated, authErrors, errorContent, TAGS } from '../../shared/openapi/core';
import {
  listTripsSchema,
  timelineSchema,
  tripParamsSchema,
  tripTrackSchema,
  vehicleParamsSchema,
} from './tracking-api.validators';

const BASE = API_VERSION_PREFIX;

export function registerTrackingApiOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: `${BASE}/vehicles/live`,
    tags: [TAGS.VEHICLES],
    operationId: 'vehicles.live',
    ...authenticated(
      'Every vehicle in scope with its latest position, for the fleet map (up to 5,000).',
    ),
    responses: {
      200: {
        description:
          '{ vehicles: [{ vehicleId, registrationNumber, kind, gpsProvider, gpsEnabled, activeTripId, position | null }], truncated }',
      },
      ...authErrors,
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/vehicles/{vehicleId}/location`,
    tags: [TAGS.VEHICLES],
    operationId: 'vehicles.location',
    ...authenticated('One vehicle’s live item — the same shape as an entry of /vehicles/live.'),
    request: { params: vehicleParamsSchema.shape.params },
    responses: {
      200: { description: 'Vehicle item with position | null' },
      400: { description: 'Validation failed', ...errorContent },
      ...authErrors,
      404: { description: 'Vehicle not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/vehicles/{vehicleId}/timeline`,
    tags: [TAGS.VEHICLES],
    operationId: 'vehicles.timeline',
    ...authenticated(
      'Where the vehicle went over a window (max 7 days), on a trip or not. Windows up to 24 h within the last 6 days use raw points; longer or older ones use one-minute summaries.',
    ),
    request: {
      params: timelineSchema.shape.params,
      query: timelineSchema.shape.query,
    },
    responses: {
      200: {
        description:
          'Encoded polyline { encoding, polyline, pointCount, firstAt, lastAt, resolution } plus granularity: raw | 1min',
      },
      400: {
        description: 'Validation failed, `to` <= `from`, or window > 7 days',
        ...errorContent,
      },
      ...authErrors,
      404: { description: 'Vehicle not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/trips`,
    tags: [TAGS.TRIPS],
    operationId: 'trips.list',
    ...authenticated('Trips in scope by tracking state, newest first.'),
    request: { query: listTripsSchema.shape.query },
    responses: {
      200: { description: '{ trips: [trip summary + position] }' },
      400: { description: 'Validation failed', ...errorContent },
      ...authErrors,
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/trips/{tripId}`,
    tags: [TAGS.TRIPS],
    operationId: 'trips.get',
    ...authenticated('One trip summary.'),
    request: { params: tripParamsSchema.shape.params },
    responses: {
      200: {
        description:
          'tripId, loadCode, loadStatus, sourceType, trackingState, trackingStartedAt, trackingEndedAt, vehicleId, vehicleNumber, driverId, driverName, origin, destination, milestones, distanceKm, distanceKmBySource, fraudFlags, position',
      },
      400: { description: 'Validation failed', ...errorContent },
      ...authErrors,
      404: { description: 'Trip not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/trips/{tripId}/track`,
    tags: [TAGS.TRIPS],
    operationId: 'trips.track',
    ...authenticated(
      'The trip’s path. Default is a server-simplified Google encoded polyline (precision 5); `format=points` (requires `resolution=full`) returns time-ordered points for playback, up to 20,000.',
    ),
    request: {
      params: tripTrackSchema.shape.params,
      query: tripTrackSchema.shape.query,
    },
    responses: {
      200: {
        description:
          'Polyline { encoding, polyline, pointCount, firstAt, lastAt, resolution } or { points: [{ t, lat, lng, speedKmh, heading, source, motion }], truncated }',
      },
      400: {
        description: 'Validation failed, or format=points without resolution=full',
        ...errorContent,
      },
      ...authErrors,
      404: { description: 'Trip not found or outside scope', ...errorContent },
    },
  });
}

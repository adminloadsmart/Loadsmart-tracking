import { z } from 'zod';
import { POINT_SOURCES } from '../points';
import { TRACK_RESOLUTIONS } from './tracking-api.service';

export const vehicleParamsSchema = z.object({ params: z.object({ vehicleId: z.uuid() }) });
export const tripParamsSchema = z.object({ params: z.object({ tripId: z.uuid() }) });

export const timelineSchema = z.object({
  params: z.object({ vehicleId: z.uuid() }),
  query: z.object({
    from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    resolution: z.enum(TRACK_RESOLUTIONS).default('medium'),
  }),
});

export const tripTrackSchema = z.object({
  params: z.object({ tripId: z.uuid() }),
  query: z.object({
    resolution: z.enum(TRACK_RESOLUTIONS).default('medium'),
    format: z.enum(['polyline', 'points']).default('polyline'),
    source: z.enum(POINT_SOURCES).optional(),
  }),
});

export const listTripsSchema = z.object({
  query: z.object({
    state: z.enum(['pending', 'active', 'ended']).default('active'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
});

export type TimelineQuery = z.infer<typeof timelineSchema>['query'];
export type TripTrackQuery = z.infer<typeof tripTrackSchema>['query'];
export type ListTripsQuery = z.infer<typeof listTripsSchema>['query'];
